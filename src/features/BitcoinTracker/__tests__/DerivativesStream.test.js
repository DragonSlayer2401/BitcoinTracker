import { createDerivativesMarket } from '@/services/derivatives/derivativesMarket.service';
import { createDerivativesStream } from '@/services/derivatives/derivativesStream.service';

const NOW = Date.UTC(2026, 8, 13, 12, 0);
const trade = (time, overrides = {}) => ({
  T: time,
  s: 'BTCUSDT',
  S: 'Buy',
  v: '1',
  p: '100000',
  i: String(time),
  seq: time,
  ...overrides,
});
const batch = (time, data, topic = 'publicTrade.BTCUSDT') => ({
  topic,
  type: 'snapshot',
  ts: time,
  data,
});
const ticker = (time, overrides = {}) => ({
  topic: 'tickers.BTCUSDT',
  type: 'snapshot',
  ts: time,
  data: {
    symbol: 'BTCUSDT',
    lastPrice: '100000',
    markPrice: '100002',
    indexPrice: '100001',
    openInterest: '1234',
    ...overrides,
  },
});
const subscription = { op: 'subscribe', success: true, req_id: 'btc-futures' };

function fillTrades(market, start, seconds, makeTrade = (time) => trade(time)) {
  for (let second = 0; second <= seconds; second += 1) {
    const time = start + second * 1000;
    market.apply(batch(time, [makeTrade(time, second)]), time);
  }
}

describe('Public futures observations', () => {
  let market;
  beforeEach(() => {
    market = createDerivativesMarket();
    market.reset(NOW);
  });

  test('uses taker side and rolling 15, 60, and 180 second BTC volumes', () => {
    fillTrades(market, NOW, 180, (time, second) =>
      trade(time, { S: second % 2 ? 'Sell' : 'Buy', v: second % 2 ? '3' : '1' }),
    );
    const snapshot = market.getSnapshot(NOW + 180_000, true);
    expect(snapshot.windows[15]).toMatchObject({
      available: true,
      tradeCount: 15,
      buyBtc: 8,
      sellBtc: 21,
      signedBtc: -13,
      totalBtc: 29,
    });
    expect(snapshot.windows[60]).toMatchObject({
      tradeCount: 60,
      buyBtc: 30,
      sellBtc: 90,
      imbalance: -0.5,
    });
    expect(snapshot.windows[180]).toMatchObject({ tradeCount: 180, buyBtc: 90, sellBtc: 270 });
  });

  test('returns unavailable nulls for warmup, stale data, and disconnected data', () => {
    fillTrades(market, NOW, 15);
    expect(market.getSnapshot(NOW + 14_000, true).windows[15].available).toBe(false);
    expect(market.getSnapshot(NOW + 21_000, true).windows[15]).toMatchObject({
      available: false,
      buyBtc: null,
      logReturn: null,
    });
    expect(market.getSnapshot(NOW + 15_000, false).windows[15].available).toBe(false);
    expect(market.getSnapshot(NOW + 15_000, true).windows[60].available).toBe(false);
  });

  test('accepts distinct trades with the same cross sequence and noncontiguous sequence jumps', () => {
    market.apply(batch(NOW, [trade(NOW, { i: 'a', seq: 10 })]), NOW);
    market.apply(batch(NOW + 1000, [trade(NOW + 1000, { i: 'b', seq: 10 })]), NOW + 1000);
    market.apply(batch(NOW + 2000, [trade(NOW + 2000, { i: 'c', seq: 500 })]), NOW + 2000);
    expect(market.getSnapshot(NOW + 2000, true).retainedTrades).toBe(3);
  });

  test('deduplicates repeated trade IDs while rejecting conflicting repeats', () => {
    const execution = trade(NOW);
    market.apply(batch(NOW, [execution, execution]), NOW);
    market.apply(batch(NOW + 1000, [execution]), NOW + 1000);
    expect(market.getSnapshot(NOW + 1000, true).retainedTrades).toBe(1);
    expect(() => market.apply(batch(NOW + 1000, [{ ...execution, v: '2' }]), NOW + 1000)).toThrow(
      'Conflicting',
    );
  });

  test('merges overlapping fresh batches belonging to the same cross sequence', () => {
    market.apply(batch(NOW + 2000, [trade(NOW + 2000, { i: 'later', seq: 10 })]), NOW + 2000);
    market.apply(batch(NOW + 2500, [trade(NOW + 1000, { i: 'earlier', seq: 10 })]), NOW + 2500);
    expect(market.getSnapshot(NOW + 2500, true)).toMatchObject({
      retainedTrades: 2,
      lastTradeAt: NOW + 2000,
    });
  });

  test('excludes off-book block trades from aggressive flow and observed price response', () => {
    fillTrades(market, NOW, 15);
    market.apply(
      batch(NOW + 15_000, [
        trade(NOW + 15_000, { i: 'block', BT: true, v: '500', p: '90000', S: 'Sell' }),
      ]),
      NOW + 15_000,
    );
    expect(market.getSnapshot(NOW + 15_000, true).windows[15]).toMatchObject({
      buyBtc: 15,
      sellBtc: 0,
      tradeCount: 15,
      logReturn: 0,
    });
  });

  test('distinguishes valid rolling volume from missing boundary prices', () => {
    market.apply(batch(NOW + 10_000, [trade(NOW + 10_000)]), NOW + 10_000);
    market.apply(batch(NOW + 15_000, [trade(NOW + 15_000)]), NOW + 15_000);
    expect(market.getSnapshot(NOW + 15_000, true).windows[15]).toMatchObject({
      available: true,
      buyBtc: 2,
      priceResponseAvailable: false,
      logReturn: null,
    });
  });

  test.each([
    ['foreign symbol', { s: 'ETHUSDT' }],
    ['maker-like side', { S: 'sell' }],
    ['zero volume', { v: '0' }],
    ['infinite price', { p: 'Infinity' }],
    ['numeric rather than decimal price', { p: 100000 }],
    ['negative volume', { v: '-1' }],
    ['missing ID', { i: undefined }],
    ['oversized ID', { i: 'x'.repeat(129) }],
    ['invalid sequence', { seq: -1 }],
    ['future time', { T: NOW + 2001 }],
    ['stale time', { T: NOW - 5001 }],
  ])('rejects %s', (_label, changes) => {
    expect(() => market.apply(batch(NOW, [trade(NOW, changes)]), NOW)).toThrow();
  });

  test('rejects regressed new executions and delayed message frames', () => {
    market.apply(batch(NOW + 2000, [trade(NOW + 2000)]), NOW + 2000);
    expect(() => market.apply(batch(NOW + 3000, [trade(NOW + 1000)]), NOW + 3000)).toThrow(
      'out of order',
    );
    expect(() => market.apply(batch(NOW, [trade(NOW)]), NOW + 6000)).toThrow('delayed');
  });

  test('measures long liquidations as sell pressure without treating bankruptcy price as a traded price', () => {
    fillTrades(market, NOW, 15);
    const liquidation = batch(
      NOW + 15_000,
      [
        trade(NOW + 15_000, { S: 'Buy', v: '3', p: '70000' }),
        trade(NOW + 15_000, { S: 'Sell', v: '2', p: '120000' }),
      ],
      'allLiquidation.BTCUSDT',
    );
    market.apply(liquidation, NOW + 15_000);
    market.apply(liquidation, NOW + 15_000);
    const snapshot = market.getSnapshot(NOW + 15_000, true);
    expect(snapshot.liquidations).toMatchObject({
      available: true,
      coverage: 'venue-reported',
      windows: { 15: { available: true, longBtc: 3, shortBtc: 2, count: 2 } },
    });
    expect(snapshot.windows[15].logReturn).toBe(0);
  });

  test('retains equal liquidation rows inside one frame and expires old liquidation windows', () => {
    const entry = trade(NOW + 1000, { S: 'Buy', v: '2' });
    market.apply(batch(NOW + 1000, [entry, entry], 'allLiquidation.BTCUSDT'), NOW + 1000);
    expect(market.getSnapshot(NOW + 15_000, true).liquidations.windows[15].longBtc).toBe(4);
    expect(market.getSnapshot(NOW + 17_000, true).liquidations.windows[15].count).toBe(0);
    expect(market.getSnapshot(NOW + 17_000, true).liquidations.windows[60].longBtc).toBeNull();
  });

  test('accepts fresh liquidation batches without assuming provider ordering guarantees', () => {
    market.apply(
      batch(
        NOW + 2000,
        [trade(NOW + 2000, { v: '2' }), trade(NOW + 1000, { v: '1' })],
        'allLiquidation.BTCUSDT',
      ),
      NOW + 2000,
    );
    expect(market.getSnapshot(NOW + 15_000, true).liquidations.windows[15]).toMatchObject({
      longBtc: 3,
      count: 2,
    });
  });

  test('classifies large trades against earlier activity, excluding the same burst', () => {
    for (let elapsed = 0; elapsed <= 90_000; elapsed += 500) {
      const time = NOW + elapsed;
      const isBurst = elapsed >= 76_000 && elapsed < 77_000;
      market.apply(batch(time, [trade(time, { v: isBurst ? '100' : '1' })]), time);
    }
    const window = market.getSnapshot(NOW + 90_000, true).windows[15];
    expect(window).toMatchObject({
      largeTradesAvailable: true,
      largeTradeCount: 2,
      largeBuyBtc: 200,
      largeSellBtc: 0,
    });
    expect(market.getSnapshot(NOW + 90_000, true).windows[60].largeTradesAvailable).toBe(false);
  });

  test('generates completed price-response buckets without using prices beyond their boundary', () => {
    fillTrades(market, NOW, 100, (time, second) => trade(time, { p: String(100000 + second) }));
    const snapshot = market.getSnapshot(NOW + 100_000, true);
    expect(snapshot.impact.samples).toHaveLength(6);
    expect(snapshot.impact.samples.at(-1)).toMatchObject({
      startAt: NOW + 75_000,
      endAt: NOW + 90_000,
      startPrice: 100075,
      endPrice: 100090,
      buyBtc: 15,
      sellBtc: 0,
      tradeCount: 15,
    });
    expect(snapshot.impact.samples.at(-1).logReturn).toBeCloseTo(Math.log(100090 / 100075));
    expect(snapshot.windows[15].logReturn).toBeCloseTo(Math.log(100100 / 100085));
  });

  test('merges ticker deltas into the snapshot and refuses incomplete initial deltas', () => {
    expect(() => market.apply({ ...ticker(NOW), type: 'delta' }, NOW)).toThrow('snapshot');
    market.apply(ticker(NOW), NOW);
    market.apply(
      { ...ticker(NOW + 1000), type: 'delta', data: { symbol: 'BTCUSDT', lastPrice: '100010' } },
      NOW + 1000,
    );
    expect(market.getSnapshot(NOW + 1000, true).ticker).toEqual({
      time: NOW + 1000,
      lastPrice: 100010,
      markPrice: 100002,
      indexPrice: 100001,
      openInterest: 1234,
    });
    expect(market.getSnapshot(NOW + 7000, true).ticker).toBeNull();
  });

  test('caps trade storage and removes expired history and deduplication state', () => {
    for (let elapsed = 0; elapsed <= 250_000; elapsed += 1000) {
      const time = NOW + elapsed;
      market.apply(batch(time, [trade(time)]), time);
    }
    expect(market.getSnapshot(NOW + 250_000, true).retainedTrades).toBe(241);
    const crowded = createDerivativesMarket();
    crowded.reset(NOW);
    for (let frame = 0; frame < 50; frame += 1) {
      crowded.apply(
        batch(
          NOW,
          Array.from({ length: 1000 }, (_entry, index) => trade(NOW, { i: `${frame}-${index}` })),
        ),
        NOW,
      );
    }
    expect(crowded.getSnapshot(NOW, true).retainedTrades).toBe(50_000);
    expect(() => crowded.apply(batch(NOW, [trade(NOW, { i: 'overflow' })]), NOW)).toThrow('buffer');
    expect(() =>
      market.apply(
        batch(
          NOW,
          Array.from({ length: 1025 }, () => trade(NOW)),
        ),
        NOW,
      ),
    ).toThrow('batch');
  });
});

describe('Public futures connection lifecycle', () => {
  let sockets;
  let stream;
  let updates;
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.send = jest.fn();
      this.close = jest.fn(() => {
        this.readyState = 3;
      });
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    emit(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    sockets = [];
    updates = jest.fn();
    stream = createDerivativesStream({ WebSocketImpl: FakeSocket, onUpdate: updates });
  });
  afterEach(() => {
    stream.stop();
    jest.useRealTimers();
  });

  function connect() {
    stream.start();
    sockets.at(-1).open();
    sockets.at(-1).emit(subscription);
    return sockets.at(-1);
  }

  test('subscribes only to public BTCUSDT channels and requires acknowledgement', () => {
    stream.start();
    const socket = sockets[0];
    socket.open();
    expect(socket.url).toBe('wss://stream.bybit.com/v5/public/linear');
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      op: 'subscribe',
      req_id: 'btc-futures',
      args: ['publicTrade.BTCUSDT', 'allLiquidation.BTCUSDT', 'tickers.BTCUSDT'],
    });
    socket.emit(batch(NOW, [trade(NOW)]));
    expect(stream.getSnapshot().quality.subscribed).toBe(false);
    expect(stream.getSnapshot().liquidations.available).toBe(false);
    socket.emit(subscription);
    expect(stream.getSnapshot().quality.subscribed).toBe(true);
  });

  test('retains a ticker snapshot sent before subscription acknowledgement', () => {
    stream.start();
    const socket = sockets[0];
    socket.open();
    socket.emit(ticker(NOW));
    socket.emit(subscription);
    socket.emit({
      ...ticker(NOW),
      type: 'delta',
      data: { symbol: 'BTCUSDT', lastPrice: '100005' },
    });
    expect(stream.getSnapshot().ticker).toMatchObject({ lastPrice: 100005, markPrice: 100002 });
    expect(stream.getSnapshot().quality.completeSince).toBe(NOW);
  });

  test('starts once and cleans up timers, listeners, and pending reconnects on stop', () => {
    const socket = connect();
    stream.start();
    expect(sockets).toHaveLength(1);
    socket.onerror();
    const count = updates.mock.calls.length;
    stream.stop();
    jest.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(updates).toHaveBeenCalledTimes(count);
    expect(jest.getTimerCount()).toBe(0);
    expect(socket.onmessage).toBeNull();
    expect(stream.getSnapshot().status).toBe('stopped');
  });

  test('sends heartbeat pings every20 seconds and reconnects after missed heartbeat replies', () => {
    const socket = connect();
    jest.advanceTimersByTime(20_000);
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ op: 'ping' }));
    socket.emit({ op: 'ping', ret_msg: 'pong', success: true });
    expect(stream.getSnapshot().quality.lastPongAt).toBe(NOW + 20_000);
    jest.advanceTimersByTime(46_000);
    expect(stream.getSnapshot().status).toBe('reconnecting');
  });

  test('clears observed history after a disconnected gap and restarts window warmup', () => {
    const socket = connect();
    for (let second = 0; second <= 16; second += 1) {
      jest.setSystemTime(NOW + second * 1000);
      socket.emit(batch(Date.now(), [trade(Date.now())]));
    }
    expect(stream.getSnapshot().windows[15].available).toBe(true);
    socket.onclose();
    expect(stream.getSnapshot().quality.completeSince).toBeNull();
    jest.advanceTimersByTime(1000);
    const next = sockets[1];
    next.open();
    next.emit(subscription);
    next.emit(batch(Date.now(), [trade(Date.now())]));
    expect(stream.getSnapshot().windows[15].available).toBe(false);
    expect(stream.getSnapshot().quality.retainedTrades).toBe(1);
  });

  test('retains healthy connection coverage through quiet trading without inventing fresh flow', () => {
    const socket = connect();
    socket.emit(batch(NOW, [trade(NOW)]));
    for (let elapsed = 1; elapsed <= 30; elapsed += 1) {
      jest.advanceTimersByTime(1000);
      socket.emit(ticker(Date.now()));
      if (elapsed === 20) socket.emit({ op: 'ping', ret_msg: 'pong', success: true });
    }
    expect(stream.getSnapshot()).toMatchObject({
      status: 'warming',
      quality: { reconnectCount: 0, completeSince: NOW },
      windows: { 15: { available: false } },
    });
    socket.emit(batch(Date.now(), [trade(Date.now())]));
    expect(stream.getSnapshot().windows[15].available).toBe(true);
  });

  test.each([
    ['rejected subscription', { ...subscription, success: false }],
    ['uncorrelated subscription', { ...subscription, req_id: 'other' }],
    ['malformed frame', null],
    ['wrong trade product', batch(NOW, [trade(NOW, { s: 'ETHUSDT' })])],
  ])('recovers from %s without retaining uncertain flow', (_label, message) => {
    const socket = connect();
    socket.emit(message);
    expect(stream.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      quality: { completeSince: null, retainedTrades: 0 },
    });
  });

  test('bounds frame volume, then reconnects with capped exponential backoff', () => {
    const socket = connect();
    for (let index = 0; index < 1001; index += 1) socket.emit({ op: 'pong' });
    expect(stream.getSnapshot().status).toBe('reconnecting');
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const count = sockets.length;
      jest.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(count);
      jest.advanceTimersByTime(1);
      expect(sockets).toHaveLength(count + 1);
      sockets.at(-1).onerror();
    }
  });

  test('rejects oversized and invalid JSON frames and times out an unconfirmed connection', () => {
    let socket = connect();
    socket.onmessage({ data: 'x'.repeat(1_000_001) });
    expect(stream.getSnapshot().quality.reason).toContain('frame limit');
    jest.advanceTimersByTime(1000);
    socket = sockets.at(-1);
    socket.open();
    socket.onmessage({ data: '{bad json' });
    expect(stream.getSnapshot().quality.reason).toContain('Malformed');
    jest.advanceTimersByTime(2000);
    jest.advanceTimersByTime(11_000);
    expect(stream.getSnapshot().quality.reason).toContain('timed out');
  });

  test('degrades to optional unavailable data when WebSocket support is absent', () => {
    const unsupported = createDerivativesStream({ WebSocketImpl: null });
    unsupported.start();
    expect(unsupported.getSnapshot()).toMatchObject({
      status: 'unavailable',
      quality: { available: false },
    });
    unsupported.stop();
  });
});
