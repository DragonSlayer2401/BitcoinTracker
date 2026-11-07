import { parseTicker } from '../coinbase.service';
import { createCoinbaseOrderBook } from './coinbaseOrderBook.service';
import { createCoinbaseTrades } from './coinbaseTrades.service';

const WEBSOCKET_URL = 'wss://ws-feed.exchange.coinbase.com';
const CHANNELS = ['matches', 'heartbeat', 'ticker', 'level2_batch'];
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAXIMUM_MESSAGE_BYTES = 20_000_000;
const MAXIMUM_RECENT_TICKERS = 2000;

export const createCoinbaseStream = ({
  onUpdate = () => {},
  onCapture = null,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  random = Math.random,
} = {}) => {
  const book = createCoinbaseOrderBook();
  const trades = createCoinbaseTrades();
  let socket = null;
  let stopped = true;
  let publishTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectCount = 0;
  let connectionId = 0;
  let transportStatus = 'connecting';
  let transportReason = 'Connecting to Coinbase live trades and liquidity.';
  let connectedAt = null;
  let connectionAttemptAt = null;
  let isSubscribed = false;
  let ticker = null;
  let recentTickers = [];
  let liquidity = book.getSnapshot(now());

  const clearMarket = () => {
    book.reset();
    trades.reset();
    ticker = null;
    recentTickers = [];
    liquidity = book.getSnapshot(now());
    isSubscribed = false;
    connectedAt = null;
  };

  const closeSocket = () => {
    if (!socket) return;
    const previous = socket;
    socket = null;
    previous.onopen = null;
    previous.onmessage = null;
    previous.onclose = null;
    previous.onerror = null;
    if (previous.readyState < 2) previous.close();
  };

  // Capture failures must stop recording rather than masquerade as a network reconnect.
  const capture = (input) => {
    if (!onCapture) return;
    try {
      onCapture({ ...input, connectionId });
    } catch (error) {
      stopped = true;
      globalThis.clearInterval(publishTimer);
      globalThis.clearTimeout(reconnectTimer);
      publishTimer = null;
      reconnectTimer = null;
      closeSocket();
      clearMarket();
      transportStatus = 'unavailable';
      transportReason = 'The live recording consumer failed.';
      throw error;
    }
  };

  const getSnapshot = (timestamp = now()) => {
    liquidity = book.getSnapshot(timestamp);
    const flow = trades.getSnapshot(timestamp, liquidity);
    const tradeQuality = trades.getQuality(timestamp);
    // A slightly leading exchange clock must not replace the last usable quote.
    // Preserve its original timestamps and wait until both are at or before capture.
    const eligibleTicker = recentTickers.findLast(
      (quote) =>
        quote.time <= timestamp &&
        quote.receivedAt <= timestamp &&
        timestamp - quote.time <= 5000 &&
        timestamp - quote.receivedAt <= 5000,
    );
    const isTickerFresh = Boolean(eligibleTicker);
    const reason =
      transportStatus !== 'connected'
        ? transportReason
        : !isSubscribed
          ? 'Waiting for live channel subscriptions.'
          : !tradeQuality.available
            ? tradeQuality.reason
            : !isTickerFresh
              ? 'Waiting for a fresh live price.'
              : !liquidity.available
                ? liquidity.reason
                : !flow.available
                  ? 'Collecting three minutes of complete trade flow.'
                  : null;
    return {
      status:
        transportStatus === 'connected' ? (reason === null ? 'live' : 'warming') : transportStatus,
      ticker: isTickerFresh && transportStatus === 'connected' ? { ...eligibleTicker } : null,
      quality: {
        available: reason === null,
        reason,
        connectedAt,
        completeSince: tradeQuality.completeSince,
        heartbeatAt: tradeQuality.heartbeatAt,
        confirmedThrough: tradeQuality.confirmedThrough,
        lastTradeId: tradeQuality.lastTradeId,
        flowReadySeconds: tradeQuality.flowReadySeconds,
        reconnectCount,
      },
      flow,
      liquidity,
    };
  };

  const publish = () => {
    if (!stopped) onUpdate(getSnapshot());
  };

  const fail = (reason) => {
    if (stopped || reconnectTimer !== null) return;
    closeSocket();
    clearMarket();
    transportStatus = 'reconnecting';
    transportReason = reason;
    reconnectCount += 1;
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5)) * (0.8 + random() * 0.2);
    reconnectAttempt += 1;
    capture({
      kind: 'connection',
      state: 'reconnecting',
      receivedAt: now(),
      reason,
      retryDelayMs: delay,
    });
    if (stopped) return;
    reconnectTimer = globalThis.setTimeout(connect, delay);
    publish();
  };

  const acceptMessage = (message, timestamp) => {
    if (message.type === 'error') throw new Error('Coinbase rejected a live channel subscription.');
    if (message.type === 'subscriptions') {
      if (
        !Array.isArray(message.channels) ||
        !CHANNELS.every((name) =>
          message.channels.some(
            (channel) =>
              (channel.name === name ||
                (name === 'level2_batch' && channel.name === 'level2_50')) &&
              channel.product_ids?.includes('BTC-USD'),
          ),
        )
      )
        throw new Error('Coinbase did not confirm every required live channel.');
      isSubscribed = true;
      return;
    }
    if (message.product_id !== 'BTC-USD') return;
    if (['snapshot', 'l2update'].includes(message.type)) {
      const error = book.apply(message, timestamp);
      if (error) throw new Error(error);
    } else if (['match', 'last_match', 'heartbeat'].includes(message.type)) {
      const error = trades.apply(message, timestamp);
      if (error) throw new Error(error);
      if (message.type === 'heartbeat' && isSubscribed && timestamp - connectedAt >= 30_000)
        reconnectAttempt = 0;
    } else if (message.type === 'ticker') {
      const nextTicker = parseTicker(
        { ...message, bid: message.best_bid, ask: message.best_ask, volume: message.volume_24h },
        timestamp,
      );
      if (
        nextTicker.time > timestamp + 2000 ||
        timestamp - nextTicker.time > 5000 ||
        (ticker && nextTicker.time < ticker.time)
      )
        throw new Error('Live price timestamps are delayed or out of order.');
      ticker = nextTicker;
      recentTickers.push(nextTicker);
      if (recentTickers.length > MAXIMUM_RECENT_TICKERS) recentTickers.shift();
    }
  };

  const connect = () => {
    reconnectTimer = null;
    if (stopped) return;
    connectionAttemptAt = now();
    connectionId += 1;
    capture({ kind: 'connection', state: 'connecting', receivedAt: connectionAttemptAt });
    if (stopped) return;
    try {
      socket = new WebSocketImpl(WEBSOCKET_URL);
      const connection = socket;
      connection.onopen = () => {
        if (socket !== connection || stopped) return;
        connectedAt = now();
        transportStatus = 'connected';
        capture({ kind: 'connection', state: 'connected', receivedAt: connectedAt });
        if (stopped) return;
        connection.send(
          JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: CHANNELS }),
        );
      };
      connection.onmessage = (event) => {
        if (socket !== connection || stopped) return;
        const receivedAt = now();
        capture({
          kind: 'message',
          receivedAt,
          payload: typeof event.data === 'string' ? event.data : null,
        });
        if (stopped) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > MAXIMUM_MESSAGE_BYTES)
            throw new Error('Invalid live market message.');
          const message = JSON.parse(event.data);
          if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('Invalid live market message.');
          acceptMessage(message, receivedAt);
        } catch (error) {
          fail(error.message);
        }
      };
      connection.onerror = () => {
        if (socket === connection) fail('Live market connection failed. Reconnecting.');
      };
      connection.onclose = () => {
        if (socket === connection) fail('Live market connection closed. Reconnecting.');
      };
    } catch {
      fail('Unable to connect to the live market feed. Reconnecting.');
    }
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    if (typeof WebSocketImpl !== 'function') {
      transportStatus = 'unavailable';
      transportReason = 'This browser does not support the live market connection.';
      capture({
        kind: 'connection',
        state: 'unavailable',
        receivedAt: now(),
        reason: transportReason,
      });
      publish();
      return;
    }
    transportStatus = 'connecting';
    connect();
    if (stopped) return;
    publishTimer = globalThis.setInterval(() => {
      const timestamp = now();
      capture({ kind: 'clock', receivedAt: timestamp });
      if (stopped) return;
      const quality = trades.getQuality(timestamp);
      if (socket && !isSubscribed && timestamp - connectionAttemptAt > HANDSHAKE_TIMEOUT_MS)
        fail('Live channel setup timed out. Reconnecting.');
      else if (
        socket &&
        connectedAt !== null &&
        timestamp - connectedAt > HANDSHAKE_TIMEOUT_MS &&
        quality.heartbeatAt === null
      )
        fail('No live heartbeat received. Reconnecting.');
      else if (
        socket &&
        quality.heartbeatAt !== null &&
        (timestamp - quality.heartbeatAt > 5000 || quality.needsReconnect)
      )
        fail(
          quality.needsReconnect
            ? 'A heartbeat confirmed missing trades. Reconnecting.'
            : 'Live heartbeats stopped. Reconnecting.',
        );
      publish();
    }, 1000);
    publish();
  };

  const stop = () => {
    const wasStopped = stopped;
    stopped = true;
    globalThis.clearInterval(publishTimer);
    globalThis.clearTimeout(reconnectTimer);
    publishTimer = null;
    reconnectTimer = null;
    closeSocket();
    clearMarket();
    if (!wasStopped) capture({ kind: 'connection', state: 'stopped', receivedAt: now() });
  };

  return {
    start,
    stop,
    getSnapshot,
    getDeadlineOutcome: (expiresAt, timestamp = now()) =>
      trades.getDeadlineOutcome(expiresAt, timestamp),
  };
};
