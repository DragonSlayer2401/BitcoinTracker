/** @jest-environment node */
import {
  evaluatePatternChallengers,
  getPatternPaperObservations,
} from '../utils/patternEvaluation.utils';
import {
  PATTERN_CANDIDATE_KINDS,
  PATTERN_MODEL_VERSION,
  LEGACY_PATTERN_MODEL_VERSION,
} from '../utils/learning/patternModel.utils';
import { getKalshiOutcome, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { LEARNING_FEATURE_VERSION, LEARNING_FEATURE_NAMES } from '../utils/learning/features.utils';
import {
  getPatternLearningFeatures,
  PATTERN_FEATURE_VERSION,
  PATTERN_DETECTOR_VERSION,
} from '../utils/learning/patternFeatures.utils';
import { PATTERN_FEATURE_DEFINITIONS } from '../utils/patterns/patternConfig';
import { getPatternTrainingRows } from '../utils/learning/patternTraining.utils';
import { getPatternProspectiveCohorts } from '../utils/learning/patternCohorts.utils';

const START = Date.UTC(2026, 9, 3, 12);
const NOW = START + 100 * 900000;

function recorded(
  index = 0,
  { checkpoint = 6, result = 'yes', production = 0.65, combined = 0.85 } = {},
) {
  const contract = {
    ticker: `KXBTC15M-PATTERN${index}`,
    eventTicker: `KXBTC15M-PATTERN${index}`,
    seriesTicker: 'KXBTC15M',
    target: 75000,
    startsAt: START + index * 900000,
    expiresAt: START + (index + 1) * 900000,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const capturedAt = contract.expiresAt - checkpoint * 60000;
  const forecastId = `${contract.ticker}:${checkpoint}`;
  const learningFeatures = {
    schemaVersion: LEARNING_FEATURE_VERSION,
    available: true,
    baselineAboveProbability: production,
    targetDistance: 0,
    target: contract.target,
    expiresAt: contract.expiresAt,
    featureCutoffAt: capturedAt,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    referenceSource: 'cf-brti',
    featureInputSource: 'cf-brti-history',
    baselineModelVersion: 'kalshi-brti-average-v2',
    settlementKnownFraction: 0,
    values: LEARNING_FEATURE_NAMES.map(() => 0),
  };
  const chartPatterns = {
    version: PATTERN_DETECTOR_VERSION,
    source: 'brti',
    capturedAt,
    availableAt: capturedAt,
    targetPrice: contract.target,
    features: Object.fromEntries(PATTERN_FEATURE_DEFINITIONS.map(({ name }) => [name, 0])),
    families: Object.fromEntries(
      PATTERN_FEATURE_DEFINITIONS.map(({ family }) => [family, { available: true }]),
    ),
  };
  const decision = {
    eventId: `${forecastId}:decision`,
    event: 'decision',
    forecastId,
    recordedAt: capturedAt,
    capturedAt,
    inputObservedAt: capturedAt,
    featureCutoffAt: capturedAt,
    inputStatus: 'captured',
    cohort: 'kalshi-background',
    checkpointMinutes: checkpoint,
    kalshiMarket: contract,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    windowStartAt: contract.startsAt,
    expiresAt: contract.expiresAt,
    target: contract.target,
    spot: 75001,
    modelVersion: 'kalshi-brti-average-v1',
    aboveProbability: production,
    belowProbability: 1 - production,
    learningFeatures,
    patternLearningFeatures: getPatternLearningFeatures({ learningFeatures, chartPatterns }),
    patternShadowPredictions: PATTERN_CANDIDATE_KINDS.map((kind) => ({
      modelVersion: PATTERN_MODEL_VERSION,
      modelId: `${PATTERN_MODEL_VERSION}-${kind}-${START - 1}-abc`,
      suiteId: `${START - 1}-abc`,
      kind,
      trainedAt: START - 1,
      featureCutoffAt: capturedAt,
      aboveProbability: kind === 'combined' ? combined : production,
      modelUsed: true,
      reason: null,
    })),
  };
  const publishedAt = contract.expiresAt + 5000;
  const kalshiOutcome = getKalshiOutcome(
    {
      ...contract,
      status: 'settled',
      result,
      settlementPrice: result === 'yes' ? 75002 : 74998,
      receivedAt: publishedAt,
    },
    publishedAt,
  );
  return [
    decision,
    {
      ...decision,
      event: 'outcome',
      eventId: `${forecastId}:outcome`,
      recordedAt: publishedAt,
      outcomeStatus: 'observed',
      kalshiOutcome,
      observedPrice: kalshiOutcome.observedPrice,
      observedAt: kalshiOutcome.observedAt,
      confirmedThrough: kalshiOutcome.confirmedThrough,
      outcome: kalshiOutcome.outcome,
    },
  ];
}

function makeObservation(decision) {
  const book = (receivedAt) => ({
    ticker: decision.kalshiMarket.ticker,
    receivedAt,
    requestedAt: receivedAt,
    yesAsks: [{ price: 0.5, quantity: 100 }],
    noAsks: [{ price: 0.55, quantity: 100 }],
    fee: {
      available: true,
      type: 'quadratic',
      multiplier: 1,
      checkedAt: receivedAt,
      validUntil: receivedAt + 30000,
    },
  });
  return {
    id: `${decision.kalshiMarket.ticker}:claim`,
    source: 'pattern-independent',
    contract: decision.kalshiMarket,
    capturedAt: decision.capturedAt,
    forecast: {
      available: true,
      aboveProbability: decision.aboveProbability,
      capturedAt: decision.capturedAt,
      modelVersion: decision.modelVersion,
    },
    patternShadowPredictions: decision.patternShadowPredictions,
    patternLearningFeatures: decision.patternLearningFeatures,
    initial: { observedAt: decision.capturedAt, book: book(decision.capturedAt) },
    execution: { observedAt: decision.capturedAt + 2000, book: book(decision.capturedAt + 2000) },
  };
}
const registration = (overrides = {}) => ({
  suiteId: `${START - 1}-abc`,
  registeredAt: START - 1,
  trainedAt: START - 1,
  modelVersion: PATTERN_MODEL_VERSION,
  featureVersion: PATTERN_FEATURE_VERSION,
  patternVersion: PATTERN_DETECTOR_VERSION,
  kinds: [...PATTERN_CANDIDATE_KINDS],
  ...overrides,
});
const evaluate = (events, options = {}) =>
  evaluatePatternChallengers(events, { now: NOW, patternSuites: [registration()], ...options });
const paper = (report) => report.paper.cohorts[0];
const comparison = (report, candidate = 'combined', comparator = 'production') =>
  report.comparisons.find(
    (entry) => entry.candidate === candidate && entry.comparator === comparator,
  );

test('scores frozen matched probabilities and calibrated bins with independent event uncertainty', () => {
  const events = Array.from({ length: 20 }, (_, index) => recorded(index)).flat();
  const report = evaluate(events);
  expect(report.mode).toBe('prospective-frozen-predictions');
  expect(report.counts.independentWindows).toBe(20);
  expect(comparison(report)).toMatchObject({
    examples: 20,
    coverage: 1,
    candidateMetrics: {
      brier: expect.any(Number),
      directionalAccuracy: 1,
      calibrationBins: expect.any(Array),
    },
    difference: { brier: expect.any(Number), accuracy: 0 },
  });
  expect(comparison(report).difference.brier).toBeLessThan(0);
  expect(comparison(report).uncertainty.every((interval) => interval.intervals !== null)).toBe(
    true,
  );
  expect(comparison(report, 'combined', 'baseline-control').examples).toBe(20);
  expect(comparison(report, 'combined', 'without-candles').examples).toBe(20);
  expect(report.featureAvailability).toMatchObject({
    snapshots: 20,
    anyPattern: 20,
    historicalBackfill: false,
  });
});

test('repeated checkpoints count as one independent contract and availability does not choose its representative', () => {
  const events = [12, 9, 6, 3, 1].flatMap((checkpoint) => recorded(0, { checkpoint }));
  const chosen = [12, 9, 6, 3, 1][Math.floor(START / 900000) % 5];
  events.find(
    (event) => event.event === 'decision' && event.checkpointMinutes === chosen,
  ).patternShadowPredictions = [];
  const report = evaluate(events);
  expect(report.counts.independentWindows).toBe(1);
  expect(comparison(report).examples).toBe(0);
});

test('includes baseline fallbacks without filtering out missing patterns or lowering participation', () => {
  const events = recorded();
  const combined = events[0].patternShadowPredictions.find(
    (prediction) => prediction.kind === 'combined',
  );
  combined.modelUsed = false;
  combined.aboveProbability = events[0].aboveProbability;
  events[0].patternLearningFeatures = getPatternLearningFeatures({
    learningFeatures: events[0].learningFeatures,
  });
  const report = evaluate(events, { paperObservations: [makeObservation(events[0])] });
  expect(comparison(report)).toMatchObject({
    examples: 1,
    coverage: 1,
    fallbackExamples: 1,
    modelUsed: { examples: 0 },
    difference: { brier: 0, accuracy: 0 },
  });
  expect(paper(report).accounts.combined.fillCount).toBe(
    paper(report).accounts.production.fillCount,
  );
});

test('keeps historical records immutable and missing versions unavailable without recomputation', () => {
  const events = recorded();
  delete events[0].patternLearningFeatures;
  delete events[0].patternShadowPredictions;
  const before = JSON.stringify(events);
  const report = evaluate(events);
  expect(comparison(report).examples).toBe(0);
  expect(report.counts.independentWindows).toBe(1);
  expect(report.featureAvailability.reasons['snapshot-not-recorded']).toBe(1);
  expect(JSON.stringify(events)).toBe(before);
});

test.each(['trainedAt', 'featureCutoffAt'])(
  'rejects noncausal saved %s without computing replacement probabilities',
  (field) => {
    const events = recorded();
    for (const prediction of events[0].patternShadowPredictions) prediction[field] = NOW + 1;
    expect(comparison(evaluate(events)).examples).toBe(0);
  },
);

test('does not combine separately trained family ablations or overwrite contradictory saved predictions', () => {
  const events = recorded();
  const ablation = events[0].patternShadowPredictions.find(
    (prediction) => prediction.kind === 'without-candles',
  );
  ablation.suiteId = `${START - 2}-abc`;
  ablation.trainedAt = START - 2;
  expect(comparison(evaluate(events), 'combined', 'without-candles').examples).toBe(0);
  const changed = JSON.parse(JSON.stringify(events[0]));
  changed.patternShadowPredictions[0].aboveProbability = 0.1;
  expect(evaluate([...events, changed]).counts).toMatchObject({
    conflictingCaptures: 1,
    independentWindows: 0,
  });
});

test('does not replace the first missing capture with a later available duplicate', () => {
  const events = recorded();
  const later = JSON.parse(JSON.stringify(events));
  events[0].patternShadowPredictions = [];
  for (const event of later) {
    event.forecastId += '-later';
    event.eventId += '-later';
    event.capturedAt += 1000;
    event.featureCutoffAt += 1000;
    event.inputObservedAt += 1000;
    event.recordedAt += 1000;
    event.patternShadowPredictions.forEach((prediction) => {
      prediction.featureCutoffAt += 1000;
    });
  }
  expect(comparison(evaluate([...events, ...later])).examples).toBe(0);
});

test('paper comparison uses independent observed delayed books and identical after-cost bankroll rules', () => {
  const first = recorded(0);
  const second = recorded(1, { result: 'no', production: 0.65, combined: 0.15 });
  const report = evaluate([...first, ...second], {
    paperObservations: [makeObservation(first[0]), makeObservation(second[0])],
  });
  expect(paper(report)).toMatchObject({
    opportunities: 2,
    initialBooks: 2,
    delayedBooks: 2,
    independentObservations: 2,
  });
  const production = paper(report).accounts.production;
  const combined = paper(report).accounts.combined;
  expect(production).toMatchObject({ tradeAttempts: 2, fillCount: 2, skips: 0, settledCount: 2 });
  expect(combined).toMatchObject({ tradeAttempts: 2, fillCount: 2, skips: 0, settledCount: 2 });
  expect(production.policy).toEqual(combined.policy);
  expect(production.netProfit).toBeLessThan(0);
  expect(production.drawdown).toBeGreaterThan(0.5);
  expect(combined.netProfit).toBeGreaterThan(0.8);
  expect(combined.fees).toBeGreaterThan(0);
  expect(combined.recentDecisions[0].averageFillPrice).toBe(0.56);
});

test('unobserved books remain skips or no-fills and quotes cannot invent executable prices', () => {
  const events = recorded();
  events[0].kalshiQuote = { yesBid: 0.4, yesAsk: 0.5 };
  expect(paper(evaluate(events)).accounts.combined).toMatchObject({ fillCount: 0, skips: 1 });
  const observed = makeObservation(events[0]);
  observed.execution = null;
  const report = evaluate(events, { paperObservations: [observed] });
  expect(paper(report).accounts.combined).toMatchObject({
    tradeAttempts: 1,
    fillCount: 0,
    noFillCount: 1,
    netProfit: 0,
  });
  expect(paper(report).accounts.combined.skipReasons.execution_window_expired).toBe(1);
});

test('unresolved opportunities stay in the paper ledger and future settlement never frees capital early', () => {
  const events = recorded();
  const report = evaluate(events, {
    paperObservations: [makeObservation(events[0])],
    now: events[0].capturedAt + 3000,
  });
  expect(paper(report).accounts.combined).toMatchObject({
    decisionCount: 1,
    fillCount: 1,
    settledCount: 0,
    netProfit: 0,
    openPositionCount: 1,
  });
  expect(report.counts.independentWindows).toBe(0);
});

test('legacy paper observations retain their sampling limitation and omit future books', () => {
  const [decision] = recorded();
  const saved = {
    id: 'paper-original',
    contract: decision.kalshiMarket,
    decidedAt: decision.capturedAt,
    forecast: { capturedAt: decision.capturedAt },
    book: { receivedAt: decision.capturedAt },
  };
  const observed = getPatternPaperObservations({
    decisions: [saved],
    events: [
      { decisionId: saved.id, kind: 'fill', recordedAt: NOW + 1, book: { receivedAt: NOW + 1 } },
    ],
    now: NOW,
  });
  expect(observed[0]).toMatchObject({ source: 'legacy-production-selected', execution: null });
});

test('contradictory official labels at different checkpoints cannot select a favorable result', () => {
  const events = [
    ...recorded(0, { checkpoint: 6, result: 'yes' }),
    ...recorded(0, { checkpoint: 3, result: 'no' }),
  ];
  const report = evaluate(events);
  expect(report.counts).toMatchObject({ independentWindows: 0, conflictingCaptures: 2 });
  expect(comparison(report).examples).toBe(0);
});

test('distinguishes raw baseline from production and rejects future or malformed optional snapshots', () => {
  const events = recorded();
  events[0].aboveProbability = 0.95;
  events[0].belowProbability = 0.05;
  const report = evaluate(events);
  expect(comparison(report, 'combined', 'raw-baseline').comparatorMetrics.brier).toBeCloseTo(
    (1 - 0.65) ** 2,
  );
  expect(comparison(report).comparatorMetrics.brier).toBeCloseTo((1 - 0.95) ** 2);
  events[0].patternLearningFeatures.availableAt = NOW + 1;
  const invalid = evaluate(events);
  expect(comparison(invalid).examples).toBe(0);
  expect(invalid.featureAvailability.reasons['invalid-snapshot']).toBe(1);
  expect(invalid.counts.independentWindows).toBe(1);
});

test('an as-of report does not count or trade an execution book observed later', () => {
  const events = recorded();
  const observed = makeObservation(events[0]);
  const report = evaluate(events, {
    paperObservations: [observed],
    now: events[0].capturedAt + 1000,
  });
  expect(paper(report).delayedBooks).toBe(0);
  expect(paper(report).accounts.combined).toMatchObject({ fillCount: 0, pendingIntentCount: 1 });
});

test('an execution book preceding the latency boundary never becomes a fill or a permanent reservation', () => {
  const events = recorded();
  const observed = makeObservation(events[0]);
  observed.execution.observedAt = events[0].capturedAt + 1000;
  observed.execution.book.receivedAt = observed.execution.observedAt;
  observed.execution.book.requestedAt = observed.execution.observedAt;
  const report = evaluate(events, { paperObservations: [observed] });
  expect(paper(report).accounts.combined).toMatchObject({
    fillCount: 0,
    noFillCount: 1,
    pendingIntentCount: 0,
    netProfit: 0,
  });
});

test('matched capital starts at suite registration and ignores an earlier production-only loss', () => {
  const earlier = recorded(0, { result: 'no', production: 0.65 });
  earlier[0].patternShadowPredictions = [];
  const shared = recorded(1, { production: 0.65, combined: 0.65 });
  const report = evaluate([...earlier, ...shared], {
    patternSuites: [registration({ registeredAt: START + 600000 })],
    paperObservations: [makeObservation(earlier[0]), makeObservation(shared[0])],
  });
  const matched = paper(report);
  expect(matched.counts).toMatchObject({ eligibleContracts: 1, beforeBoundary: 1 });
  expect(matched.firstContractStartsAt).toBe(START + 900000);
  const reference = matched.accounts.production;
  for (const kind of ['raw-baseline', ...PATTERN_CANDIDATE_KINDS]) {
    const candidate = matched.accounts[kind];
    expect(candidate).toMatchObject({
      initialBankroll: reference.initialBankroll,
      cash: reference.cash,
      netProfit: reference.netProfit,
      drawdown: reference.drawdown,
      tradeAttempts: reference.tradeAttempts,
      fillCount: reference.fillCount,
      skips: reference.skips,
    });
  }
  expect(report.paper.productionHistory.accounts.production.netProfit).toBeLessThan(
    reference.netProfit,
  );
  expect(report.paper.productionHistory.comparableToCandidates).toBe(false);
  expect(report.paper.accounts).toBeUndefined();
});

test('an enrolled contract remains in matched paper results when patterns or execution coverage are missing', () => {
  const complete = recorded(0, { combined: 0.65 });
  const fallback = recorded(1, { result: 'no', combined: 0.65 });
  fallback[0].patternLearningFeatures = getPatternLearningFeatures({
    learningFeatures: fallback[0].learningFeatures,
  });
  fallback[0].patternShadowPredictions.forEach((prediction) => {
    prediction.modelUsed = false;
  });
  const missing = recorded(2);
  missing[0].patternShadowPredictions = [];
  delete missing[0].patternLearningFeatures;
  const observation = makeObservation(fallback[0]);
  observation.execution = null;
  const report = evaluate([...complete, ...fallback, ...missing], {
    paperObservations: [makeObservation(complete[0]), observation],
  });
  expect(paper(report).counts.eligibleContracts).toBe(3);
  expect(paper(report).predictionCoverage.combined).toEqual({
    available: 2,
    missing: 1,
    fallback: 1,
  });
  expect(paper(report).accounts.combined).toMatchObject({
    decisionCount: 3,
    fillCount: 1,
    noFillCount: 1,
    skips: 1,
  });
  expect(paper(report).coverage.delayedBooks).toBeCloseTo(1 / 3);
});

test('outcomes and eventual pattern availability cannot change registered prospective cohort membership', () => {
  const events = [0, 1, 2].flatMap((index) => recorded(index));
  const options = { now: NOW, patternSuites: [registration({ registeredAt: START + 500000 })] };
  const before = getPatternProspectiveCohorts(events, options);
  const altered = events
    .filter((event) => event.event === 'decision')
    .map((event) => ({ ...event, patternLearningFeatures: null, patternShadowPredictions: [] }));
  const after = getPatternProspectiveCohorts(altered, options);
  expect(after.map((cohort) => cohort.opportunities.map((row) => row.id))).toEqual(
    before.map((cohort) => cohort.opportunities.map((row) => row.id)),
  );
  expect(before[0].opportunities).toHaveLength(2);
});

test('contracts without pre-start registration never enter matched candidate profit comparisons', () => {
  const events = recorded();
  const none = evaluate(events, {
    patternSuites: [],
    paperObservations: [makeObservation(events[0])],
  });
  expect(none.paper.cohorts).toEqual([]);
  expect(none.paper.unregisteredOpportunities).toBe(1);
  expect(none.paper.productionHistory.accounts.production.fillCount).toBe(1);
  const sameStart = evaluate(events, { patternSuites: [registration({ registeredAt: START })] });
  expect(paper(sameStart).counts.eligibleContracts).toBe(0);
});

test('a new registered suite begins only at later contract starts and never mixes ablations', () => {
  const events = [0, 1, 2].flatMap((index) => recorded(index));
  const later = registration({
    suiteId: `${START + 900000}-next`,
    trainedAt: START + 900000,
    registeredAt: START + 900000,
  });
  const report = evaluate(events, { patternSuites: [registration(), later] });
  expect(report.paper.cohorts.map((cohort) => cohort.counts.eligibleContracts)).toEqual([2, 1]);
  expect(report.paper.cohorts[1].predictionCoverage.combined).toEqual({
    available: 0,
    missing: 1,
    fallback: 0,
  });
  expect(report.paper.cohorts[0].endsAt).toBe(later.registeredAt);
});

test('training and evaluation reject the same entire contradictory contract while preserving consistent checkpoints', () => {
  const invalid = [12, 9, 6, 3, 1].flatMap((checkpoint) =>
    recorded(0, { checkpoint, result: checkpoint === 6 ? 'yes' : 'no' }),
  );
  const consistent = [12, 9, 6, 3, 1].flatMap((checkpoint) =>
    recorded(1, { checkpoint, result: 'no' }),
  );
  const events = [...invalid, ...consistent];
  const before = JSON.stringify(events);
  const training = getPatternTrainingRows(events, { now: NOW });
  const evaluation = evaluate(events);
  expect(training).toMatchObject({ rejectedContracts: 1, rejectedCaptures: 5 });
  expect(training.rows).toHaveLength(5);
  expect(new Set(training.rows.map((row) => row.marketTicker))).toEqual(
    new Set([consistent[0].kalshiMarket.ticker]),
  );
  expect(evaluation.counts).toMatchObject({
    rejectedContracts: 1,
    rejectedCaptures: 5,
    independentWindows: 1,
  });
  expect(evaluation.cohorts[0].counts).toMatchObject({
    independentWindows: 2,
    rejectedContracts: 1,
    rejectedCaptures: 5,
  });
  expect(JSON.stringify(events)).toBe(before);
});

test('a conflicting identity rejects every checkpoint before fitting, and later contradictions stay outside an as-of snapshot', () => {
  const events = [12, 9, 6, 3, 1].flatMap((checkpoint) => recorded(0, { checkpoint }));
  const invalid = JSON.parse(JSON.stringify(events));
  invalid[0].target += 1;
  expect(getPatternTrainingRows(invalid, { now: NOW })).toMatchObject({
    rows: [],
    rejectedContracts: 1,
    rejectedCaptures: 5,
  });
  expect(evaluate(invalid).counts.rejectedContracts).toBe(1);
  const late = recorded(0, { checkpoint: 6, result: 'no' })[1];
  late.recordedAt = NOW + 1;
  expect(getPatternTrainingRows([...events, late], { now: NOW }).rows).toHaveLength(5);
  expect(evaluate([...events, late]).counts.rejectedContracts).toBe(0);
});

test('nested official identity conflicts reject all checkpoints instead of silently dropping one label', () => {
  const events = [12, 9, 6, 3, 1].flatMap((checkpoint) => recorded(0, { checkpoint }));
  events[1].kalshiOutcome = { ...events[1].kalshiOutcome, target: events[1].target + 1 };
  expect(getPatternTrainingRows(events, { now: NOW })).toMatchObject({
    rows: [],
    rejectedContracts: 1,
    rejectedCaptures: 5,
  });
  expect(evaluate(events).counts).toMatchObject({
    rejectedContracts: 1,
    rejectedCaptures: 5,
    independentWindows: 0,
  });
});

test('legacy absent redundant confirmation metadata is missing coverage rather than a contradictory contract', () => {
  const events = [12, 9, 6, 3, 1].flatMap((checkpoint) => recorded(0, { checkpoint }));
  events[1].confirmedThrough = null;
  const training = getPatternTrainingRows(events, { now: NOW });
  expect(training).toMatchObject({ rejectedContracts: 0, rejectedCaptures: 0 });
  expect(training.rows).toHaveLength(4);
  expect(evaluate(events).counts.rejectedContracts).toBe(0);
  events[1].confirmedThrough = events[1].kalshiOutcome.confirmedThrough - 1;
  expect(getPatternTrainingRows(events, { now: NOW })).toMatchObject({
    rejectedContracts: 1,
    rejectedCaptures: 5,
  });
});

test('historical v4/v1 snapshots remain interpretable but cannot mix into a current v5/v2 fit', () => {
  const historical = recorded(0);
  historical[0].patternLearningFeatures.schemaVersion = 'deadline-pattern-features-v4';
  historical[0].patternLearningFeatures.patternVersion = 'brti-patterns-v1';
  historical[0].patternShadowPredictions.forEach((prediction) => {
    prediction.modelVersion = LEGACY_PATTERN_MODEL_VERSION;
    prediction.modelId = `${LEGACY_PATTERN_MODEL_VERSION}-${prediction.kind}-${prediction.suiteId}`;
  });
  const current = recorded(1);
  const events = [...historical, ...current];
  const saved = JSON.stringify(events);
  const training = getPatternTrainingRows(events, { now: NOW });
  expect(training.rows).toHaveLength(1);
  expect(training.rows[0].id).toBe(current[0].forecastId);
  expect(comparison(evaluate(events)).examples).toBe(2);
  expect(evaluate(events).cohorts[0].comparisons[0].examples).toBe(1);
  expect(JSON.stringify(events)).toBe(saved);
});

test('a contradictory frozen production capture stays an enrolled terminal failure for all paper accounts', () => {
  const events = recorded();
  const changed = { ...events[0], aboveProbability: 0.9, belowProbability: 0.1 };
  const report = evaluate([...events, changed], {
    paperObservations: [makeObservation(events[0])],
  });
  expect(paper(report).counts).toMatchObject({ eligibleContracts: 1, invalidCaptures: 1 });
  for (const account of Object.values(paper(report).accounts))
    expect(account).toMatchObject({ fillCount: 0, skips: 1 });
});
