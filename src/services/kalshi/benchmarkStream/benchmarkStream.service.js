import 'server-only';
import WebSocket from 'ws';
import {
  createKalshiBenchmarkStreamHeaders,
  getKalshiCredentialFingerprint,
  hasKalshiCredentials,
} from '../kalshi.auth';
import {
  createBenchmarkStreamHistory,
  parseBenchmarkStreamValue,
} from './benchmarkStreamHistory.utils';

const URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';
const CHANNEL = 'cfbenchmarks_value';
const MAXIMUM_FRAME_BYTES = 64_000;
const MAXIMUM_FRAMES_PER_SECOND = 25;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAXIMUM_TICK_AGE_MS = 5000;
const RECONNECT_TIMEOUT_MS = 30_000;
const MINIMUM_RECONNECT_MS = 5000;
const MAXIMUM_RECONNECT_MS = 60_000;

/**
 * One authenticated, BRTI-only standard feed. ws handles protocol ping/pong automatically.
 * https://docs.kalshi.com/websockets/cfbenchmarks-value
 * Upstream rolling averages are deliberately excluded from the settlement input contract.
 */
export function createKalshiBenchmarkStream({
  WebSocketImpl = WebSocket,
  now = Date.now,
  timers = globalThis,
  getEnvironment = () => process.env,
  onUpdate = () => {},
} = {}) {
  const history = createBenchmarkStreamHistory();
  let socket = null;
  let stopped = true;
  let interval = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectCount = 0;
  let connectionStartedAt = null;
  let lastConnectAttemptAt = null;
  let connectedAt = null;
  let credentialFingerprint = null;
  let subscriptionId = null;
  let availableIndexIds = [];
  let indexAvailable = false;
  let indexListReceived = false;
  let sequence = null;
  let lastFrame = null;
  let latestTick = null;
  let lastMessageAt = null;
  let frameSecond = null;
  let frameCount = 0;
  let ignoredNonCanonical = 0;
  let sourceGapCount = 0;
  let sequenceGapCount = 0;
  let transportStatus = 'stopped';
  let transportReason = 'BRTI stream has not started.';

  function clearConnection() {
    connectedAt = null;
    subscriptionId = null;
    availableIndexIds = [];
    indexAvailable = false;
    indexListReceived = false;
    sequence = null;
    lastFrame = null;
    latestTick = null;
    lastMessageAt = null;
  }

  function closeSocket() {
    const previous = socket;
    socket = null;
    if (!previous) return;
    previous.removeAllListeners();
    // A handshake aborted by terminate can emit an asynchronous error after disposal.
    previous.on('error', () => {});
    if (typeof previous.terminate === 'function') previous.terminate();
    else previous.close();
  }

  function getStatus(timestamp = now()) {
    const fresh =
      latestTick &&
      latestTick.receivedAt <= timestamp &&
      latestTick.time <= timestamp &&
      timestamp - latestTick.receivedAt <= MAXIMUM_TICK_AGE_MS &&
      timestamp - latestTick.time <= MAXIMUM_TICK_AGE_MS;
    const available = Boolean(
      !stopped && transportStatus === 'connected' && indexAvailable && fresh,
    );
    const status = available
      ? 'live'
      : transportStatus === 'connected'
        ? !indexListReceived || !latestTick
          ? 'warming'
          : 'stale'
        : transportStatus;
    return {
      status,
      available,
      reason: available
        ? null
        : transportStatus !== 'connected'
          ? transportReason
          : !indexListReceived
            ? 'Waiting for BRTI index availability confirmation.'
            : 'Waiting for fresh canonical per-second BRTI readings; REST remains available.',
      transport: 'kalshi-websocket',
      channel: CHANNEL,
      subscribed: subscriptionId !== null,
      indexAvailable,
      indexListReceived,
      availableIndexIds: [...availableIndexIds],
      connectedAt,
      lastMessageAt,
      latestSourceAt: latestTick?.time ?? null,
      latestReceivedAt: latestTick?.receivedAt ?? null,
      subscriptionId,
      sequence,
      reconnectCount,
      ignoredNonCanonical,
      sourceGapCount,
      sequenceGapCount,
    };
  }

  function getSnapshot(timestamp = now()) {
    const contents = history.getSnapshot(timestamp);
    const streamStatus = getStatus(timestamp);
    return {
      ...contents,
      source: 'CF Benchmarks BRTI',
      transport: 'kalshi-websocket',
      status: streamStatus.status,
      available: streamStatus.available && contents.current !== null,
      receivedAt: contents.current?.receivedAt ?? null,
      reason: streamStatus.reason,
      streamStatus,
    };
  }

  function publish() {
    if (!stopped) onUpdate(getSnapshot());
  }

  function fail(reason, status = 'reconnecting', minimumDelay = MINIMUM_RECONNECT_MS) {
    if (stopped || reconnectTimer !== null) return;
    closeSocket();
    clearConnection();
    transportStatus = status;
    transportReason = reason;
    reconnectCount += 1;
    const delay = Math.max(
      minimumDelay,
      Math.min(MAXIMUM_RECONNECT_MS, MINIMUM_RECONNECT_MS * 2 ** Math.min(reconnectAttempt, 4)),
    );
    reconnectAttempt += 1;
    reconnectTimer = timers.setTimeout(connect, delay);
    publish();
  }

  function accept(message, receivedAt, raw) {
    if (message.type === 'error') {
      fail(
        'Kalshi did not authorize or could not provide the BRTI stream; REST remains available.',
        'unavailable',
        MAXIMUM_RECONNECT_MS,
      );
      return;
    }
    if (message.type === 'subscribed') {
      if (
        message.id !== 1 ||
        message.msg?.channel !== CHANNEL ||
        !Number.isSafeInteger(message.msg.sid) ||
        message.msg.sid < 1 ||
        subscriptionId !== null
      )
        throw new Error('Invalid BRTI subscription acknowledgement.');
      subscriptionId = message.msg.sid;
      socket.send(
        JSON.stringify({
          id: 2,
          cmd: 'update_subscription',
          params: { sid: subscriptionId, action: 'indexlist' },
        }),
      );
      return;
    }
    if (!['cfbenchmarks_value', 'cfbenchmarks_value_indexlist'].includes(message.type)) return;
    if (
      subscriptionId === null ||
      message.sid !== subscriptionId ||
      !Number.isSafeInteger(message.seq) ||
      message.seq < 0
    )
      throw new Error('BRTI message has an invalid subscription or sequence.');
    if (sequence !== null && message.seq <= sequence) {
      if (message.seq === sequence && raw === lastFrame) return;
      throw new Error('BRTI stream sequence regressed or conflicted.');
    }
    if (sequence !== null && message.seq > sequence + 1) sequenceGapCount += 1;
    sequence = message.seq;
    lastFrame = raw;
    lastMessageAt = receivedAt;
    if (message.type === 'cfbenchmarks_value_indexlist') {
      const ids = message.msg?.index_ids;
      if (
        message.id !== 2 ||
        !Array.isArray(ids) ||
        ids.length > 500 ||
        ids.some((id) => typeof id !== 'string' || id.length > 80)
      )
        throw new Error('Invalid BRTI index availability response.');
      availableIndexIds = [...new Set(ids)];
      indexListReceived = true;
      indexAvailable = availableIndexIds.includes('BRTI');
      if (!indexAvailable)
        fail(
          'BRTI is not available on this Kalshi connection; REST remains available.',
          'unavailable',
          MAXIMUM_RECONNECT_MS,
        );
      return;
    }
    const reading = parseBenchmarkStreamValue(message, receivedAt);
    if (!reading) {
      ignoredNonCanonical += 1;
      return;
    }
    if (latestTick && reading.time <= latestTick.time) {
      if (reading.time === latestTick.time && reading.price === latestTick.price) return;
      throw new Error('BRTI source timestamps regressed or conflicted.');
    }
    if (latestTick && reading.time > latestTick.time + 1000) sourceGapCount += 1;
    latestTick = reading;
    history.accept(reading);
    if (connectedAt !== null && receivedAt - connectedAt >= 60_000) reconnectAttempt = 0;
  }

  function connect() {
    reconnectTimer = null;
    if (stopped) return;
    const elapsed = lastConnectAttemptAt === null ? Infinity : now() - lastConnectAttemptAt;
    if (elapsed < MINIMUM_RECONNECT_MS) {
      transportStatus = 'connecting';
      transportReason = 'Waiting for the BRTI connection retry allowance.';
      reconnectTimer = timers.setTimeout(
        connect,
        Math.max(MINIMUM_RECONNECT_MS - elapsed, MINIMUM_RECONNECT_MS),
      );
      return;
    }
    connectionStartedAt = now();
    frameSecond = null;
    frameCount = 0;
    const environment = getEnvironment();
    credentialFingerprint = getKalshiCredentialFingerprint(environment);
    if (!hasKalshiCredentials(environment)) {
      fail(
        'Configure server-side Kalshi credentials for the BRTI stream.',
        'not-configured',
        MAXIMUM_RECONNECT_MS,
      );
      return;
    }
    try {
      lastConnectAttemptAt = connectionStartedAt;
      const connection = new WebSocketImpl(URL, {
        headers: createKalshiBenchmarkStreamHeaders(environment, connectionStartedAt),
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAXIMUM_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      });
      socket = connection;
      transportStatus = 'connecting';
      transportReason = 'Connecting to the authenticated Kalshi BRTI stream.';
      connection.on('open', () => {
        if (socket !== connection || stopped) return;
        connectedAt = now();
        transportStatus = 'connected';
        try {
          connection.send(
            JSON.stringify({
              id: 1,
              cmd: 'subscribe',
              params: { channels: [CHANNEL], index_ids: ['BRTI'] },
            }),
          );
        } catch {
          fail('Unable to subscribe to the BRTI stream.');
        }
        publish();
      });
      connection.on('message', (data, isBinary) => {
        if (socket !== connection || stopped) return;
        try {
          const receivedAt = now();
          if (lastMessageAt !== null && receivedAt < lastMessageAt)
            throw new Error('The local BRTI receipt clock regressed.');
          const second = Math.floor(receivedAt / 1000);
          if (frameSecond !== second) {
            frameSecond = second;
            frameCount = 0;
          }
          frameCount += 1;
          if (
            isBinary ||
            data.length > MAXIMUM_FRAME_BYTES ||
            frameCount > MAXIMUM_FRAMES_PER_SECOND
          )
            throw new Error('BRTI stream exceeded its supported message limits.');
          const raw = typeof data === 'string' ? data : data.toString('utf8');
          const message = JSON.parse(raw);
          if (!message || typeof message !== 'object' || Array.isArray(message))
            throw new Error('Invalid BRTI message.');
          accept(message, receivedAt, raw);
          publish();
        } catch {
          fail('BRTI stream data failed validation; reconnecting with REST fallback.');
        }
      });
      connection.on('error', () => {
        if (socket === connection) fail('BRTI stream connection failed; REST remains available.');
      });
      connection.on('close', () => {
        if (socket === connection) fail('BRTI stream disconnected; REST remains available.');
      });
    } catch {
      fail(
        'BRTI stream could not connect; check the server credentials.',
        'unavailable',
        MAXIMUM_RECONNECT_MS,
      );
    }
  }

  function tick() {
    const timestamp = now();
    if (socket && getKalshiCredentialFingerprint(getEnvironment()) !== credentialFingerprint) {
      history.clear();
      fail('Kalshi credentials changed; restarting the BRTI stream.');
    } else if (
      socket &&
      (timestamp < connectionStartedAt || (lastMessageAt !== null && timestamp < lastMessageAt))
    ) {
      fail('The local clock changed; restarting BRTI observation.');
    } else if (
      socket &&
      !indexListReceived &&
      timestamp - connectionStartedAt > HANDSHAKE_TIMEOUT_MS
    ) {
      fail('BRTI subscription or index discovery timed out; REST remains available.');
    } else if (
      socket &&
      indexListReceived &&
      timestamp - (latestTick?.receivedAt ?? connectedAt) > RECONNECT_TIMEOUT_MS
    ) {
      fail('Fresh BRTI stream readings stopped; reconnecting with REST fallback.');
    }
    publish();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
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
    clearConnection();
    transportStatus = 'stopped';
    transportReason = 'BRTI stream is stopped.';
  }

  return { start, stop, seed: (snapshot) => history.seed(snapshot, now()), getSnapshot, getStatus };
}
