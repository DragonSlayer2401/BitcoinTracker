import { createCoinbaseTrades } from '@/services/coinbase/stream/coinbaseTrades.service';

const START = Date.UTC(2026, 8, 9, 12, 0);
const liquidity = { available: false };
const match = (id, time, overrides = {}) => ({
  type: 'match',
  trade_id: id,
  time: new Date(time).toISOString(),
  price: '50000',
  size: '1',
  side: 'sell',
  ...overrides,
});
const heartbeat = (id, time) => ({
  type: 'heartbeat',
  last_trade_id: id,
  time: new Date(time).toISOString(),
});

describe('completed execution-impact observations', () => {
  test('records maker-inverted signed volume and verified boundary prices without partial intervals', () => {
    const feed = createCoinbaseTrades();
    feed.apply(match(1, START), START);
    feed.apply(match(2, START + 5000, { size: '3' }), START + 5000);
    feed.apply(match(3, START + 14000, { size: '1', side: 'buy', price: '50010' }), START + 14000);
    feed.apply(heartbeat(3, START + 15000), START + 15000);
    const impact = feed.getSnapshot(START + 15000, liquidity).impact;
    expect(impact).toMatchObject({
      available: true,
      asOf: START + 15000,
      completeSince: START,
      confirmedThrough: START + 15000,
      bucketSeconds: 15,
      samples: [
        {
          startAt: START,
          endAt: START + 15000,
          startPrice: 50000,
          endPrice: 50010,
          buyBtc: 3,
          sellBtc: 1,
          tradeCount: 2,
        },
      ],
    });
    feed.apply(match(4, START + 20000, { size: '100', price: '90000' }), START + 20000);
    feed.apply(heartbeat(4, START + 20000), START + 20000);
    expect(feed.getSnapshot(START + 20000, liquidity).impact.samples).toEqual(impact.samples);
  });

  test('requires fresh observed start and end prices and heartbeat confirmation', () => {
    const feed = createCoinbaseTrades();
    feed.apply(match(1, START), START);
    feed.apply(match(2, START + 1000), START + 1000);
    feed.apply(heartbeat(2, START + 15000), START + 15000);
    expect(feed.getSnapshot(START + 15000, liquidity).impact.samples).toEqual([]);
    feed.apply(match(3, START + 29000), START + 29000);
    feed.apply(heartbeat(3, START + 30000), START + 30000);
    expect(feed.getSnapshot(START + 30000, liquidity).impact.samples).toEqual([]);
  });

  test('does not use executions just after an exact interval boundary as its ending price', () => {
    const feed = createCoinbaseTrades();
    feed.apply(match(1, START), START);
    feed.apply(match(2, START + 14000, { price: '50001' }), START + 14000);
    feed.apply(
      match(3, START + 15000, { time: '2026-09-09T12:00:15.000500Z', price: '90000' }),
      START + 15001,
    );
    feed.apply(heartbeat(3, START + 16000), START + 16000);
    expect(feed.getSnapshot(START + 16000, liquidity).impact.samples[0]).toMatchObject({
      endPrice: 50001,
      tradeCount: 1,
    });
  });

  test('clears impact evidence on a missing execution instead of retaining a usable old fit', () => {
    const feed = createCoinbaseTrades();
    feed.apply(match(1, START), START);
    feed.apply(match(2, START + 14000), START + 14000);
    feed.apply(heartbeat(2, START + 15000), START + 15000);
    expect(feed.getSnapshot(START + 15000, liquidity).impact.available).toBe(true);
    expect(feed.apply(match(4, START + 16000), START + 16000)).toContain('gap');
    expect(feed.getSnapshot(START + 16000, liquidity).impact).toMatchObject({
      available: false,
      samples: [],
    });
  });
});
