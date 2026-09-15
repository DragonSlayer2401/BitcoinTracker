import { getResearchForecast } from '../utils/researchForecast.utils';
import {
  createResearchInputSnapshot,
  replayResearchInputSnapshot,
  RESEARCH_VARIANT_NAMES,
} from '../utils/researchExperiments.utils';
import { getKalshiForecast } from '../utils/kalshi/forecast.utils';
import { getEvidenceRow } from '../utils/evidenceStorage.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const MINUTE = 60_000;
const END = Date.UTC(2026, 8, 14, 12, 15);
const NOW = END - 5 * MINUTE;
const START = END - 15 * MINUTE;

function pressureWindows(direction = 1) {
  return Object.fromEntries(
    [15, 60, 180].map((seconds) => {
      const buyBtc = ((direction > 0 ? 3 : 1) * seconds) / 15;
      const sellBtc = ((direction > 0 ? 1 : 3) * seconds) / 15;
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
          logReturn: (direction * 0.00025 * seconds) / 15,
          priceResponseAvailable: true,
          largeTradesAvailable: false,
        },
      ];
    }),
  );
}

function impact() {
  return {
    available: true,
    asOf: NOW,
    completeSince: NOW - 240_000,
    confirmedThrough: NOW,
    bucketSeconds: 15,
    samples: Array.from({ length: 12 }, (_, index) => {
      const signed = index % 2 ? 2 : -2;
      return {
        startAt: NOW - (12 - index) * 15_000,
        endAt: NOW - (11 - index) * 15_000,
        startPrice: 50_000,
        endPrice: 50_000 * Math.exp(signed * 0.0001),
        buyBtc: signed > 0 ? 3 : 1,
        sellBtc: signed > 0 ? 1 : 3,
        tradeCount: 20,
      };
    }),
  };
}

function input() {
  let price = 50_000;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price;
    price *= Math.exp(index % 2 ? 0.001 : -0.001);
    return {
      time: NOW - (120 - index) * MINUTE,
      open,
      high: Math.max(open, price) * 1.0001,
      low: Math.min(open, price) / 1.0001,
      close: price,
      volume: 10,
    };
  });
  const readings = Array.from({ length: 1201 }, (_, index) => ({
    time: NOW - (1200 - index) * 1000,
    price: 50_000 * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
  }));
  return {
    now: NOW,
    candles,
    ticker: { price, bid: price - 1, ask: price + 1, time: NOW, receivedAt: NOW, volume: 100 },
    kalshiMarket: {
      ticker: 'KXBTC15M-26SEP141215-15',
      eventTicker: 'KXBTC15M-26SEP141215',
      seriesTicker: 'KXBTC15M',
      startsAt: START,
      expiresAt: END,
      target: 50_000,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    },
    benchmark: { status: 'live', samples: readings, current: readings.at(-1), receivedAt: NOW },
    stream: {
      status: 'live',
      quality: { heartbeatAt: NOW, completeSince: NOW - 240_000, confirmedThrough: NOW },
      flow: { windows: pressureWindows(), impact: impact() },
      liquidity: { available: false },
    },
    derivatives: {
      version: 'bybit-linear-flow-v1',
      source: 'bybit-linear',
      symbol: 'BTCUSDT',
      status: 'live',
      asOf: NOW,
      quality: {
        subscribed: true,
        completeSince: NOW - 240_000,
        lastMessageAt: NOW,
        lastTradeAt: NOW,
      },
      windows: pressureWindows(),
      impact: impact(),
      liquidations: { available: false },
    },
  };
}

function entry(forecast, market) {
  return {
    id: 'paired-capture',
    startsAt: START,
    createdAt: NOW,
    expiresAt: END,
    target: market.target,
    kalshiMarket: market,
    aboveProbability: forecast.aboveProbability,
    belowProbability: forecast.belowProbability,
    modelVersion: forecast.modelVersion,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    status: 'pending',
  };
}

describe('Paired settlement experiments and input replay', () => {
  test('removes spot/futures effects while preserving the exact selected reference and volatility', () => {
    const values = input();
    const original = JSON.stringify(values);
    const production = getKalshiForecast(values);
    const forecast = getResearchForecast(values);
    const experiment = forecast.researchExperiment;
    expect(forecast.aboveProbability).toBe(production.aboveProbability);
    expect(production).not.toHaveProperty('researchVariants');
    expect(experiment.capturedAt).toBe(NOW);
    expect(Object.keys(experiment.variants)).toEqual(RESEARCH_VARIANT_NAMES);
    const variants = experiment.variants;
    for (const variant of Object.values(variants)) {
      expect(variant).toMatchObject({
        available: true,
        referenceSource: 'cf-brti',
        referenceAt: production.kalshi.referenceAt,
        referencePrice: production.kalshi.referencePrice,
        minuteVolatility: production.kalshi.minuteVolatility,
        basisLogDeviation: production.kalshi.basisLogDeviation,
      });
    }
    expect(variants['settlement-only']).toMatchObject({
      appliedSpot: false,
      appliedFutures: false,
    });
    expect(variants['spot-only']).toMatchObject({ appliedSpot: true, appliedFutures: false });
    expect(variants['futures-only']).toMatchObject({ appliedSpot: false, appliedFutures: true });
    expect(variants.combined.aboveProbability).toBe(production.aboveProbability);
    expect(variants['spot-only'].aboveProbability).toBeGreaterThan(
      variants['settlement-only'].aboveProbability,
    );
    expect(variants['futures-only'].aboveProbability).toBeGreaterThan(
      variants['settlement-only'].aboveProbability,
    );
    expect(JSON.stringify(values)).toBe(original);
  });

  test('keeps proxy uncertainty and anchor unchanged across ablations', () => {
    const values = { ...input(), benchmark: null };
    const variants = getResearchForecast(values).researchExperiment.variants;
    expect(variants.combined.referenceSource).toBe('coinbase-proxy');
    expect(variants.combined.basisLogDeviation).toBeGreaterThanOrEqual(0.0005);
    for (const variant of Object.values(variants)) {
      expect(variant.referencePrice).toBe(variants.combined.referencePrice);
      expect(variant.minuteVolatility).toBe(variants.combined.minuteVolatility);
      expect(variant.basisLogDeviation).toBe(variants.combined.basisLogDeviation);
    }
  });

  test('removes futures liquidation variance without requiring a directional futures effect', () => {
    const values = input();
    values.stream = null;
    for (const window of Object.values(values.derivatives.windows)) window.logReturn = 0;
    values.derivatives.liquidations = {
      available: true,
      windows: Object.fromEntries(
        [15, 60, 180].map((seconds) => [
          seconds,
          {
            available: true,
            longBtc: (4 * seconds) / 15,
            shortBtc: 0,
            count: 4,
          },
        ]),
      ),
    };
    const forecast = getResearchForecast(values);
    expect(forecast.derivatives.expectedLogReturn).toBe(0);
    const variants = forecast.researchExperiment.variants;
    expect(variants['futures-only'].settlementStandardDeviation).toBeGreaterThan(
      variants['settlement-only'].settlementStandardDeviation,
    );
    expect(variants.combined.settlementStandardDeviation).toBe(
      variants['futures-only'].settlementStandardDeviation,
    );
  });

  test('retains valid fallback comparisons when optional feeds are absent', () => {
    const forecast = getResearchForecast({ ...input(), stream: null, derivatives: null });
    for (const variant of Object.values(forecast.researchExperiment.variants)) {
      expect(variant.available).toBe(true);
      expect(variant.aboveProbability).toBe(forecast.aboveProbability);
    }
    expect(forecast.researchExperiment.variants.combined.fallbacks).toHaveLength(2);
    const unavailable = getResearchForecast({
      ...input(),
      candles: [],
      ticker: null,
      benchmark: null,
    });
    expect(unavailable.available).toBe(false);
    for (const variant of Object.values(unavailable.researchExperiment.variants)) {
      expect(variant.available).toBe(false);
      expect(variant.aboveProbability).toBeNull();
      expect(variant.reason).toBeTruthy();
    }
  });

  test('replays detached complete history and artifacts after serialization, at the original clock', () => {
    const values = input();
    values.stream.getDeadlineOutcome = () => ({ status: 'waiting' });
    const models = { active: null, candidate: null, earlyCandidate: null };
    const forecast = getResearchForecast(values, models, START);
    const snapshot = createResearchInputSnapshot(values, models, START, forecast);
    expect(snapshot.input.benchmark.samples).toEqual(values.benchmark.samples);
    expect(snapshot.timing).toMatchObject({ replayable: true, receiptTimeVerified: false });
    expect(snapshot.timing.limitations.length).toBeGreaterThan(0);
    values.benchmark.samples[0].price += 100;
    values.ticker.price += 100;
    models.active = { id: 'a-later-model' };
    const replay = replayResearchInputSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(replay).toEqual(forecast);
    expect(snapshot.models.active).toBeNull();
  });

  test.each([
    [
      'late receipt',
      (values) => {
        values.benchmark.receivedAt = NOW + 1;
      },
    ],
    [
      'late source data',
      (values) => {
        values.benchmark.samples[0].time = NOW + 1;
      },
    ],
    [
      'late futures data',
      (values) => {
        values.derivatives.impact.samples[0].endAt = NOW + 1;
      },
    ],
    [
      'future outcome',
      (values) => {
        values.kalshiOutcome = { outcome: 'above', observedAt: END };
      },
    ],
  ])('rejects %s instead of silently changing cutoffs', (_, mutate) => {
    const snapshot = createResearchInputSnapshot(input(), {}, START);
    mutate(snapshot.input);
    expect(() => replayResearchInputSnapshot(snapshot)).toThrow(/after capture|outcome/);
  });

  test('rejects post-capture models, changed recorded predictions and a changed replay clock', () => {
    const snapshot = createResearchInputSnapshot(input(), {}, START);
    const laterModel = JSON.parse(JSON.stringify(snapshot));
    laterModel.models.active = { trainedAt: NOW + 1 };
    expect(() => replayResearchInputSnapshot(laterModel)).toThrow(/after capture/);
    const changed = JSON.parse(JSON.stringify(snapshot));
    changed.expectedExperiment.variants.combined.aboveProbability += 0.001;
    expect(() => replayResearchInputSnapshot(changed)).toThrow(/differs/);
    snapshot.input.now += 1;
    expect(() => replayResearchInputSnapshot(snapshot)).toThrow(/clock/);
  });

  test('replays canonical database JSON independently of object key order', () => {
    const snapshot = createResearchInputSnapshot(input(), {}, START);
    const sortKeys = (value) => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sortKeys(value[key])]),
      );
    };
    const replay = replayResearchInputSnapshot(JSON.parse(JSON.stringify(sortKeys(snapshot))));
    expect(replay.researchExperiment).toEqual(snapshot.expectedExperiment);
  });

  test('includes compact comparisons on captures and full inputs only on decision rows', () => {
    const values = input();
    const estimate = getResearchForecast(values);
    const snapshot = createResearchInputSnapshot(values, {}, START, estimate);
    const args = {
      entry: entry(estimate, values.kalshiMarket),
      now: NOW,
      inputObservedAt: NOW,
      estimate: { ...estimate, researchInputSnapshot: snapshot },
      ticker: values.ticker,
    };
    const decision = getEvidenceRow({ ...args, event: 'decision' });
    expect(decision.researchInputSnapshot).toEqual(snapshot);
    expect(decision.researchExperiment).toEqual(estimate.researchExperiment);
    const observation = getEvidenceRow({ ...args, event: 'observation' });
    expect(observation.researchExperiment).toEqual(estimate.researchExperiment);
    expect(observation).not.toHaveProperty('researchInputSnapshot');
    for (const event of ['outcome', 'restored']) {
      const row = getEvidenceRow({ ...args, event });
      expect(row.researchExperiment).toBeNull();
      expect(row).not.toHaveProperty('researchInputSnapshot');
    }
  });

  test('retains a large decision snapshot without trimming history when optional feeds are missing', () => {
    const values = { ...input(), stream: null, derivatives: null };
    values.benchmark.samples = Array.from({ length: 7201 }, (_, index) => ({
      time: NOW - (7200 - index) * 1000,
      price: 50_000 * Math.exp(Math.sin((index - 7200) / 30) * 0.0001),
    }));
    const estimate = getResearchForecast(values);
    const snapshot = createResearchInputSnapshot(values, {}, START, estimate);
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(128 * 1024);
    const row = getEvidenceRow({
      entry: entry(estimate, values.kalshiMarket),
      event: 'decision',
      now: NOW,
      inputObservedAt: NOW,
      estimate,
      researchInputSnapshot: snapshot,
    });
    expect(row.researchInputSnapshot.input.benchmark.samples).toHaveLength(7201);
    expect(replayResearchInputSnapshot(row.researchInputSnapshot).researchExperiment).toEqual(
      row.researchExperiment,
    );
    expect(row.researchExperiment.production.available).toBe(true);
    expect(row.researchExperiment.variants.combined.fallbacks).toHaveLength(2);
  });

  test('replays an unavailable essential-feed prediction without inventing a probability', () => {
    const values = {
      ...input(),
      candles: [],
      ticker: null,
      benchmark: null,
      stream: null,
      derivatives: null,
    };
    const estimate = getResearchForecast(values);
    const snapshot = createResearchInputSnapshot(values, {}, START, estimate);
    const replay = replayResearchInputSnapshot(snapshot);
    expect(replay.researchExperiment).toEqual(estimate.researchExperiment);
    expect(replay.available).toBe(false);
    expect(replay.aboveProbability).toBeNull();
  });
});
