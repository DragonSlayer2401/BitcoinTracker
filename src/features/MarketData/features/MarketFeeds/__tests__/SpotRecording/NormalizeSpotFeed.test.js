import { createCoinbaseSpotNormalizer } from '@/services/coinbase/recording/coinbaseSpotNormalizer.utils';
import { createCoinbaseStream } from '@/services/coinbase/stream/coinbaseStream.service';

// Synthetic Coinbase-shaped frames. They are not captured historical market evidence.
const startTime = Date.parse('2026-11-06T23:59:59.000Z');
const frame = (message, receivedAt = startTime, connectionId = 1) => ({
  kind: 'message',
  receivedAt,
  connectionId,
  payload: JSON.stringify(message),
});
const ticker = (overrides = {}) => ({
  type: 'ticker',
  product_id: 'BTC-USD',
  sequence: 200,
  trade_id: 10,
  time: new Date(startTime).toISOString(),
  price: '69999.12345678',
  best_bid: '69998.12345678',
  best_ask: '70000.00000001',
  best_bid_size: '0.00000001',
  best_ask_size: '2.30000000',
  ...overrides,
});
const heartbeat = (overrides = {}) => ({
  type: 'heartbeat',
  product_id: 'BTC-USD',
  sequence: 199,
  last_trade_id: 10,
  time: new Date(startTime).toISOString(),
  ...overrides,
});
const trade = (overrides = {}) => ({
  type: 'match',
  product_id: 'BTC-USD',
  sequence: 201,
  trade_id: 11,
  time: new Date(startTime).toISOString(),
  price: '69999.12345678',
  size: '0.00000001',
  side: 'sell',
  ...overrides,
});
const subscribe = (normalizer, receivedAt = startTime, connectionId = 1) => {
  normalizer.apply({ kind: 'connection', state: 'connecting', receivedAt, connectionId });
  normalizer.apply({ kind: 'connection', state: 'connected', receivedAt, connectionId });
  normalizer.apply(
    frame(
      {
        type: 'subscriptions',
        channels: ['matches', 'heartbeat', 'ticker', 'level2_batch'].map((name) => ({
          name,
          product_ids: ['BTC-USD'],
        })),
      },
      receivedAt,
      connectionId,
    ),
  );
};
const readyFeed = () => {
  const normalizer = createCoinbaseSpotNormalizer();
  subscribe(normalizer);
  normalizer.apply(frame(heartbeat()));
  normalizer.apply(frame(ticker()));
  return normalizer;
};

describe('Capture one Coinbase spot feed for replay', () => {
  it('preserves exact decimal values and distinguishes proxy source time from receipt time across midnight', () => {
    const normalizer = readyFeed();
    const result = normalizer.apply(
      frame(trade({ time: '2026-11-06T23:59:59.999999Z' }), startTime + 1001),
    );
    expect(result.observation).toMatchObject({
      source: { id: 'coinbase-btc-usd', kind: 'proxy' },
      instrument: 'BTC-USD',
      eventTime: '2026-11-06T23:59:59.999999Z',
      time: startTime + 999,
      receivedAt: startTime + 1001,
      delayMs: 2,
      price: '69999.12345678',
      size: '0.00000001',
      makerSide: 'sell',
      aggressorSide: 'buy',
      sequence: '201',
      tradeId: '11',
      priceUnit: 'USD/BTC',
      quantityUnit: 'BTC',
    });
    expect(result.health.available).toBe(true);
  });

  it('retains the original quote receipt and removes stale quotes instead of refreshing duplicate frames', () => {
    const normalizer = readyFeed();
    const duplicate = normalizer.apply(frame(ticker(), startTime + 5001));
    expect(duplicate.disposition).toBe('duplicate');
    expect(duplicate.observation).toBeNull();
    expect(normalizer.getSnapshot(startTime + 5001)).toMatchObject({
      available: false,
      latestQuote: null,
    });
    expect(normalizer.getSnapshot(startTime).latestQuote.receivedAt).toBe(startTime);
  });

  it('detects a missing trade but does not infer gaps from selected ticker sequence jumps', () => {
    const normalizer = readyFeed();
    const quote = normalizer.apply(
      frame(ticker({ sequence: 9000, time: new Date(startTime + 1).toISOString() }), startTime + 1),
    );
    expect(quote.gaps).toEqual([]);
    expect(quote.health.available).toBe(true);
    const gap = normalizer.apply(frame(trade({ trade_id: 12, sequence: 9500 }), startTime + 2));
    expect(gap.gaps).toEqual([{ kind: 'trade_id_gap', fromTradeId: '11', throughTradeId: '11' }]);
    expect(gap.health).toMatchObject({ available: false, latestQuote: null, hasGap: true });
  });

  it('waits for heartbeat-confirmed trades and uses recorded clock input to report an unresolved gap', () => {
    const normalizer = readyFeed();
    normalizer.apply(
      frame(
        heartbeat({ last_trade_id: 12, time: new Date(startTime + 1).toISOString() }),
        startTime + 1,
      ),
    );
    expect(normalizer.getSnapshot(startTime + 1).reason).toBe('unconfirmed_trades');
    const elapsed = normalizer.apply({
      kind: 'clock',
      receivedAt: startTime + 2002,
      connectionId: 1,
    });
    expect(elapsed.gaps).toEqual([
      { kind: 'heartbeat_trade_gap', fromTradeId: '11', throughTradeId: '12' },
    ]);
    expect(elapsed.health.latestQuote).toBeNull();
  });

  it('allows in-flight trades to arrive during the heartbeat grace interval', () => {
    const normalizer = readyFeed();
    normalizer.apply(
      frame(
        heartbeat({ last_trade_id: 11, time: new Date(startTime + 1).toISOString() }),
        startTime + 1,
      ),
    );
    const result = normalizer.apply(frame(trade(), startTime + 2));
    expect(result.health.available).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('ignores microsecond regressions without replacing a newer quote', () => {
    const normalizer = readyFeed();
    normalizer.apply(
      frame(ticker({ sequence: 201, time: '2026-11-06T23:59:59.000900Z' }), startTime + 1),
    );
    const result = normalizer.apply(
      frame(
        ticker({ sequence: 202, time: '2026-11-06T23:59:59.000100Z', price: '1' }),
        startTime + 2,
      ),
    );
    expect(result.disposition).toBe('out_of_order');
    expect(result.gaps).toEqual([{ kind: 'out_of_order', messageType: 'ticker' }]);
    expect(result.health.latestQuote.price).toBe('69999.12345678');
  });

  it('does not expose a quote whose source fraction is later than the receipt clock', () => {
    const normalizer = readyFeed();
    const result = normalizer.apply(
      frame(ticker({ sequence: 201, time: '2026-11-06T23:59:59.000001Z' })),
    );
    expect(result.observation.delayNanoseconds).toBe('-1000');
    expect(result.health.latestQuote).toBeNull();
    expect(normalizer.getSnapshot(startTime + 1).available).toBe(true);
  });

  it('fails quote availability when the local receipt clock regresses, including at disconnect', () => {
    const normalizer = readyFeed();
    const result = normalizer.apply({
      kind: 'connection',
      state: 'reconnecting',
      connectionId: 1,
      receivedAt: startTime - 1,
    });
    expect(result).toMatchObject({
      disposition: 'out_of_order',
      notes: ['receipt_time_regressed'],
    });
    expect(result.health).toMatchObject({ hasGap: true, available: false, latestQuote: null });
  });

  it('does not reuse a previous connection quote and keeps event deduplication across reconnects', () => {
    const normalizer = readyFeed();
    normalizer.apply(frame(trade()));
    const lost = normalizer.apply({
      kind: 'connection',
      state: 'reconnecting',
      receivedAt: startTime + 1,
      connectionId: 1,
      reason: 'synthetic_disconnect',
    });
    expect(lost.health.latestQuote).toBeNull();
    expect(lost.gaps[0].kind).toBe('disconnect');
    subscribe(normalizer, startTime + 2, 2);
    expect(normalizer.apply(frame(trade(), startTime + 2, 2)).disposition).toBe('duplicate');
    expect(normalizer.getSnapshot(startTime + 2).latestQuote).toBeNull();
    expect(normalizer.apply(frame(ticker({ sequence: 300 }), startTime + 3, 1)).disposition).toBe(
      'ignored',
    );
  });

  it('records malformed, unsafe identifier and conflicting duplicate frames without inventing observations', () => {
    const malformed = readyFeed().apply({
      kind: 'message',
      connectionId: 1,
      receivedAt: startTime,
      payload: '{bad',
    });
    expect(malformed).toMatchObject({
      disposition: 'invalid',
      observation: null,
      notes: ['malformed_json'],
    });
    const unsafe = readyFeed().apply(frame(trade({ sequence: Number.MAX_SAFE_INTEGER + 1 })));
    expect(unsafe.notes).toContain('invalid_sequence');
    const normalizer = readyFeed();
    normalizer.apply(frame(trade()));
    expect(normalizer.apply(frame(trade({ size: '1' }))).notes).toContain('conflicting_event_id');
  });

  it('labels level2 snapshot missing timestamps and preserves batch absolute sizes without inventing continuity', () => {
    const normalizer = readyFeed();
    const snapshot = normalizer.apply(
      frame({
        type: 'snapshot',
        product_id: 'BTC-USD',
        bids: [['1.00', '0.1']],
        asks: [['2.00', '0.2']],
      }),
    );
    expect(snapshot.observation).toMatchObject({
      time: null,
      eventTime: null,
      sequence: null,
      bids: [{ price: '1.00', size: '0.1' }],
    });
    expect(snapshot.notes).toContain('source_timestamp_unavailable');
    const update = normalizer.apply(
      frame({
        type: 'l2update',
        product_id: 'BTC-USD',
        time: new Date(startTime).toISOString(),
        changes: [['buy', '1.00', '0']],
      }),
    );
    expect(update.observation.changes).toEqual([{ side: 'buy', price: '1.00', size: '0' }]);
    expect(update.notes).toContain('batch_timestamp_is_latest_event');
  });
});

describe('Capture raw frames through the existing transport', () => {
  let sockets;
  class FakeSocket {
    constructor() {
      this.readyState = 0;
      sockets.push(this);
    }
    send = jest.fn();
    close = () => {
      this.readyState = 3;
    };
  }
  beforeEach(() => {
    sockets = [];
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('captures invalid source text before parsing and records reconnect lifecycle and clock inputs', () => {
    const captured = [];
    const stream = createCoinbaseStream({
      WebSocketImpl: FakeSocket,
      onCapture: (input) => captured.push(input),
      now: () => startTime,
      random: () => 0,
    });
    stream.start();
    sockets[0].onopen();
    sockets[0].onmessage({ data: '{invalid raw text' });
    expect(
      captured.map((input) => (input.kind === 'connection' ? input.state : input.kind)),
    ).toEqual(['connecting', 'connected', 'message', 'reconnecting']);
    expect(captured[2]).toEqual({
      kind: 'message',
      receivedAt: startTime,
      connectionId: 1,
      payload: '{invalid raw text',
    });
    jest.advanceTimersByTime(1000);
    expect(captured.some((input) => input.kind === 'clock')).toBe(true);
    stream.stop();
    expect(captured.at(-1).state).toBe('stopped');
  });

  it('stops immediately when the capture consumer fails instead of retrying and hiding lost recording', () => {
    const stream = createCoinbaseStream({
      WebSocketImpl: FakeSocket,
      now: () => startTime,
      onCapture: (input) => {
        if (input.kind === 'message') throw new Error('synthetic disk failure');
      },
    });
    stream.start();
    sockets[0].onopen();
    expect(() => sockets[0].onmessage({ data: '{}' })).toThrow('synthetic disk failure');
    expect(sockets[0].readyState).toBe(3);
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(stream.getSnapshot().status).toBe('unavailable');
  });
});
