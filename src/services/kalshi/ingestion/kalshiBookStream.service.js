import 'server-only';
import WebSocket from 'ws';
import { createKalshiBenchmarkStreamHeaders, hasKalshiCredentials } from '../kalshi.auth';
import { assertKalshiTicker } from '../kalshi.validation';

const endpoint = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const handshakeTimeoutMs = 10_000;
const keepAliveTimeoutMs = 30_000;
const maximumPayloadBytes = 2_000_000;

/** Authenticated market data only. No order commands or REST-to-WS snapshot merging. */
export const createKalshiBookStream = ({
  tickers,
  onCapture = () => {},
  WebSocketImpl = WebSocket,
  now = Date.now,
  timers = globalThis,
  getEnvironment = () => process.env,
} = {}) => {
  if (
    !Array.isArray(tickers) ||
    tickers.length === 0 ||
    tickers.length > 100 ||
    new Set(tickers).size !== tickers.length
  )
    throw new Error('Choose unique Kalshi book tickers.');
  tickers.forEach(assertKalshiTicker);
  const marketTickers = [...tickers];
  let socket = null;
  let stopped = true;
  let connectionId = 0;
  let state = 'stopped';
  let reason = null;
  let subscriptionId = null;
  let connectionStartedAt = null;
  let lastTransportAt = null;
  let snapshotRequestedAt = null;
  let lastSnapshotRequestAt = null;
  let snapshotRequestQueued = false;
  let reconnectTimer = null;
  let healthTimer = null;
  let reconnectAttempt = 0;
  let commandId = 1;
  const pendingSnapshots = new Set();

  const closeSocket = () => {
    const previous = socket;
    socket = null;
    subscriptionId = null;
    pendingSnapshots.clear();
    snapshotRequestedAt = null;
    lastSnapshotRequestAt = null;
    snapshotRequestQueued = false;
    if (!previous) return;
    previous.removeAllListeners();
    previous.on('error', () => {});
    if (typeof previous.terminate === 'function') previous.terminate();
    else previous.close();
  };
  const halt = () => {
    stopped = true;
    timers.clearInterval(healthTimer);
    timers.clearTimeout(reconnectTimer);
    healthTimer = null;
    reconnectTimer = null;
    closeSocket();
  };
  const capture = (input) => {
    try {
      onCapture({ ...input, connectionId });
    } catch (error) {
      halt();
      state = 'unavailable';
      reason = 'Kalshi book recording consumer failed.';
      throw error;
    }
  };
  const transition = (nextState, nextReason = null) => {
    state = nextState;
    reason = nextReason;
    capture({ kind: 'book-connection', state, reason, receivedAt: now() });
  };
  const fail = (nextReason, nextState = 'reconnecting') => {
    if (stopped || reconnectTimer !== null) return;
    closeSocket();
    transition(nextState, nextReason);
    if (stopped) return;
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(reconnectAttempt, 4));
    reconnectAttempt += 1;
    reconnectTimer = timers.setTimeout(connect, delay);
  };
  const requestSnapshot = () => {
    if (stopped || state !== 'connected' || subscriptionId === null) return false;
    const requestedAt = now();
    if (
      pendingSnapshots.size > 0 ||
      (lastSnapshotRequestAt !== null && requestedAt - lastSnapshotRequestAt < 1000)
    ) {
      snapshotRequestQueued = true;
      return false;
    }
    snapshotRequestQueued = false;
    for (const ticker of marketTickers) pendingSnapshots.add(ticker);
    snapshotRequestedAt = requestedAt;
    lastSnapshotRequestAt = requestedAt;
    commandId += 1;
    try {
      socket.send(
        JSON.stringify({
          id: commandId,
          cmd: 'update_subscription',
          params: {
            sid: subscriptionId,
            market_tickers: marketTickers,
            action: 'get_snapshot',
          },
        }),
      );
      return true;
    } catch {
      fail('Unable to request Kalshi book replacement snapshots.');
      return false;
    }
  };
  const connect = () => {
    reconnectTimer = null;
    if (stopped) return;
    connectionId += 1;
    connectionStartedAt = now();
    lastTransportAt = null;
    commandId = 1;
    const environment = getEnvironment();
    if (!hasKalshiCredentials(environment)) {
      transition('not-configured', 'Server-side Kalshi credentials are required for order books.');
      return;
    }
    transition('connecting');
    if (stopped) return;
    let connection;
    try {
      connection = new WebSocketImpl(endpoint, {
        headers: createKalshiBenchmarkStreamHeaders(environment, connectionStartedAt),
        handshakeTimeout: handshakeTimeoutMs,
        maxPayload: maximumPayloadBytes,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch {
      fail('Unable to establish the authenticated Kalshi book connection.', 'unavailable');
      return;
    }
    socket = connection;
    connection.on('open', () => {
      if (stopped || socket !== connection) return;
      lastTransportAt = now();
      transition('connected');
      if (stopped) return;
      try {
        connection.send(
          JSON.stringify({
            id: 1,
            cmd: 'subscribe',
            params: {
              channels: ['orderbook_delta'],
              market_tickers: marketTickers,
              update_interval_ms: 0,
            },
          }),
        );
      } catch {
        fail('Unable to subscribe to Kalshi order books.');
      }
    });
    connection.on('message', (data, isBinary) => {
      if (stopped || socket !== connection) return;
      const receivedAt = now();
      const rawPayload = typeof data === 'string' ? data : data.toString('utf8');
      // Capture exact text before parsing, including malformed source frames.
      capture({ kind: 'book-frame', rawPayload, receivedAt });
      if (stopped) return;
      try {
        if (isBinary || Buffer.byteLength(rawPayload, 'utf8') > maximumPayloadBytes)
          throw new Error('Invalid frame.');
        if (lastTransportAt !== null && receivedAt < lastTransportAt)
          throw new Error('Regressed clock.');
        lastTransportAt = receivedAt;
        const frame = JSON.parse(rawPayload);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame))
          throw new Error('Invalid frame.');
        if (frame.type === 'error') {
          fail('Kalshi rejected the book subscription or snapshot request.', 'unavailable');
          return;
        }
        if (frame.type === 'subscribed') {
          if (
            frame.id !== 1 ||
            frame.msg?.channel !== 'orderbook_delta' ||
            !Number.isSafeInteger(frame.msg.sid) ||
            frame.msg.sid <= 0 ||
            (subscriptionId !== null && subscriptionId !== frame.msg.sid)
          )
            throw new Error('Invalid subscription.');
          subscriptionId = frame.msg.sid;
          snapshotRequestedAt = receivedAt;
          for (const ticker of marketTickers) pendingSnapshots.add(ticker);
        } else if (frame.type === 'orderbook_snapshot' && frame.sid === subscriptionId) {
          pendingSnapshots.delete(frame.msg?.market_ticker);
          if (pendingSnapshots.size === 0) {
            snapshotRequestedAt = null;
            if (snapshotRequestQueued) requestSnapshot();
          }
        } else if (frame.type === 'unsubscribed' && frame.sid === subscriptionId) {
          fail('Kalshi order book subscription ended.');
        }
        if (receivedAt - connectionStartedAt >= 60_000) reconnectAttempt = 0;
      } catch {
        fail('Kalshi book messages failed validation; reconnecting.');
      }
    });
    const markAlive = () => {
      if (!stopped && socket === connection) lastTransportAt = now();
    };
    connection.on('ping', markAlive);
    connection.on('pong', markAlive);
    connection.on('error', () => {
      if (socket === connection) fail('Kalshi book connection failed.');
    });
    connection.on('close', () => {
      if (socket === connection) fail('Kalshi book connection closed.');
    });
    connection.on('unexpected-response', (_request, response) => {
      response.resume?.();
      if (socket === connection)
        fail('Kalshi did not authorize the book connection.', 'unavailable');
    });
  };
  const start = () => {
    if (!stopped) return;
    stopped = false;
    connect();
    if (stopped) return;
    healthTimer = timers.setInterval(() => {
      const timestamp = now();
      if (!socket) return;
      if (snapshotRequestQueued && pendingSnapshots.size === 0) requestSnapshot();
      if (subscriptionId === null && timestamp - connectionStartedAt > handshakeTimeoutMs)
        fail('Kalshi book subscription timed out.');
      else if (snapshotRequestedAt !== null && timestamp - snapshotRequestedAt > handshakeTimeoutMs)
        fail('Kalshi replacement book snapshots timed out.');
      else if (
        lastTransportAt !== null &&
        (timestamp < lastTransportAt || timestamp - lastTransportAt > keepAliveTimeoutMs)
      )
        fail('Kalshi book connection is stale.', 'stale');
    }, 1000);
  };
  const stop = () => {
    const wasStopped = stopped;
    halt();
    if (!wasStopped) transition('stopped');
  };
  const getStatus = () => ({
    state,
    reason,
    connectionId,
    subscriptionId,
    lastTransportAt,
    pendingSnapshots: [...pendingSnapshots],
    snapshotRequestQueued,
    tickers: [...marketTickers],
  });
  return { start, stop, requestSnapshot, getStatus };
};
