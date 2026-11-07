const createImpactSamples = (now) =>
  Array.from({ length: 12 }, (_, index) => {
    const signedBtc = index % 2 ? 2 : -2;
    return {
      startAt: now - (12 - index) * 15_000,
      endAt: now - (11 - index) * 15_000,
      startPrice: 50_000,
      endPrice: 50_000 * Math.exp(signedBtc * 0.0001),
      buyBtc: signedBtc > 0 ? 3 : 1,
      sellBtc: signedBtc > 0 ? 1 : 3,
      tradeCount: 20,
    };
  });

const createFlowWindows = (direction) =>
  Object.fromEntries(
    [15, 60, 180].map((seconds) => {
      const buyBtc = ((direction === 'buy' ? 3 : 1) * seconds) / 15;
      const sellBtc = ((direction === 'buy' ? 1 : 3) * seconds) / 15;
      return [
        seconds,
        {
          available: true,
          buyBtc,
          sellBtc,
          totalBtc: buyBtc + sellBtc,
          signedBtc: buyBtc - sellBtc,
          imbalance: (buyBtc - sellBtc) / (buyBtc + sellBtc),
          tradeCount: (20 * seconds) / 15,
          logReturn: ((direction === 'buy' ? 1 : -1) * 0.00025 * seconds) / 15,
          largeTradesAvailable: false,
        },
      ];
    }),
  );

// Completed 15-second exchange buckets contain a measurable execution/price fit.
// Live flow direction is independent from those historical calibration buckets.
export const createFuturesSnapshot = (now, direction) => ({
  version: 'bybit-linear-flow-v1',
  source: 'bybit-linear',
  symbol: 'BTCUSDT',
  status: 'live',
  asOf: now,
  quality: {
    subscribed: true,
    completeSince: now - 240_000,
    lastMessageAt: now,
    lastTradeAt: now,
  },
  windows: createFlowWindows(direction),
  impact: {
    available: true,
    asOf: now,
    completeSince: now - 240_000,
    bucketSeconds: 15,
    samples: createImpactSamples(now),
  },
  ticker: { time: now, markPrice: 50_010, indexPrice: 50_000, openInterest: 100_000 },
});

export const createSpotStream = (now, direction) => ({
  status: 'live',
  quality: {
    available: true,
    heartbeatAt: now,
    completeSince: now - 240_000,
    confirmedThrough: now,
  },
  flow: {
    windows: createFlowWindows(direction),
    impact: {
      available: true,
      asOf: now,
      completeSince: now - 240_000,
      confirmedThrough: now,
      bucketSeconds: 15,
      samples: createImpactSamples(now),
    },
  },
  liquidity: { available: false },
});
