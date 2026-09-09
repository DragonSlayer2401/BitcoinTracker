import { createCoinbaseOrderBook } from '@/services/coinbase/stream/coinbaseOrderBook.service';
import { createCoinbaseTrades } from '@/services/coinbase/stream/coinbaseTrades.service';
import { createCoinbaseStream } from '@/services/coinbase/stream/coinbaseStream.service';

const NOW = Date.UTC(2026, 8, 9, 12, 0);
const iso = (time) => new Date(time).toISOString();
const match = (id, time, overrides = {}) => ({
  type: 'match',
  product_id: 'BTC-USD',
  trade_id: id,
  time: iso(time),
  price: '50000',
  size: '1',
  side: 'sell',
  ...overrides,
});
const heartbeat = (id, time) => ({
  type: 'heartbeat',
  product_id: 'BTC-USD',
  last_trade_id: id,
  time: iso(time),
});
const snapshot = {
  type: 'snapshot',
  product_id: 'BTC-USD',
  bids: [
    ['49999', '4'],
    ['49975', '6'],
    ['49900', '10'],
  ],
  asks: [
    ['50001', '2'],
    ['50025', '8'],
    ['50100', '12'],
  ],
};
const l2update = (time, changes = []) => ({
  type: 'l2update',
  product_id: 'BTC-USD',
  time: iso(time),
  changes,
});
const ticker = (time) => ({
  type: 'ticker',
  product_id: 'BTC-USD',
  time: iso(time),
  price: '50000',
  best_bid: '49999',
  best_ask: '50001',
  volume_24h: '100',
});
const subscriptions = {
  type: 'subscriptions',
  channels: ['matches', 'heartbeat', 'ticker', 'level2_50'].map((name) => ({
    name,
    product_ids: ['BTC-USD'],
  })),
};
const liquidity = {
  available: true,
  depth: { 10: { bidBtc: 10, askBtc: 10, totalBtc: 20, imbalance: 0 } },
};

describe('Coinbase executed trade completeness', () => {
  test('inverts the maker side and distinguishes complete zero-trade windows from warmup', () => {
    const feed = createCoinbaseTrades();
    expect(feed.apply({ type: 'last_match', trade_id: 100 }, NOW)).toBeNull();
    feed.apply(heartbeat(100, NOW), NOW);
    expect(feed.getSnapshot(NOW, liquidity).windows[15]).toMatchObject({
      available: false,
      tradeCount: null,
    });
    feed.apply(heartbeat(100, NOW + 15_000), NOW + 15_000);
    expect(feed.getSnapshot(NOW + 15_000, liquidity).windows[15]).toMatchObject({
      available: true,
      tradeCount: 0,
      totalBtc: 0,
      imbalance: 0,
    });
    feed.apply(match(101, NOW + 16_000, { side: 'sell', size: '3' }), NOW + 16_000);
    feed.apply(match(102, NOW + 17_000, { side: 'buy', size: '1' }), NOW + 17_000);
    feed.apply(heartbeat(102, NOW + 17_000), NOW + 17_000);
    expect(feed.getSnapshot(NOW + 17_000, liquidity).windows[15]).toMatchObject({
      available: true,
      tradeCount: 2,
      buyBtc: 3,
      sellBtc: 1,
      signedBtc: 2,
      imbalance: 0.5,
    });
  });

  test('does not count last_match, duplicates, or global sequence gaps as executions', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ ...match(10, NOW), type: 'last_match' }, NOW);
    const trade = match(11, NOW + 1000, { sequence: 100 });
    expect(feed.apply(trade, NOW + 1000)).toBeNull();
    expect(feed.apply(trade, NOW + 2000)).toBeNull();
    expect(feed.apply(match(12, NOW + 3000, { sequence: 500 }), NOW + 3000)).toBeNull();
    feed.apply(heartbeat(12, NOW + 15_000), NOW + 15_000);
    expect(feed.getSnapshot(NOW + 15_000, liquidity).windows[15].tradeCount).toBe(2);
  });

  test.each([
    ['missing trade id', match(13, NOW + 2000)],
    ['regressed trade id', match(9, NOW + 2000)],
    ['conflicting duplicate', match(11, NOW + 1000, { price: '49999' })],
    ['regressed exchange time', match(12, NOW + 999)],
    ['future trade', match(12, NOW + 5001)],
    ['negative size', match(12, NOW + 2000, { size: '-1' })],
    ['non-numeric price', match(12, NOW + 2000, { price: 'nan' })],
    ['unknown maker side', match(12, NOW + 2000, { side: 'unknown' })],
  ])('fails closed for %s', (_label, message) => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(match(11, NOW + 1000), NOW + 1000);
    expect(feed.apply(message, NOW + 2000)).toEqual(expect.any(String));
    expect(feed.getSnapshot(NOW + 20_000, liquidity).windows[15].available).toBe(false);
    expect(feed.getQuality(NOW + 2000).completeSince).toBeNull();
  });

  test('heartbeat evidence waits briefly for in-flight matches, then requests reconnect for a missing trade', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(heartbeat(11, NOW + 1000), NOW + 1000);
    expect(feed.getQuality(NOW + 1000)).toMatchObject({ available: false, needsReconnect: false });
    feed.apply(match(11, NOW + 999), NOW + 1100);
    expect(feed.getQuality(NOW + 1100)).toMatchObject({
      available: true,
      confirmedThrough: NOW + 1000,
    });
    feed.apply(heartbeat(12, NOW + 2000), NOW + 2000);
    expect(feed.getQuality(NOW + 4001)).toMatchObject({ available: false, needsReconnect: true });
  });

  test('waits for a heartbeat beyond the deadline and returns the last prior trade only', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(match(11, NOW + 9000, { price: '49990' }), NOW + 9000);
    feed.apply(heartbeat(11, NOW + 10_000), NOW + 10_000);
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 10_000).status).toBe('waiting');
    feed.apply(match(12, NOW + 10_001, { price: '51000' }), NOW + 10_001);
    feed.apply(heartbeat(12, NOW + 11_000), NOW + 11_000);
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 11_000)).toEqual({
      status: 'observed',
      reason: null,
      observedPrice: 49990,
      observedAt: NOW + 9000,
      observedTradeId: 11,
      confirmedThrough: NOW + 11_000,
      completeSince: NOW,
    });
  });

  test('a heartbeat cannot certify a deadline while omitting an already observed prior trade', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(match(11, NOW + 1000), NOW + 1000);
    expect(feed.apply(heartbeat(10, NOW + 2000), NOW + 2000)).toContain('conflicts');
    expect(feed.getDeadlineOutcome(NOW + 1500, NOW + 2000).status).toBe('waiting');
    expect(feed.getQuality(NOW + 2000).available).toBe(false);
  });

  test.each([
    [10, NOW + 2000, 11, NOW + 1000],
    [11, NOW + 1000, 11, NOW + 2000],
  ])(
    'rejects a later-arriving trade that contradicts heartbeat id %i',
    (marker, heartbeatTime, tradeId, tradeTime) => {
      const feed = createCoinbaseTrades();
      feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
      feed.apply(heartbeat(marker, heartbeatTime), NOW + 2000);
      expect(feed.apply(match(tradeId, tradeTime), NOW + 2100)).toContain('conflicts');
      expect(feed.getQuality(NOW + 2100).available).toBe(false);
    },
  );

  test('retains sub-millisecond ordering and excludes a trade just after an exact deadline', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(match(11, NOW + 9000, { price: '49990' }), NOW + 9000);
    feed.apply(heartbeat(11, NOW + 10_000), NOW + 10_000);
    expect(
      feed.apply(
        match(12, NOW + 10_000, {
          time: iso(NOW + 10_000).replace('.000Z', '.000530Z'),
          price: '51000',
        }),
        NOW + 10_001,
      ),
    ).toBeNull();
    feed.apply(heartbeat(12, NOW + 11_000), NOW + 11_000);
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 11_000)).toMatchObject({
      status: 'observed',
      observedPrice: 49990,
      observedTradeId: 11,
    });
  });

  test('rejects a heartbeat whose own referenced execution happened after its timestamp', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(match(11, NOW + 1200), NOW + 1200);
    expect(feed.apply(heartbeat(11, NOW + 1000), NOW + 1300)).toContain('conflicts');
  });

  test('rejects heartbeat time regression within the same millisecond', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    const marker = heartbeat(10, NOW + 1000);
    expect(
      feed.apply({ ...marker, time: marker.time.replace('.000Z', '.000700Z') }, NOW + 1001),
    ).toBeNull();
    expect(
      feed.apply({ ...marker, time: marker.time.replace('.000Z', '.000600Z') }, NOW + 1002),
    ).toContain('regressed');
  });

  test.each([0, 5000])('accepts a trade exactly %i ms before the deadline', (age) => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 10 }, NOW);
    feed.apply(match(11, NOW + 10_000 - age), NOW + 10_000 - age);
    feed.apply(heartbeat(11, NOW + 11_000), NOW + 11_000);
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 11_000)).toMatchObject({
      status: 'observed',
      observedAt: NOW + 10_000 - age,
    });
  });

  test('does not settle with stale prices, last_match, post-end reconnects or missing confirmation', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ ...match(10, NOW), type: 'last_match' }, NOW);
    feed.apply(heartbeat(10, NOW + 11_000), NOW + 11_000);
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 11_000).status).toBe('unobserved');
    feed.apply(match(11, NOW + 12_000), NOW + 12_000);
    feed.apply(heartbeat(11, NOW + 19_000), NOW + 19_000);
    expect(feed.getDeadlineOutcome(NOW + 18_000, NOW + 19_000).status).toBe('unobserved');
    feed.reset();
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 26_000).status).toBe('unobserved');
    feed.apply({ type: 'last_match', trade_id: 12 }, NOW + 27_000);
    expect(feed.getDeadlineOutcome(NOW + 10_000, NOW + 27_000).status).toBe('unobserved');
  });

  test('adapts large trades to prior trade sizes and opposing depth, preserving classified bursts', () => {
    const feed = createCoinbaseTrades();
    feed.apply({ type: 'last_match', trade_id: 0 }, NOW);
    let id = 0;
    for (let elapsed = 500; elapsed <= 120_000; elapsed += 500) {
      id += 1;
      feed.apply(
        match(id, NOW + elapsed, { size: elapsed >= 110_000 && elapsed <= 111_000 ? '5' : '1' }),
        NOW + elapsed,
      );
      if (elapsed % 1000 === 0) {
        feed.apply(heartbeat(id, NOW + elapsed), NOW + elapsed);
        feed.getSnapshot(NOW + elapsed, liquidity);
      }
    }
    const flow = feed.getSnapshot(NOW + 120_000, liquidity);
    expect(flow.largeTrades).toMatchObject({
      available: true,
      thresholdBtc: 4,
      count60: 3,
      buyCount60: 3,
      sellCount60: 0,
      burstCount60: 1,
    });
    const deepBook = { available: true, depth: { 10: { bidBtc: 1000, askBtc: 2000 } } };
    const adjusted = feed.getSnapshot(NOW + 120_000, deepBook);
    expect(adjusted.largeTrades).toMatchObject({
      buyThresholdBtc: 100,
      sellThresholdBtc: 50,
      count60: 3,
      burstCount60: 1,
    });
  });
});

describe('Coinbase level 2 liquidity', () => {
  test('replaces absolute quantities, removes zero levels, and measures depth around the midpoint', () => {
    const book = createCoinbaseOrderBook();
    expect(book.apply(snapshot, NOW)).toBeNull();
    let result = book.getSnapshot(NOW);
    expect(result).toMatchObject({ available: true, bid: 49999, ask: 50001, snapshotAt: NOW });
    expect(result.spreadBps).toBeCloseTo(0.4);
    expect(result.depth[5]).toMatchObject({ bidBtc: 10, askBtc: 10, imbalance: 0 });
    expect(result.depth[25]).toMatchObject({ bidBtc: 20, askBtc: 22, totalBtc: 42 });
    expect(
      book.apply(
        l2update(NOW + 1000, [
          ['buy', '49999', '1'],
          ['sell', '50001', '0'],
        ]),
        NOW + 1000,
      ),
    ).toBeNull();
    result = book.getSnapshot(NOW + 1000);
    expect(result.bid).toBe(49999);
    expect(result.ask).toBe(50025);
    expect(result.depth[10].bidBtc).toBe(7);
  });

  test.each([
    { ...snapshot, asks: [['49998', '1']] },
    { ...snapshot, bids: [['49999', 'NaN']] },
    {
      ...snapshot,
      bids: [
        ['49999', '1'],
        ['49999.00', '2'],
      ],
    },
    { ...snapshot, bids: [] },
    l2update(NOW + 1000, [['buy', '50010', '2']]),
    l2update(NOW + 1000, [['invalid', '49999', '1']]),
    l2update(NOW + 1000, [['buy', '49999', '-1']]),
    { ...l2update(NOW), time: 'invalid' },
  ])('invalid or crossed books discard the snapshot %#', (message) => {
    const book = createCoinbaseOrderBook();
    book.apply(snapshot, NOW);
    expect(book.apply(message, NOW + 1000)).toEqual(expect.any(String));
    expect(book.getSnapshot(NOW + 1000).available).toBe(false);
  });

  test('rejects updates without a snapshot, old event time and stale books', () => {
    const book = createCoinbaseOrderBook();
    expect(book.apply(l2update(NOW), NOW)).toEqual(expect.any(String));
    book.apply(snapshot, NOW);
    book.apply(l2update(NOW + 2000), NOW + 2000);
    expect(book.apply(l2update(NOW + 1000), NOW + 3000)).toEqual(expect.any(String));
    book.apply(snapshot, NOW);
    expect(book.getSnapshot(NOW + 10_001).available).toBe(false);
  });

  test('receiving an already-aged update does not reset its exchange-time freshness', () => {
    const book = createCoinbaseOrderBook();
    book.apply(snapshot, NOW);
    book.apply(l2update(NOW), NOW + 9000);
    expect(book.getSnapshot(NOW + 9000).available).toBe(true);
    expect(book.getSnapshot(NOW + 10_001).available).toBe(false);
  });

  test('reports one-minute depth changes without claiming removed liquidity was spoofing', () => {
    const book = createCoinbaseOrderBook();
    book.apply(snapshot, NOW);
    expect(book.getSnapshot(NOW).depthChange60.available).toBe(false);
    for (let elapsed = 1000; elapsed <= 60_000; elapsed += 1000) {
      book.apply(
        l2update(NOW + elapsed, elapsed === 60_000 ? [['buy', '49999', '2']] : []),
        NOW + elapsed,
      );
      book.getSnapshot(NOW + elapsed);
    }
    const change = book.getSnapshot(NOW + 60_000).depthChange60;
    expect(change).toMatchObject({
      available: true,
      bidBtc: -2,
      askBtc: 0,
    });
    expect(change.bidFraction).toBeCloseTo(-0.2);
    expect(change.totalFraction).toBeCloseTo(-0.1);
  });
});

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.send = jest.fn();
    this.close = jest.fn(() => {
      this.readyState = 3;
    });
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('Coinbase stream connection lifecycle', () => {
  let stream;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    FakeSocket.instances = [];
  });
  afterEach(() => {
    stream?.stop();
    jest.useRealTimers();
  });

  test('subscribes to public channels, accepts level2_50 acknowledgement and publishes at one-second intervals', () => {
    const onUpdate = jest.fn();
    stream = createCoinbaseStream({ onUpdate, WebSocketImpl: FakeSocket, random: () => 0 });
    stream.start();
    const socket = FakeSocket.instances[0];
    socket.open();
    expect(JSON.parse(socket.send.mock.calls[0][0]).channels).toContain('level2_batch');
    socket.message(subscriptions);
    socket.message(snapshot);
    socket.message({ type: 'last_match', product_id: 'BTC-USD', trade_id: 10 });
    socket.message(heartbeat(10, NOW));
    socket.message(ticker(NOW));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls.at(-1)[0]).toMatchObject({
      status: 'warming',
      ticker: { price: 50000 },
      quality: { available: false, flowReadySeconds: 1 },
      liquidity: { available: true },
    });
  });

  test('clears flow, ticker and book on disconnect and ignores callbacks from the retired socket', () => {
    stream = createCoinbaseStream({ WebSocketImpl: FakeSocket, random: () => 0 });
    stream.start();
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.message(subscriptions);
    socket.message(snapshot);
    socket.message(ticker(NOW));
    const retiredCallback = socket.onmessage;
    socket.onclose();
    expect(stream.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      ticker: null,
      quality: { available: false },
      liquidity: { available: false },
    });
    retiredCallback({ data: JSON.stringify(snapshot) });
    expect(stream.getSnapshot().liquidity.available).toBe(false);
    jest.advanceTimersByTime(800);
    expect(FakeSocket.instances).toHaveLength(2);
    const next = FakeSocket.instances[1];
    next.open();
    next.message(subscriptions);
    expect(stream.getSnapshot().liquidity.available).toBe(false);
    next.message(snapshot);
    expect(stream.getSnapshot().liquidity.available).toBe(true);
  });

  test.each(['handshake', 'heartbeat', 'malformed', 'subscription'])(
    'reconnects when %s validation fails',
    (failure) => {
      stream = createCoinbaseStream({ WebSocketImpl: FakeSocket, random: () => 0 });
      stream.start();
      const socket = FakeSocket.instances[0];
      socket.open();
      if (failure === 'handshake') jest.advanceTimersByTime(11_000);
      if (failure === 'heartbeat') {
        socket.message(subscriptions);
        socket.message(heartbeat(10, NOW));
        jest.advanceTimersByTime(6000);
      }
      if (failure === 'malformed') socket.onmessage({ data: 'not-json' });
      if (failure === 'subscription') socket.message({ ...subscriptions, channels: [] });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(stream.getSnapshot().status).toBe('reconnecting');
    },
  );

  test('unmount cleanup cancels timers, closes the socket and prevents further updates', () => {
    const onUpdate = jest.fn();
    stream = createCoinbaseStream({ WebSocketImpl: FakeSocket, onUpdate });
    stream.start();
    const socket = FakeSocket.instances[0];
    stream.stop();
    const calls = onUpdate.mock.calls.length;
    jest.advanceTimersByTime(60_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(calls);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('backs off repeated failures and caps reconnect delays at thirty seconds', () => {
    stream = createCoinbaseStream({ WebSocketImpl: FakeSocket, random: () => 0 });
    stream.start();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const socket = FakeSocket.instances.at(-1);
      socket.onerror();
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * 0.8;
      const count = FakeSocket.instances.length;
      jest.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(count);
      jest.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(count + 1);
    }
  });

  test('reports unsupported WebSocket without starting retry timers', () => {
    stream = createCoinbaseStream({ WebSocketImpl: null });
    stream.start();
    expect(stream.getSnapshot()).toMatchObject({ status: 'unavailable', ticker: null });
    expect(jest.getTimerCount()).toBe(0);
  });
});
