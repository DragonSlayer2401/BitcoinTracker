import { createDerivativesMarket } from './derivativesMarket.service';

const WEBSOCKET_URL = 'wss://stream.bybit.com/v5/public/linear';
const TOPICS = ['publicTrade.BTCUSDT', 'allLiquidation.BTCUSDT', 'tickers.BTCUSDT'];
const SUBSCRIPTION_ID = 'btc-futures';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const MESSAGE_TIMEOUT_MS = 45_000;
const MAXIMUM_FRAME_CHARACTERS = 1_000_000;
const MAXIMUM_FRAME_CHARACTERS_PER_SECOND = 4_000_000;
const MAXIMUM_FRAMES_PER_SECOND = 1000;

/** One optional public venue connection shared by its owning browser or collector lifecycle. */
export function createDerivativesStream({
  onUpdate = () => {},
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  timers = globalThis,
} = {}) {
  const market = createDerivativesMarket();
  let socket = null;
  let stopped = true;
  let interval = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectCount = 0;
  let transportStatus = 'connecting';
  let transportReason = 'Connecting to public futures data.';
  let subscribed = false;
  let connectionStartedAt = null;
  let connectedAt = null;
  let lastMessageAt = null;
  let lastPongAt = null;
  let lastPingAt = null;
  let frameSecond = null;
  let frameCount = 0;
  let frameCharacters = 0;

  function closeSocket() {
    const connection = socket;
    socket = null;
    if (!connection) return;
    connection.onopen = null;
    connection.onmessage = null;
    connection.onclose = null;
    connection.onerror = null;
    try {
      if (connection.readyState < 2) connection.close();
    } catch {
      // The abandoned connection no longer owns state, including during a failed handshake.
    }
  }

  function clearMarket() {
    market.reset();
    subscribed = false;
    connectedAt = null;
    lastMessageAt = null;
    lastPingAt = null;
    lastPongAt = null;
  }

  function getSnapshot(timestamp = now()) {
    const isConnected =
      !stopped &&
      transportStatus === 'connected' &&
      subscribed &&
      lastMessageAt !== null &&
      timestamp >= lastMessageAt &&
      timestamp - lastMessageAt <= MESSAGE_TIMEOUT_MS;
    const state = market.getSnapshot(timestamp, isConnected);
    const available = Boolean(isConnected && state.windows[15].available);
    const reason =
      transportStatus !== 'connected'
        ? transportReason
        : !subscribed
          ? 'Waiting for public futures subscriptions.'
          : !isConnected
            ? 'Public futures messages are delayed.'
            : !state.hasFreshTrades
              ? 'Waiting for fresh futures trades.'
              : !available
                ? 'Collecting a complete futures trade window.'
                : null;
    return {
      version: 'bybit-linear-flow-v1',
      source: 'bybit-linear',
      symbol: 'BTCUSDT',
      status: transportStatus === 'connected' ? (available ? 'live' : 'warming') : transportStatus,
      asOf: timestamp,
      quality: {
        available,
        reason,
        subscribed,
        completeSince: state.completeSince,
        connectedAt,
        lastMessageAt,
        lastTradeAt: state.lastTradeAt,
        lastLiquidationAt: state.lastLiquidationAt,
        lastPongAt,
        reconnectCount,
        coverage: 'venue-reported',
        sequenceContinuity: 'not-verifiable',
        retainedTrades: state.retainedTrades,
        retainedLiquidations: state.retainedLiquidations,
      },
      windows: state.windows,
      largeTrades: { available: state.windows[60].largeTradesAvailable },
      impact: state.impact,
      liquidations: state.liquidations,
      ticker: state.ticker,
    };
  }

  function publish() {
    if (!stopped) onUpdate(getSnapshot());
  }

  function fail(reason) {
    if (stopped || reconnectTimer !== null) return;
    closeSocket();
    clearMarket();
    transportStatus = 'reconnecting';
    transportReason = reason;
    reconnectCount += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
    reconnectAttempt += 1;
    reconnectTimer = timers.setTimeout(connect, delay);
    publish();
  }

  function acceptMessage(message, timestamp) {
    if (message.op === 'subscribe') {
      if (message.req_id !== SUBSCRIPTION_ID || message.success !== true)
        throw new Error('The public futures subscription was not confirmed.');
      if (!subscribed) market.beginCoverage(timestamp);
      subscribed = true;
      lastMessageAt = timestamp;
      return;
    }
    if (message.op === 'pong' || (message.op === 'ping' && message.ret_msg === 'pong')) {
      lastMessageAt = timestamp;
      lastPongAt = timestamp;
      if (connectedAt !== null && timestamp - connectedAt >= 60_000) reconnectAttempt = 0;
      return;
    }
    if (!TOPICS.includes(message.topic)) return;
    // The acknowledgement defines the beginning of measured coverage. The next frames arrive
    // continuously; executions delivered before that boundary cannot establish a full window.
    if (!subscribed) {
      if (message.topic === 'tickers.BTCUSDT') market.apply(message, timestamp);
      return;
    }
    if (message.topic !== 'tickers.BTCUSDT' && message.type !== 'snapshot')
      throw new Error('Unsupported public futures message type.');
    market.apply(message, timestamp);
    lastMessageAt = timestamp;
  }

  function connect() {
    reconnectTimer = null;
    if (stopped) return;
    connectionStartedAt = now();
    frameSecond = null;
    frameCount = 0;
    frameCharacters = 0;
    try {
      const connection = new WebSocketImpl(WEBSOCKET_URL);
      socket = connection;
      connection.onopen = () => {
        if (socket !== connection || stopped) return;
        connectedAt = now();
        transportStatus = 'connected';
        lastPingAt = connectedAt;
        try {
          connection.send(
            JSON.stringify({ op: 'subscribe', req_id: SUBSCRIPTION_ID, args: TOPICS }),
          );
        } catch {
          fail('Unable to subscribe to public futures data.');
        }
      };
      connection.onmessage = (event) => {
        if (socket !== connection || stopped) return;
        try {
          const timestamp = now();
          const second = Math.floor(timestamp / 1000);
          if (second !== frameSecond) {
            frameSecond = second;
            frameCount = 0;
            frameCharacters = 0;
          }
          frameCount += 1;
          frameCharacters += typeof event.data === 'string' ? event.data.length : 0;
          if (
            typeof event.data !== 'string' ||
            event.data.length > MAXIMUM_FRAME_CHARACTERS ||
            frameCount > MAXIMUM_FRAMES_PER_SECOND ||
            frameCharacters > MAXIMUM_FRAME_CHARACTERS_PER_SECOND
          )
            throw new Error('Public futures messages exceed the supported frame limit.');
          const message = JSON.parse(event.data);
          if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('Invalid public futures message.');
          acceptMessage(message, timestamp);
        } catch (error) {
          fail(error instanceof SyntaxError ? 'Malformed public futures message.' : error.message);
        }
      };
      connection.onerror = () => {
        if (socket === connection) fail('Public futures connection unavailable. Reconnecting.');
      };
      connection.onclose = () => {
        if (socket === connection) fail('Public futures connection closed. Reconnecting.');
      };
    } catch {
      fail('Unable to connect to public futures data. Reconnecting.');
    }
  }

  function tick() {
    const timestamp = now();
    if (socket && connectionStartedAt !== null) {
      if (timestamp < connectionStartedAt || (lastMessageAt !== null && timestamp < lastMessageAt))
        fail('The local clock changed. Restarting futures observation.');
      else if (!subscribed && timestamp - connectionStartedAt > HANDSHAKE_TIMEOUT_MS)
        fail('Public futures subscription timed out.');
      else if (subscribed && timestamp - lastMessageAt > MESSAGE_TIMEOUT_MS)
        fail('Public futures messages stopped. Reconnecting.');
      else if (connectedAt !== null && timestamp - (lastPongAt ?? connectedAt) > MESSAGE_TIMEOUT_MS)
        fail('Public futures heartbeat stopped. Reconnecting.');
      else if (connectedAt !== null && timestamp - lastPingAt >= HEARTBEAT_INTERVAL_MS) {
        try {
          socket.send(JSON.stringify({ op: 'ping' }));
          lastPingAt = timestamp;
        } catch {
          fail('Unable to send public futures heartbeat.');
        }
      }
    }
    publish();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    if (typeof WebSocketImpl !== 'function') {
      transportStatus = 'unavailable';
      transportReason = 'Public futures WebSocket support is unavailable.';
      publish();
      return;
    }
    transportStatus = 'connecting';
    transportReason = 'Connecting to public futures data.';
    connect();
    interval = timers.setInterval(tick, 1000);
    publish();
  }

  function stop() {
    stopped = true;
    timers.clearInterval(interval);
    timers.clearTimeout(reconnectTimer);
    interval = null;
    reconnectTimer = null;
    closeSocket();
    clearMarket();
    transportStatus = 'stopped';
    transportReason = 'Public futures observation stopped.';
  }

  return { start, stop, getSnapshot };
}
