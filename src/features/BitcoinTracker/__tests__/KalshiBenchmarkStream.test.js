/** @jest-environment node */
import { EventEmitter } from 'node:events';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import { createKalshiBenchmarkStream } from '../../../services/kalshi/benchmarkStream/benchmarkStream.service';
import { createBenchmarkStreamHistory } from '../../../services/kalshi/benchmarkStream/benchmarkStreamHistory.utils';
import {
  createKalshiBenchmarkStreamHeaders,
  createKalshiReadHeaders,
} from '../../../services/kalshi/kalshi.auth';

jest.mock('server-only', () => ({}));

const NOW = Date.parse('2026-09-14T12:00:00Z');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const environment = {
  KALSHI_API_KEY_ID: 'benchmark-stream-test',
  KALSHI_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const subscription = {
  id: 1,
  type: 'subscribed',
  msg: { channel: 'cfbenchmarks_value', sid: 4 },
};
const indices = (indexIds = ['BRTI'], seq = 1) => ({
  id: 2,
  type: 'cfbenchmarks_value_indexlist',
  sid: 4,
  seq,
  msg: { index_ids: indexIds },
});
const value = (time = NOW, price = '100000', seq = 2, raw = {}) => ({
  type: 'cfbenchmarks_value',
  sid: 4,
  seq,
  msg: {
    index_id: 'BRTI',
    received_at: time,
    data: JSON.stringify({ type: 'value', id: 'BRTI', time, value: price, ...raw }),
    // These values are intentionally unrelated; the adapter must not use server averages.
    avg_60s_data: { value: '1', window_size: 60 },
    last_60s_windowed_average_15min: { value: '2', window_size: 60 },
  },
});
const seed = (samples, receivedAt = NOW) => ({
  samples,
  current: samples.at(-1) ?? null,
  receivedAt,
});

describe('Kalshi BRTI socket authentication', () => {
  test('signs only the fixed GET handshake and does not broaden the REST allowlist', () => {
    const headers = createKalshiBenchmarkStreamHeaders(environment, NOW);
    const verifySignature = (message) =>
      verify(
        'sha256',
        Buffer.from(message),
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'], 'base64'),
      );
    expect(headers['KALSHI-ACCESS-KEY']).toBe(environment.KALSHI_API_KEY_ID);
    expect(verifySignature(`${NOW}GET/trade-api/ws/v2`)).toBe(true);
    expect(verifySignature(`${NOW}POST/trade-api/v2/portfolio/orders`)).toBe(false);
    expect(() => createKalshiReadHeaders('/portfolio/orders', environment, NOW)).toThrow();
    expect(() => createKalshiReadHeaders('/trade-api/ws/v2', environment, NOW)).toThrow();
    expect(() => createKalshiBenchmarkStreamHeaders({}, NOW)).toThrow('credentials');
  });
});

describe('Receipt-dated BRTI history', () => {
  test('later history and corrections are unavailable to an earlier decision', () => {
    const history = createBenchmarkStreamHistory();
    expect(history.seed(seed([{ time: NOW - 1000, price: 100_000 }], NOW - 500), NOW)).toBe(true);
    expect(history.getSnapshot(NOW - 1).samples).toEqual([]);
    const captured = history.getSnapshot(NOW);
    history.seed(seed([{ time: NOW - 1000, price: 100_001 }], NOW + 1000), NOW + 1000);
    expect(history.getSnapshot(NOW).current.price).toBe(100_000);
    expect(history.getSnapshot(NOW + 1000).current.price).toBe(100_001);
    expect(captured.current).toMatchObject({
      price: 100_000,
      receivedAt: NOW,
      sourceReceivedAt: NOW - 500,
    });
  });

  test('duplicate REST refreshes preserve receipts and a malformed batch is atomic', () => {
    const history = createBenchmarkStreamHistory();
    history.seed(seed([{ time: NOW, price: 100_000 }]), NOW);
    history.seed(seed([{ time: NOW, price: 100_000 }], NOW + 1000), NOW + 1000);
    expect(history.getSnapshot(NOW + 1000).current.receivedAt).toBe(NOW);
    expect(
      history.seed(
        seed(
          [
            { time: NOW, price: 100_010 },
            { time: NOW + 1500, price: 100_020 },
          ],
          NOW + 2000,
        ),
        NOW + 2000,
      ),
    ).toBe(false);
    expect(history.getSnapshot(NOW + 2000).current.price).toBe(100_000);
    expect(history.seed(seed([{ time: NOW, price: 100_010, amendTime: NOW + 5000 }]), NOW)).toBe(
      false,
    );
    expect(history.seed(seed([{ time: NOW, price: 100_010 }], NOW + 1), NOW)).toBe(false);
  });

  test('retains at most a canonical hour and never interpolates missing seconds', () => {
    const history = createBenchmarkStreamHistory();
    const samples = Array.from({ length: 4000 }, (_, index) => ({
      time: NOW - (3999 - index) * 1000,
      price: 100_000,
    }));
    history.seed(seed(samples), NOW);
    expect(history.getSnapshot(NOW).samples).toHaveLength(3600);
    history.accept({ time: NOW + 2000, price: 100_001, receivedAt: NOW + 2000 });
    const result = history.getSnapshot(NOW + 2000);
    expect(result.samples).toHaveLength(3599);
    expect(result.samples.some((sample) => sample.time === NOW + 1000)).toBe(false);
  });
});

describe('Authenticated standard BRTI stream', () => {
  let sockets;
  let stream;
  let selectedEnvironment;
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.send = jest.fn();
      this.terminate = jest.fn();
      sockets.push(this);
    }
    open() {
      this.emit('open');
    }
    message(message) {
      this.emit('message', Buffer.from(JSON.stringify(message)), false);
    }
  }
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    sockets = [];
    selectedEnvironment = environment;
    stream = createKalshiBenchmarkStream({
      WebSocketImpl: FakeSocket,
      getEnvironment: () => selectedEnvironment,
    });
  });
  afterEach(() => {
    stream.stop();
    jest.useRealTimers();
  });
  function connect() {
    stream.start();
    const socket = sockets.at(-1);
    socket.open();
    socket.message(subscription);
    return socket;
  }
  function live() {
    const socket = connect();
    socket.message(indices());
    socket.message(value());
    return socket;
  }

  test('requires acknowledgement, an available BRTI index, and a fresh tick before reporting live', () => {
    stream.seed(seed([{ time: NOW - 1000, price: 99_999 }]));
    const socket = connect();
    expect(socket.url).toBe('wss://external-api-ws.kalshi.com/trade-api/ws/v2');
    expect(socket.options).toMatchObject({
      maxPayload: 64_000,
      followRedirects: false,
      perMessageDeflate: false,
    });
    expect(socket.options.headers['KALSHI-ACCESS-KEY']).toBe(environment.KALSHI_API_KEY_ID);
    expect(socket.send.mock.calls.map(([message]) => JSON.parse(message))).toEqual([
      {
        id: 1,
        cmd: 'subscribe',
        params: { channels: ['cfbenchmarks_value'], index_ids: ['BRTI'] },
      },
      { id: 2, cmd: 'update_subscription', params: { sid: 4, action: 'indexlist' } },
    ]);
    socket.message(value(NOW, '100000', 1));
    expect(stream.getStatus()).toMatchObject({
      status: 'warming',
      indexAvailable: false,
      available: false,
    });
    socket.message(indices(['BRTI'], 2));
    expect(stream.getStatus()).toMatchObject({
      status: 'live',
      indexAvailable: true,
      available: true,
    });
    const snapshot = stream.getSnapshot();
    expect(snapshot.samples).toHaveLength(2);
    expect(snapshot.current).toMatchObject({
      time: NOW,
      price: 100_000,
      receivedAt: NOW,
      provenance: 'kalshi-websocket',
    });
    expect(snapshot.current.price).not.toBe(2);
    snapshot.current.price = 1;
    expect(stream.getSnapshot().current.price).toBe(100_000);
  });

  test('REST seeding and socket open alone never claim a live entitlement', () => {
    stream.seed(seed([{ time: NOW, price: 100_000 }]));
    connect().message(indices());
    expect(stream.getStatus()).toMatchObject({
      status: 'warming',
      available: false,
      indexAvailable: true,
    });
  });

  test('does not create a socket without credentials and backs off denied indices', () => {
    selectedEnvironment = {};
    stream.start();
    expect(sockets).toHaveLength(0);
    expect(stream.getStatus().status).toBe('not-configured');
    stream.stop();
    selectedEnvironment = environment;
    connect().message(indices(['ETHUSD_RTI']));
    expect(stream.getStatus()).toMatchObject({ status: 'unavailable', available: false });
    jest.advanceTimersByTime(59_999);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });

  test('ignores identical duplicates without refreshing price age and detects source gaps', () => {
    const socket = live();
    socket.message(value());
    jest.advanceTimersByTime(1000);
    socket.message(value(NOW, '100000', 3));
    expect(stream.getSnapshot().current.receivedAt).toBe(NOW);
    jest.advanceTimersByTime(1000);
    socket.message(value(NOW + 2000, '100001', 5));
    expect(stream.getStatus()).toMatchObject({ sourceGapCount: 1, sequenceGapCount: 1 });
    expect(stream.getSnapshot().samples).toHaveLength(2);
  });

  test.each([
    ['regressed sequence', () => value(NOW + 1000, '100001', 1)],
    ['conflicting sequence', () => value(NOW, '100001', 2)],
    ['regressed source', () => value(NOW - 1000, '100001', 3)],
    ['conflicting source', () => value(NOW, '100001', 3)],
    ['future value', () => value(NOW + 2000, '100001', 3)],
    ['future amendment', () => value(NOW + 1000, '100001', 3, { amendTime: NOW + 2000 })],
    [
      'wrong index',
      () => ({
        ...value(NOW + 1000, '100001', 3),
        msg: { ...value().msg, index_id: 'ETHUSD_RTI' },
      }),
    ],
  ])('invalidates the optional stream on %s without revising stored history', (_name, message) => {
    const socket = live();
    jest.advanceTimersByTime(1000);
    socket.message(message());
    expect(stream.getStatus()).toMatchObject({ status: 'reconnecting', available: false });
    expect(stream.getSnapshot(NOW).current.price).toBe(100_000);
    expect(socket.terminate).toHaveBeenCalled();
  });

  test('does not round offset or repeated values into canonical settlement seconds', () => {
    const socket = connect();
    socket.message(indices());
    jest.advanceTimersByTime(500);
    socket.message(value(NOW + 123, '100000', 2));
    socket.message(value(NOW, '100000', 3, { repeatOfPreviousValue: true }));
    expect(stream.getSnapshot().samples).toEqual([]);
    expect(stream.getStatus()).toMatchObject({ available: false, ignoredNonCanonical: 2 });
  });

  test('stale data falls back before reconnect and stops accepting events from abandoned sockets', () => {
    const socket = live();
    jest.advanceTimersByTime(5001);
    expect(stream.getStatus()).toMatchObject({ status: 'stale', available: false });
    jest.advanceTimersByTime(26_000);
    expect(stream.getStatus().status).toBe('reconnecting');
    socket.message(value(NOW + 31_000, '110000', 3));
    expect(stream.getSnapshot().current.price).toBe(100_000);
    jest.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(2);
    expect(stream.getStatus()).toMatchObject({ status: 'connecting', indexAvailable: false });
  });

  test('bounds reconnect attempts, including rapid stop/start and a failed handshake', () => {
    stream.start();
    stream.stop();
    stream.start();
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(4999);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1].emit('error', new Error('network'));
    jest.advanceTimersByTime(4999);
    expect(sockets).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2].emit('error', new Error('network'));
    jest.advanceTimersByTime(9999);
    expect(sockets).toHaveLength(3);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  test('rejects binary/oversized messages and rate bursts before parsing', () => {
    const socket = connect();
    socket.emit('message', Buffer.alloc(64_001), false);
    expect(stream.getStatus().status).toBe('reconnecting');
    stream.stop();
    jest.advanceTimersByTime(5000);
    const fresh = connect();
    fresh.message(indices());
    for (let index = 0; index < 25; index += 1) fresh.message({ type: 'ok' });
    expect(stream.getStatus().status).toBe('reconnecting');
  });

  test('times out unconfirmed subscriptions and cleans timers on stop', () => {
    connect();
    jest.advanceTimersByTime(11_000);
    expect(stream.getStatus().status).toBe('reconnecting');
    stream.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(stream.getStatus().status).toBe('stopped');
  });

  test('credential rotation clears prior connection history', () => {
    live();
    selectedEnvironment = { ...environment, KALSHI_API_KEY_ID: 'rotated-key' };
    jest.advanceTimersByTime(1000);
    expect(stream.getStatus().status).toBe('reconnecting');
    expect(stream.getSnapshot().samples).toEqual([]);
  });
});
