import {
  createResearchRecorder,
  getValidatedResearchRecorderState,
} from '../utils/researchRecorder.utils';
import { KALSHI_RESEARCH_CHECKPOINTS } from '../utils/kalshi/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { getKalshiMarketProbability } from '../utils/kalshi/marketQuote.utils';
import { DEADLINE_OUTCOME_DEFINITION } from '../utils/outcome.utils';
import {
  getVerifiedLearningRows,
  analyzeForecastEvidence,
  getIndependentRows,
} from '../utils/learning/evaluation.utils';
import { LEARNING_FEATURE_NAMES, LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';
import {
  trainOutcomeCandidate,
  splitLearningWindows,
  evaluateShadowCandidate,
  selectLearningPipelineRows,
} from '../utils/learning/training.utils';
import {
  predictOutcomeCandidate,
  applyOutcomeModel,
  isOutcomeModelArtifact,
  OUTCOME_MODEL_VERSION,
} from '../utils/learning/model.utils';
import { createLearningService } from '@/services/research/learning.service';
import { fitLogistic } from '../utils/learning/statistics.utils';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/services/research/research.repository', () => ({}));

const START = 1_800_000_000_000;
const MINUTE = 60_000;
const recorderId = 'kalshi-test';
const marketFor = (index = 0, now = START + index * 17 * MINUTE) => ({
  ticker: `KXBTC15M-TEST${index}`,
  eventTicker: `KXBTC15M-TEST${index}`,
  seriesTicker: 'KXBTC15M',
  target: 100_000,
  startsAt: START + index * 17 * MINUTE,
  expiresAt: START + index * 17 * MINUTE + 15 * MINUTE,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  supported: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
  receivedAt: now,
});
const tickerAt = (now) => ({ time: now, receivedAt: now, price: 100_001 });
const estimate = (probability = 0.55) => ({
  available: true,
  aboveProbability: probability,
  belowProbability: 1 - probability,
  direction: probability > 0.5 ? 'above' : probability < 0.5 ? 'below' : 'neutral',
  modelVersion: 'kalshi-brti-average-v2',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshi: {
    referenceSource: 'coinbase-proxy',
    priceDynamicsSource: 'coinbase-candles',
    observedSampleCount: 0,
  },
});
const snapshot = (now, market, outcome = 1) => ({
  schemaVersion: LEARNING_FEATURE_VERSION,
  available: true,
  baselineAboveProbability: 0.55,
  targetDistance: 0,
  target: market.target,
  expiresAt: market.expiresAt,
  featureCutoffAt: now,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  referenceSource: 'coinbase-proxy',
  featureInputSource: 'coinbase-candles',
  baselineModelVersion: 'kalshi-brti-average-v2',
  settlementKnownFraction: 0,
  values: LEARNING_FEATURE_NAMES.map((_, index) => (index === 3 ? (outcome ? 1 : -1) : 0)),
});
function input(now = START, changes = {}) {
  return {
    now,
    ticker: tickerAt(now),
    markets: [marketFor(0, now)],
    getEstimate: () => estimate(),
    ...changes,
  };
}
function recordedMarket(
  index = 0,
  { tie = false, probability = 0.65, referenceSource = 'coinbase-proxy', offset = 0 } = {},
) {
  const market = marketFor(index);
  const outcome = index % 2;
  const recorder = createResearchRecorder({ recorderId });
  const events = [];
  for (const minutes of KALSHI_RESEARCH_CHECKPOINTS) {
    const now = market.expiresAt - minutes * MINUTE + offset;
    const state = recorder.advance({
      now,
      ticker: tickerAt(now),
      markets: [{ ...market, receivedAt: now }],
      getEstimate: () => ({
        ...estimate(probability),
        learningFeatures: {
          ...snapshot(now, market, outcome),
          baselineAboveProbability: probability,
          referenceSource,
        },
      }),
    });
    events.push(...state.rows);
  }
  const settledAt = market.expiresAt + 1000;
  events.push(
    ...recorder.advance({
      now: settledAt,
      ticker: tickerAt(settledAt),
      markets: [
        {
          ...market,
          status: 'finalized',
          result: tie ? 'yes' : outcome ? 'yes' : 'no',
          settlementPrice: tie ? market.target : outcome ? 100_002 : 99_998,
          receivedAt: settledAt,
        },
      ],
      getEstimate: () => estimate(),
    }).rows,
  );
  return events;
}

test('the default recorder waits for an official contract and never invents a Coinbase target', () => {
  const recorder = createResearchRecorder({ recorderId });
  const result = recorder.advance(input(START, { markets: [] }));
  expect(result.rows).toEqual([]);
  expect(result.state.version).toBe(2);
  expect(result.state.markets).toEqual([]);
  const valid = recorder.advance(input());
  expect(valid.state.markets[0].contract.target).toBe(100_000);
  expect(valid.state.markets[0].contract.target).not.toBe(tickerAt(START).price);
});

test('captures all five actual horizons once and keeps the same market target', () => {
  const events = recordedMarket();
  const decisions = events.filter((row) => row.event === 'decision');
  expect(decisions).toHaveLength(5);
  expect(decisions.map((row) => row.horizonMinutes)).toEqual([12, 9, 6, 3, 1]);
  expect(
    decisions.every((row) => row.cohort === 'kalshi-background' && row.target === 100_000),
  ).toBe(true);
  const verified = getVerifiedLearningRows(events, START + 20 * MINUTE);
  expect(verified.rows).toHaveLength(5);
  expect(getIndependentRows(verified.rows)).toHaveLength(1);
});

test('joining late marks only missed checkpoints and captures the next checkpoint prospectively', () => {
  const recorder = createResearchRecorder({ recorderId });
  const joined = recorder.advance(input(START + 5 * MINUTE));
  expect(joined.rows).toHaveLength(1);
  expect(joined.rows[0]).toMatchObject({
    decision: 'withheld',
    inputStatus: 'decision-inputs-unavailable',
    aboveProbability: null,
  });
  const next = recorder.advance(input(START + 6 * MINUTE));
  expect(next.rows).toHaveLength(1);
  expect(next.rows[0]).toMatchObject({ decision: 'pending', horizonMinutes: 9 });
});

test('a weak or exactly balanced valid estimate is recorded without a confidence gate', () => {
  const recorder = createResearchRecorder({ recorderId });
  const result = recorder.advance(input(START + 3 * MINUTE, { getEstimate: () => estimate(0.5) }));
  expect(result.rows[0]).toMatchObject({
    decision: 'pending',
    aboveProbability: 0.5,
    belowProbability: 0.5,
  });
});

test('restoring a checkpoint never changes its probability or repeats its evidence', () => {
  const recorder = createResearchRecorder({ recorderId });
  recorder.advance(input(START + 3 * MINUTE));
  const state = recorder.getState();
  expect(getValidatedResearchRecorderState(state, recorderId)).not.toBeNull();
  const restored = createResearchRecorder({ recorderId, state });
  expect(
    restored.advance(input(START + 3 * MINUTE + 1000, { getEstimate: () => estimate(0.9) })).rows,
  ).toEqual([]);
  expect(restored.getState().markets[0].checkpoints[0].aboveProbability).toBe(0.55);
});

test.each(['target', 'expiresAt'])(
  'rejects changed persisted %s rather than silently resetting',
  (field) => {
    const recorder = createResearchRecorder({ recorderId });
    recorder.advance(input());
    const state = recorder.getState();
    state.markets[0].checkpoints[0][field]++;
    expect(() => createResearchRecorder({ recorderId, state })).toThrow('recording is paused');
  },
);

test('a changed official contract identity cannot be captured against the old target', () => {
  const recorder = createResearchRecorder({ recorderId });
  recorder.advance(input());
  const result = recorder.advance(
    input(START + 3 * MINUTE + 5000, {
      markets: [{ ...marketFor(0, START + 3 * MINUTE + 5000), target: 101_000 }],
    }),
  );
  expect(result.rows[0]).toMatchObject({
    decision: 'withheld',
    target: 100_000,
    aboveProbability: null,
  });
});

test('never uses a Coinbase quote or a determined-but-unfinalized result to settle', () => {
  const recorder = createResearchRecorder({ recorderId });
  recorder.advance(input(START + 3 * MINUTE));
  const now = START + 16 * MINUTE;
  const deadlineOutcome = jest.fn(() => ({ status: 'observed', observedPrice: 99_000 }));
  const result = recorder.advance(
    input(now, {
      markets: [
        { ...marketFor(0, now), status: 'determined', result: 'yes', settlementPrice: 100_500 },
      ],
      stream: { getDeadlineOutcome: deadlineOutcome },
    }),
  );
  expect(result.rows.some((row) => row.event === 'outcome')).toBe(false);
  expect(deadlineOutcome).not.toHaveBeenCalled();
  expect(result.state.markets).toHaveLength(1);
});

test('official YES equality is a valid binary outcome and not discarded as a tie', () => {
  const events = recordedMarket(0, { tie: true });
  const result = getVerifiedLearningRows(events, START + 20 * MINUTE);
  expect(result.rows).toHaveLength(5);
  expect(result.rows.every((row) => row.outcome === 1)).toBe(true);
  expect(result.counts.exactTargetOutcomes).toBe(0);
});

test('conflicting or incomplete official proof never enters learning', () => {
  const events = recordedMarket();
  const outcome = events.find((row) => row.event === 'outcome');
  outcome.kalshiOutcome.marketTicker = 'KXBTC15M-DIFFERENT';
  expect(getVerifiedLearningRows(events, START + 20 * MINUTE).rows).toHaveLength(4);
  outcome.kalshiOutcome.marketTicker = 'KXBTC15M-TEST0';
  outcome.observedPrice++;
  expect(getVerifiedLearningRows(events, START + 20 * MINUTE).rows).toHaveLength(4);
});

test('late quotes cannot backfill a missed research checkpoint', () => {
  const recorder = createResearchRecorder({ recorderId });
  const getEstimate = jest.fn(() => estimate());
  const result = recorder.advance(input(START + 3 * MINUTE + 5001, { getEstimate }));
  expect(getEstimate).not.toHaveBeenCalled();
  expect(result.rows[0].aboveProbability).toBeNull();
});

test('long offline backlogs drain in bounded atomic batches without losing pending markets', () => {
  const recorder = createResearchRecorder({ recorderId });
  const markets = Array.from({ length: 25 }, (_, index) => ({
    ...marketFor(0),
    ticker: `KXBTC15M-BACKLOG${index}`,
    eventTicker: `KXBTC15M-BACKLOG${index}`,
  }));
  recorder.advance(input(START, { markets }));
  const now = START + 15 * MINUTE + 7 * 24 * 60 * MINUTE + 1;
  const first = recorder.advance(input(now, { markets: [] }));
  expect(first.rows).toHaveLength(100);
  expect(first.state.markets).toHaveLength(15);
  expect(getValidatedResearchRecorderState(first.state, recorderId)).not.toBeNull();
  const second = recorder.advance(input(now + 1, { markets: [] }));
  expect(second.rows).toHaveLength(100);
  expect(second.state.markets).toHaveLength(5);
  const third = recorder.advance(input(now + 2, { markets: [] }));
  expect(third.rows).toHaveLength(50);
  expect(third.state.markets).toHaveLength(0);
});

test('analysis reports each horizon while counting one independent contract', () => {
  const result = analyzeForecastEvidence(recordedMarket(), START + 20 * MINUTE);
  expect(result.independentWindows).toBe(1);
  expect(result.primaryCohort).toBe('kalshi-background');
  expect(result.byHorizon.every((row) => row.examples === 1)).toBe(true);
});

test('the default training cohort ignores old Coinbase labels entirely', () => {
  const events = recordedMarket();
  for (const event of events) event.outcomeDefinition = DEADLINE_OUTCOME_DEFINITION;
  const result = trainOutcomeCandidate(events, { now: START + 20 * MINUTE });
  expect(result.counts.independentWindows).toBe(0);
  expect(result.artifact).toBeNull();
});

test('checkpoint grouping preserves chronological splits and gives each fitting window total weight one', () => {
  const events = Array.from({ length: 16 }, (_, index) => recordedMarket(index)).flat();
  const { rows } = getVerifiedLearningRows(events, events.at(-1).recordedAt + MINUTE);
  const split = splitLearningWindows(rows);
  expect(split.groupCount).toBe(16);
  expect(split.train).toHaveLength(8);
  expect(split.trainingCheckpoints).toHaveLength(40);
  expect(split.trainingCheckpoints.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(8);
  const trainingMarkets = new Set(split.trainingCheckpoints.map((row) => row.marketTicker));
  expect(split.calibrationCheckpoints.every((row) => !trainingMarkets.has(row.marketTicker))).toBe(
    true,
  );
  expect(
    split.calibrationCheckpoints.every((row) => row.windowStartAt >= split.trainingCutoffAt),
  ).toBe(true);
});

let trained;
function getTrained() {
  if (!trained) {
    const events = Array.from({ length: 320 }, (_, index) => recordedMarket(index)).flat();
    const now = events.at(-1).recordedAt + MINUTE;
    trained = trainOutcomeCandidate(events, { now });
  }
  return trained;
}

test('fits all horizons but minimums count contracts, and activation still requires future evidence', () => {
  const result = getTrained();
  expect(result.status).toBe('shadow');
  expect(result.counts.training).toBe(160);
  expect(result.artifact.model.trainingRows).toBe(800);
  expect(result.artifact.applicability).toMatchObject({
    minimumHorizonMinutes: 1,
    maximumHorizonMinutes: 12,
    referenceSources: ['coinbase-proxy'],
  });
  expect(result.artifact.outcomeDefinition).toBe(KALSHI_OUTCOME_DEFINITION);
  expect(isOutcomeModelArtifact(result.artifact)).toBe(true);
  expect(
    evaluateShadowCandidate(result.artifact, [], { now: result.artifact.trainedAt + MINUTE })
      .eligibleForPromotion,
  ).toBe(false);
});

test('a Kalshi artifact cannot adjust Coinbase or a partially observed settlement average', () => {
  const model = { ...getTrained().artifact };
  const now = model.trainedAt + MINUTE;
  const market = { ...marketFor(), expiresAt: now + 6 * MINUTE };
  const features = snapshot(now, market, 0);
  expect(predictOutcomeCandidate(model, features)).toBeLessThan(0.5);
  expect(
    predictOutcomeCandidate(model, { ...features, outcomeDefinition: DEADLINE_OUTCOME_DEFINITION }),
  ).toBeNull();
  expect(predictOutcomeCandidate(model, { ...features, settlementKnownFraction: 0.5 })).toBe(
    features.baselineAboveProbability,
  );
  expect(predictOutcomeCandidate(model, { ...features, referenceSource: 'cf-brti' })).toBe(
    features.baselineAboveProbability,
  );
  model.activation = {
    modelId: model.id,
    activatedAt: now,
    shadowEvaluation: { eligibleForPromotion: true },
  };
  const base = { ...estimate(), outcomeDefinition: DEADLINE_OUTCOME_DEFINITION };
  expect(
    applyOutcomeModel(
      base,
      { learningFeatures: features, target: market.target, expiresAt: market.expiresAt, now },
      model,
    ),
  ).toBe(base);
});

test('a legacy Coinbase artifact cannot adjust a Kalshi forecast or appear as its active model', async () => {
  const kalshi = getTrained().artifact;
  const legacy = {
    ...kalshi,
    id: `${OUTCOME_MODEL_VERSION}-legacy`,
    version: OUTCOME_MODEL_VERSION,
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  };
  expect(isOutcomeModelArtifact(legacy)).toBe(false);
  const now = legacy.trainedAt + MINUTE;
  const features = snapshot(now, { ...marketFor(), expiresAt: now + 6 * MINUTE });
  expect(predictOutcomeCandidate(legacy, features)).toBeNull();
  const service = createLearningService({
    readModelArtifacts: async () => [legacy],
    getActiveModelArtifact: async () => legacy,
  });
  expect(await service.getResearchModels()).toEqual({ active: null, candidate: null });
});

test('weighted normalization and logistic fit are not changed by replicated checkpoints', () => {
  const original = [
    { features: [-2], outcome: 0 },
    { features: [2], outcome: 1 },
  ];
  const repeated = [
    { ...original[0], weight: 1 },
    ...Array.from({ length: 5 }, () => ({ ...original[1], weight: 0.2 })),
  ];
  const first = fitLogistic(original, [0]);
  const second = fitLogistic(repeated, [0]);
  expect(second.means[0]).toBeCloseTo(first.means[0]);
  expect(second.coefficients[1]).toBeCloseTo(first.coefficients[1]);
});

function useNativeHistory(events, baselineModelVersion = 'kalshi-brti-average-v2') {
  for (const event of events.filter((row) => row.event === 'decision')) {
    event.learningFeatures = {
      ...event.learningFeatures,
      referenceSource: 'cf-brti',
      featureInputSource: 'cf-brti-history',
      baselineModelVersion,
    };
  }
  return events;
}

test('historical forecasts remain auditable but old feature generations cannot train a new model', () => {
  const events = recordedMarket();
  for (const row of events.filter((event) => event.event === 'decision')) {
    row.learningFeatures.schemaVersion = 'deadline-reversal-features-v1';
    delete row.learningFeatures.baselineModelVersion;
    delete row.learningFeatures.featureInputSource;
  }
  const now = events.at(-1).recordedAt + MINUTE;
  const result = analyzeForecastEvidence(events, now);
  expect(result.metrics.examples).toBe(1);
  expect(result.counts.verifiedOutcomes).toBe(5);
  expect(result.counts.learningExamples).toBe(0);
  expect(trainOutcomeCandidate(events, { now }).counts.independentWindows).toBe(0);
});

test('large proxy history cannot qualify a small native-index training cohort', () => {
  const proxy = Array.from({ length: 320 }, (_, index) => recordedMarket(index)).flat();
  const native = Array.from({ length: 8 }, (_, index) =>
    useNativeHistory(recordedMarket(index + 320)),
  ).flat();
  const laterFallback = recordedMarket(328);
  const events = [...proxy, ...native, ...laterFallback];
  const now = events.at(-1).recordedAt + MINUTE;
  const result = trainOutcomeCandidate(events, { now });
  expect(result.status).toBe('insufficient-data');
  expect(result.artifact).toBeNull();
  expect(result.counts).toMatchObject({
    independentWindows: 8,
    pipeline: {
      baselineModelVersion: 'kalshi-brti-average-v2',
      referenceSource: 'cf-brti',
      featureInputSource: 'cf-brti-history',
    },
  });
  const analysis = analyzeForecastEvidence(events, now);
  expect(analysis.byInputSource).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ referenceSource: 'coinbase-proxy', examples: 321 }),
      expect.objectContaining({ referenceSource: 'cf-brti', examples: 8 }),
    ]),
  );
});

test('a fresh BRTI quote with proxy candle features remains a separate experiment from BRTI history', () => {
  const events = [
    ...recordedMarket(0, { referenceSource: 'cf-brti' }),
    ...useNativeHistory(recordedMarket(1)),
  ];
  const { rows } = getVerifiedLearningRows(events, events.at(-1).recordedAt + MINUTE);
  const selection = selectLearningPipelineRows(rows);
  expect(selection.pipeline.featureInputSource).toBe('cf-brti-history');
  expect(selection.rows).toHaveLength(5);
  expect(selection.rows.every((row) => row.marketTicker === 'KXBTC15M-TEST1')).toBe(true);
});

test('a changed baseline release starts its own evidence cohort', () => {
  const events = [
    ...useNativeHistory(recordedMarket(0)),
    ...useNativeHistory(recordedMarket(1), 'kalshi-brti-average-v3'),
  ];
  const { rows } = getVerifiedLearningRows(events, events.at(-1).recordedAt + MINUTE);
  const selection = selectLearningPipelineRows(rows);
  expect(selection.pipeline.baselineModelVersion).toBe('kalshi-brti-average-v3');
  expect(selection.rows).toHaveLength(5);
});

test('an artifact cannot adjust a different feature source or baseline release', () => {
  const trained = getTrained().artifact;
  const model = {
    ...trained,
    applicability: {
      ...trained.applicability,
      referenceSources: ['cf-brti'],
      featureInputSources: ['cf-brti-history'],
    },
  };
  const now = model.trainedAt + MINUTE;
  const features = {
    ...snapshot(now, { ...marketFor(), expiresAt: now + 6 * MINUTE }, 0),
    referenceSource: 'cf-brti',
    featureInputSource: 'cf-brti-history',
  };
  expect(predictOutcomeCandidate(model, features)).toBeLessThan(0.5);
  expect(
    predictOutcomeCandidate(model, { ...features, featureInputSource: 'coinbase-candles' }),
  ).toBe(features.baselineAboveProbability);
  expect(
    predictOutcomeCandidate(model, { ...features, baselineModelVersion: 'kalshi-brti-average-v3' }),
  ).toBe(features.baselineAboveProbability);
  expect(
    isOutcomeModelArtifact({
      ...model,
      applicability: { ...model.applicability, referenceSources: ['cf-brti', 'coinbase-proxy'] },
    }),
  ).toBe(false);
});

test('captures executable quotes separately and scores only a fresh same-contract midpoint', () => {
  const recorder = createResearchRecorder({ recorderId });
  const now = START + 3 * MINUTE;
  const result = recorder.advance(
    input(now, {
      markets: [{ ...marketFor(0, now), yesBid: 0.42, yesAsk: 0.46, noBid: 0.54, noAsk: 0.58 }],
    }),
  );
  const row = result.rows[0];
  expect(row.kalshiMarket.yesAsk).toBeUndefined();
  expect(row.kalshiQuote).toMatchObject({
    marketTicker: row.kalshiMarket.ticker,
    yesBid: 0.42,
    yesAsk: 0.46,
    receivedAt: now,
  });
  expect(getKalshiMarketProbability(row.kalshiQuote, row.kalshiMarket, now)).toBeCloseTo(0.44);
  expect(getKalshiMarketProbability(row.kalshiQuote, row.kalshiMarket, now + 30_001)).toBeNull();
  expect(
    getKalshiMarketProbability(
      { ...row.kalshiQuote, marketTicker: 'KXBTC15M-OTHER' },
      row.kalshiMarket,
      now,
    ),
  ).toBeNull();
});

test('a candidate that loses to the actual market midpoint on matched events is not promoted', () => {
  const events = Array.from({ length: 320 }, (_, index) => recordedMarket(index)).flat();
  for (const event of events.filter((row) => row.event === 'decision')) {
    const outcome = Number(event.kalshiMarket.ticker.replace('KXBTC15M-TEST', '')) % 2;
    event.kalshiQuote = {
      marketTicker: event.kalshiMarket.ticker,
      target: event.target,
      expiresAt: event.expiresAt,
      receivedAt: event.capturedAt,
      yesBid: outcome ? 0.98 : 0,
      yesAsk: outcome ? 1 : 0.02,
      noBid: outcome ? 0 : 0.98,
      noAsk: outcome ? 0.02 : 1,
    };
  }
  const result = trainOutcomeCandidate(events, { now: events.at(-1).recordedAt + MINUTE });
  expect(result.status).toBe('candidate-rejected');
  expect(result.artifact.evaluation.reasons).toContain(
    'Candidate underperforms the contemporaneous Kalshi midpoint on matched contracts.',
  );
  const analysis = analyzeForecastEvidence(events, events.at(-1).recordedAt + MINUTE);
  expect(analysis.marketBenchmark.examples).toBe(320);
  expect(analysis.marketBenchmark.callAccuracy).toBe(1);
});
