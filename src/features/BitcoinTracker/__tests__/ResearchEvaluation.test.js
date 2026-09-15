import { evaluateResearchExperiments } from '../utils/researchEvaluation.utils';
import { getKalshiOutcome, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_CHECKPOINT_POLICY_VERSION } from '../utils/fixedPrediction.utils';

const START = Date.UTC(2026, 8, 14, 12);
const NOW = START + 2 * 24 * 60 * 60_000;
const MINUTE = 60_000;
const PROBABILITIES = {
  'settlement-only': 0.6,
  'spot-only': 0.8,
  'futures-only': 0.7,
  combined: 0.9,
};

function recordedEvent(
  index = 0,
  {
    checkpoint = 12,
    cohort = 'kalshi-background',
    outcome = 'yes',
    offset = 0,
    recorder = 'first',
  } = {},
) {
  const contract = {
    ticker: `KXBTC15M-RESEARCH${index}`,
    eventTicker: `KXBTC15M-RESEARCH${index}`,
    seriesTicker: 'KXBTC15M',
    target: 100_000,
    startsAt: START + index * 15 * MINUTE,
    expiresAt: START + (index + 1) * 15 * MINUTE,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const capturedAt = contract.expiresAt - checkpoint * MINUTE + offset;
  const forecastId = `${recorder}:${contract.ticker}:${checkpoint}`;
  const variant = (aboveProbability) => ({
    available: true,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    appliedSpot: false,
    appliedFutures: false,
    fallbacks: [],
    referencePrice: 100_010,
    referenceAt: capturedAt,
    referenceSource: 'cf-brti',
    minuteVolatility: 0.001,
    basisLogDeviation: 0,
  });
  const decision = {
    eventId: `${forecastId}:decision`,
    event: 'decision',
    forecastId,
    recordedAt: capturedAt,
    capturedAt,
    inputObservedAt: capturedAt,
    featureCutoffAt: capturedAt,
    inputStatus: 'captured',
    cohort,
    checkpointMinutes: cohort === 'manual' ? null : checkpoint,
    kalshiMarket: contract,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    windowStartAt: contract.startsAt,
    expiresAt: contract.expiresAt,
    target: contract.target,
    spot: 100_010,
    aboveProbability: 0.85,
    belowProbability: 0.15,
    researchExperiment: {
      version: 'kalshi-ablation-v1',
      capturedAt,
      marketTicker: contract.ticker,
      target: contract.target,
      expiresAt: contract.expiresAt,
      variants: Object.fromEntries(
        Object.entries(PROBABILITIES).map(([name, probability]) => [name, variant(probability)]),
      ),
      production: {
        ...variant(0.85),
        modelVersion: 'kalshi-brti-derivatives-v1',
        modelId: null,
      },
    },
  };
  const publishedAt = contract.expiresAt + 5000;
  const kalshiOutcome = getKalshiOutcome(
    {
      ...contract,
      status: 'finalized',
      result: outcome,
      settlementPrice: outcome === 'yes' ? 100_020 : 99_980,
      receivedAt: publishedAt,
    },
    publishedAt,
  );
  const resolved = {
    ...decision,
    eventId: `${forecastId}:outcome`,
    event: 'outcome',
    researchExperiment: null,
    recordedAt: publishedAt,
    inputStatus: 'outcome-only',
    inputObservedAt: null,
    featureCutoffAt: null,
    outcomeStatus: 'observed',
    kalshiOutcome,
    observedPrice: kalshiOutcome.observedPrice,
    observedAt: kalshiOutcome.observedAt,
    confirmedThrough: kalshiOutcome.confirmedThrough,
    outcome: kalshiOutcome.outcome,
  };
  return [decision, resolved];
}

const evaluate = (events, options = {}) =>
  evaluateResearchExperiments(events, { now: NOW, ...options });
const checkpoint = (report, minutes = 12) =>
  report.checkpoints.find((row) => row.checkpointMinutes === minutes);
const savedCheckpoint = (report, minutes = 9, captureOrigin = 'manual') =>
  report.savedFixedCheckpoints.find(
    (row) => row.checkpointMinutes === minutes && row.captureOrigin === captureOrigin,
  );
function savedFixedEvent(index = 0, { checkpoint = 9, captureOrigin = 'manual', ...options } = {}) {
  return recordedEvent(index, {
    recorder: `saved-${captureOrigin}`,
    ...options,
    checkpoint,
    cohort: 'manual',
  }).map((row) => ({
    ...row,
    checkpointMinutes: checkpoint,
    policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION,
    captureOrigin,
  }));
}
const variant = (decision, name = 'combined') => decision.researchExperiment.variants[name];
function changeProbability(decision, name, probability) {
  Object.assign(variant(decision, name), {
    aboveProbability: probability,
    belowProbability: 1 - probability,
  });
}

test('scores recorded variants on identical captures and reports candidate-minus-comparator errors', () => {
  const report = evaluate(recordedEvent());
  const row = checkpoint(report);
  expect(report.counts).toMatchObject({
    uniqueContracts: 1,
    independentWindows: 1,
    recordedExperiments: 1,
  });
  expect(row.variants.combined.metrics).toMatchObject({
    examples: 1,
    accuracy: 1,
    directionalAccuracy: 1,
  });
  expect(row.variants.combined.metrics.brier).toBeCloseTo(0.01);
  expect(row.variants.combined.metrics.logLoss).toBeCloseTo(-Math.log(0.9));
  const pair = row.variants.combined.comparisons['settlement-only'];
  expect(pair).toMatchObject({
    scoredPairs: 1,
    availablePairs: 1,
    differentProbabilities: 1,
    pairCoverage: 1,
    outcomeCoverage: 1,
  });
  expect(pair.delta.brier).toBeCloseTo(-0.15);
  expect(pair.delta.logLoss).toBeCloseTo(Math.log(0.6 / 0.9));
  expect(pair.delta.accuracy).toBe(0);
  expect(row.variants.production.metrics.brier).toBeCloseTo(0.15 ** 2);
});

test('retains neutral probability scores without claiming a directional win', () => {
  const events = recordedEvent();
  changeProbability(events[0], 'combined', 0.5);
  expect(checkpoint(evaluate(events)).variants.combined.metrics).toMatchObject({
    examples: 1,
    brier: 0.25,
    accuracy: 0.5,
    directionalCalls: 0,
    directionalAccuracy: null,
    expectedCalibrationError: 0.5,
  });
});

test('scores recorded settlement intervals against official prices and leaves absent production ranges unavailable', () => {
  const covered = recordedEvent();
  const missed = recordedEvent(1, { outcome: 'no' });
  Object.assign(variant(covered[0]), {
    settlementLowerBound: 100_010,
    settlementUpperBound: 100_030,
  });
  Object.assign(variant(missed[0]), {
    settlementLowerBound: 99_990,
    settlementUpperBound: 100_005,
  });
  const row = checkpoint(evaluate([...covered, ...missed]));
  expect(row.variants.combined.metrics.interval).toEqual({
    nominalCoverage: 0.8,
    scoredIntervals: 2,
    observedCoverage: 0.5,
    unavailableIntervals: 0,
  });
  expect(
    row.variants.combined.comparisons['settlement-only'].variant.interval.observedCoverage,
  ).toBe(0.5);
  expect(row.variants.production.metrics.interval).toEqual({
    nominalCoverage: 0.8,
    scoredIntervals: 0,
    observedCoverage: null,
    unavailableIntervals: 2,
  });
});

test('invalid, inverted and missing interval bounds are excluded without reconstructing a price range', () => {
  const bounds = [
    [100_020, 100_020],
    [0, 100_030],
    [100_030, 100_010],
    [NaN, 100_030],
    [100_010, Infinity],
    [null, null],
  ];
  const events = bounds.flatMap(([lower, upper], index) => {
    const rows = recordedEvent(index);
    Object.assign(variant(rows[0]), { settlementLowerBound: lower, settlementUpperBound: upper });
    return rows;
  });
  const interval = checkpoint(evaluate(events)).variants.combined.metrics.interval;
  expect(interval).toEqual({
    nominalCoverage: 0.8,
    scoredIntervals: 1,
    observedCoverage: 1,
    unavailableIntervals: 5,
  });
  expect(checkpoint(evaluate([])).variants.combined.metrics.interval.observedCoverage).toBeNull();
});

test('keeps all five checkpoint reports separate without counting one contract as five independent events', () => {
  const rows = [12, 9, 6, 3, 1].flatMap((minutes) => recordedEvent(0, { checkpoint: minutes }));
  const report = evaluate(rows);
  expect(report.counts).toMatchObject({ decisions: 5, uniqueContracts: 1, independentWindows: 1 });
  for (const row of report.checkpoints) expect(row.variants.combined.metrics.examples).toBe(1);
  expect(checkpoint(report, 1).finalMinute).toBe(true);
  expect(checkpoint(report, 3).finalMinute).toBe(false);
  expect(report).not.toHaveProperty('metrics');
});

test('manual Fixed captures and final-minute horizons are kept apart from background checkpoints', () => {
  const report = evaluate([
    ...recordedEvent(),
    ...recordedEvent(0, { cohort: 'manual', checkpoint: 0.5, recorder: 'manual' }),
    ...recordedEvent(1, { cohort: 'manual', checkpoint: 8, recorder: 'manual' }),
  ]);
  expect(checkpoint(report).decisions).toBe(1);
  expect(report.manualFixed.decisions).toBe(2);
  expect(report.manualFixed.byHorizon[0]).toMatchObject({ finalMinute: true, decisions: 1 });
  expect(report.manualFixed.byHorizon.find((row) => row.label === '6–10 minutes').decisions).toBe(
    1,
  );
});

test('retains both saved 9- and 6-minute predictions without counting their shared contract twice', () => {
  const first = savedFixedEvent();
  const second = savedFixedEvent(0, { checkpoint: 6 });
  const repeat = savedFixedEvent(0, { recorder: 'later-manual', offset: 1000 });
  const report = evaluate([...first, ...second, ...repeat]);
  expect(report.counts).toMatchObject({
    decisions: 2,
    recordedExperiments: 2,
    uniqueContracts: 1,
    independentWindows: 1,
  });
  expect(savedCheckpoint(report, 9)).toMatchObject({
    decisions: 1,
    duplicateDecisions: 1,
    independentWindows: 1,
  });
  expect(savedCheckpoint(report, 6)).toMatchObject({
    decisions: 1,
    duplicateDecisions: 0,
    independentWindows: 1,
  });
  expect(savedCheckpoint(report, 9).variants.production.metrics.examples).toBe(1);
  expect(savedCheckpoint(report, 6).variants.production.metrics.examples).toBe(1);
  expect(
    savedCheckpoint(report, 6).variants.combined.comparisons['settlement-only'].independentWindows,
  ).toBe(1);
  expect(report.manualFixed.decisions).toBe(0);
  expect(report.checkpoints.every((row) => row.decisions === 0)).toBe(true);
});

test('automatic saved predictions remain separate from manual captures and background research', () => {
  const background = recordedEvent(0, { checkpoint: 9 });
  const manual = savedFixedEvent();
  const automatic = savedFixedEvent(0, { captureOrigin: 'automatic' });
  const legacy = recordedEvent(0, { cohort: 'manual', checkpoint: 8, recorder: 'legacy-manual' });
  const report = evaluate([...background, ...manual, ...automatic, ...legacy]);
  expect(report.counts).toMatchObject({ decisions: 4, uniqueContracts: 1, independentWindows: 1 });
  expect(savedCheckpoint(report, 9, 'manual').variants.production.metrics.examples).toBe(1);
  expect(savedCheckpoint(report, 9, 'automatic').variants.production.metrics.examples).toBe(1);
  expect(report.checkpoints).toEqual(evaluate(background).checkpoints);
  expect(report.manualFixed).toEqual(evaluate(legacy).manualFixed);
  expect(report.savedFixedCheckpoints).toHaveLength(10);
  expect(report.savedFixedCheckpoints.filter((row) => row.finalMinute)).toHaveLength(2);
});

test.each([-1, 5001])(
  'saved checkpoint capture offset %i is excluded from scores without hiding the missed call',
  (offset) => {
    const report = evaluate(savedFixedEvent(0, { offset }));
    const saved = savedCheckpoint(report);
    expect(saved).toMatchObject({ decisions: 1, recordedExperiments: 0, independentWindows: 1 });
    expect(saved.missingReasons['checkpoint-time-mismatch']).toBe(1);
    expect(saved.variants.production.metrics.examples).toBe(0);
    expect(report.counts.independentWindows).toBe(1);
  },
);

test.each([0, 5000])(
  'saved checkpoint capture offset %i remains inside the original grace window',
  (offset) => {
    const report = evaluate(savedFixedEvent(0, { offset }));
    expect(savedCheckpoint(report).variants.production.metrics.examples).toBe(1);
  },
);

test('a later successful saved recorder cannot replace an earlier checkpoint with missing input', () => {
  const first = savedFixedEvent();
  first[0].researchExperiment = null;
  const later = savedFixedEvent(0, { recorder: 'later', offset: 1000 });
  const saved = savedCheckpoint(evaluate([...later, ...first]));
  expect(saved).toMatchObject({ decisions: 1, duplicateDecisions: 1, recordedExperiments: 0 });
  expect(saved.missingReasons['experiment-not-recorded']).toBe(1);
  expect(saved.variants.production.metrics.examples).toBe(0);
});

test('changing the origin of the same saved forecast creates a conflict instead of a second valid trial', () => {
  const manual = savedFixedEvent();
  const changed = { ...manual[0], captureOrigin: 'automatic' };
  const report = evaluate([...manual, changed]);
  for (const origin of ['manual', 'automatic']) {
    expect(savedCheckpoint(report, 9, origin).conflictingDecisions).toBe(1);
    expect(savedCheckpoint(report, 9, origin).variants.production.metrics.examples).toBe(0);
  }
  expect(report.counts.independentWindows).toBe(1);
});

test('omitted optional origin defaults to manual while unsupported checkpoint metadata is not legacy data', () => {
  const missingOrigin = savedFixedEvent();
  for (const row of missingOrigin) delete row.captureOrigin;
  expect(savedCheckpoint(evaluate(missingOrigin)).variants.production.metrics.examples).toBe(1);
  for (const change of [
    { checkpointMinutes: 2 },
    { checkpointMinutes: null },
    { captureOrigin: 'research' },
    { captureOrigin: null },
    { policyVersion: 'kalshi-snapshot-v4' },
  ]) {
    const rows = savedFixedEvent();
    Object.assign(rows[0], change);
    const report = evaluate(rows);
    expect(report.counts.unsupportedDecisions).toBe(1);
    expect(report.manualFixed.decisions).toBe(0);
    expect(report.counts.decisions).toBe(0);
  }
});

test('duplicates and later collectors cannot replace an earlier missing experiment with a successful one', () => {
  const first = recordedEvent();
  first[0].researchExperiment = null;
  const later = recordedEvent(0, { recorder: 'second', offset: 1000 });
  const row = checkpoint(evaluate([...later, ...first, ...first]));
  expect(row).toMatchObject({ decisions: 1, duplicateDecisions: 2, recordedExperiments: 0 });
  expect(row.missingReasons['experiment-not-recorded']).toBe(1);
  expect(row.variants.combined).toMatchObject({
    estimates: 0,
    callCoverage: 0,
    scoredEstimates: 0,
  });
});

test('identical records with reordered object properties remain one non-conflicting capture', () => {
  const events = recordedEvent();
  const duplicate = {
    ...events[0],
    researchExperiment: Object.fromEntries(Object.entries(events[0].researchExperiment).reverse()),
  };
  const row = checkpoint(evaluate([...events, duplicate]));
  expect(row).toMatchObject({ decisions: 1, duplicateDecisions: 1, conflictingDecisions: 0 });
  expect(row.variants.combined.metrics.examples).toBe(1);
});

test('conflicting predictions at the same capture and altered decisions for one forecast are excluded', () => {
  const first = recordedEvent();
  const conflicting = recordedEvent(0, { recorder: 'second' });
  changeProbability(conflicting[0], 'combined', 0.1);
  const report = evaluate([...first, ...conflicting]);
  expect(checkpoint(report)).toMatchObject({ conflictingDecisions: 1, recordedExperiments: 0 });
  expect(checkpoint(report).variants.combined.metrics.examples).toBe(0);
  const altered = recordedEvent(0, { offset: 1000 });
  expect(checkpoint(evaluate([...first, ...altered])).conflictingDecisions).toBe(1);
});

test('a ticker with contradictory immutable targets cannot become two valid independent contracts', () => {
  const first = recordedEvent();
  const second = recordedEvent(0, { recorder: 'second' });
  second[0].kalshiMarket = { ...second[0].kalshiMarket, target: 100_100 };
  second[0].target = 100_100;
  const row = checkpoint(evaluate([...first, second[0]]));
  expect(row.conflictingDecisions).toBe(1);
  expect(row.variants.combined.metrics.examples).toBe(0);
});

test('uses only an official matching finalized outcome, never a later price or a foreign target', () => {
  const events = recordedEvent();
  const invalid = {
    ...events[1],
    kalshiOutcome: { ...events[1].kalshiOutcome, status: 'waiting' },
  };
  const invalidReport = checkpoint(evaluate([events[0], invalid]));
  expect(invalidReport.outcomes.invalid).toBe(1);
  expect(invalidReport.variants.combined).toMatchObject({
    estimates: 1,
    scoredEstimates: 0,
    outcomeCoverage: 0,
  });
  const wrongTarget = {
    ...events[1],
    kalshiOutcome: { ...events[1].kalshiOutcome, target: 110_000 },
  };
  expect(checkpoint(evaluate([events[0], wrongTarget])).outcomes.invalid).toBe(1);
});

test('contradictory official outcomes are explicit and cannot choose a convenient winner', () => {
  const yes = recordedEvent();
  const no = recordedEvent(0, { recorder: 'second', outcome: 'no' });
  const report = checkpoint(evaluate([...yes, no[1]]));
  expect(report.outcomes.conflicting).toBe(1);
  expect(report.variants.combined.metrics.examples).toBe(0);
});

test('shares a verified immutable contract outcome across recorders without changing which capture was selected', () => {
  const first = recordedEvent();
  const second = recordedEvent(0, { recorder: 'second', offset: 1000 });
  const row = checkpoint(evaluate([first[0], second[1]]));
  expect(row.outcomes.verified).toBe(1);
  expect(row.variants.combined.metrics.examples).toBe(1);
});

test('future outcomes remain unresolved at the historical evaluation cutoff', () => {
  const events = recordedEvent();
  const report = evaluate(events, { now: events[0].capturedAt + 1000 });
  expect(report.counts.futureRows).toBe(1);
  expect(checkpoint(report).outcomes.unresolved).toBe(1);
  expect(checkpoint(report).variants.combined.metrics.examples).toBe(0);
});

test('never turns observations or legacy forecasts into reconstructed experiments', () => {
  const events = recordedEvent();
  const observation = { ...events[0], event: 'observation', eventId: 'observation' };
  events[0].researchExperiment = null;
  const report = evaluate([...events, observation]);
  expect(report.status).toBe('no-recorded-experiments');
  expect(report.counts.ignoredRows).toBe(1);
  expect(checkpoint(report).variants.combined.metrics.examples).toBe(0);
});

test.each([
  [
    'a changed feature cutoff',
    (row) => {
      row.featureCutoffAt++;
    },
  ],
  [
    'an after-deadline decision',
    (row) => {
      row.recordedAt = row.expiresAt;
    },
  ],
  [
    'a restored decision',
    (row) => {
      row.inputStatus = 'restored-without-inputs';
    },
  ],
  [
    'an experiment captured later',
    (row) => {
      row.researchExperiment.capturedAt++;
    },
  ],
  [
    'a missed checkpoint',
    (row) => {
      row.checkpointMinutes = 9;
    },
  ],
])('does not score %s as a contemporaneous prediction', (_, alter) => {
  const events = recordedEvent();
  alter(events[0]);
  const report = evaluate(events);
  expect(report.counts.recordedExperiments).toBe(0);
  expect(report.checkpoints.every((row) => row.variants.combined.metrics.examples === 0)).toBe(
    true,
  );
});

test('probabilities are fractions; malformed or missing variants do not disable valid paired variants', () => {
  const events = recordedEvent();
  variant(events[0]).aboveProbability = 90;
  variant(events[0]).belowProbability = 10;
  delete events[0].researchExperiment.variants['futures-only'];
  const row = checkpoint(evaluate(events));
  expect(row.variants.combined.unavailableReasons['invalid-probability']).toBe(1);
  expect(row.variants['futures-only'].unavailableReasons['variant-not-recorded']).toBe(1);
  expect(row.variants['spot-only'].comparisons['settlement-only'].scoredPairs).toBe(1);
  expect(row.variants['spot-only'].comparisons.combined.scoredPairs).toBe(0);
});

test('unavailable feeds, fallbacks and unresolved outcomes remain visible in coverage denominators', () => {
  const first = recordedEvent();
  const second = recordedEvent(1);
  const third = recordedEvent(2);
  Object.assign(variant(first[0]), { appliedSpot: true, fallbacks: ['futures-unavailable'] });
  Object.assign(variant(second[0]), {
    available: false,
    aboveProbability: null,
    belowProbability: null,
    reason: 'no-reference',
  });
  const row = checkpoint(evaluate([...first, ...second, third[0]]));
  expect(row.outcomes).toMatchObject({ verified: 2, unresolved: 1 });
  expect(row.variants.combined).toMatchObject({
    estimates: 2,
    scoredEstimates: 1,
    callCoverage: 2 / 3,
    outcomeCoverage: 0.5,
    fallbackEstimates: 1,
    spotApplied: 1,
  });
  expect(row.variants.combined.fallbackReasons['futures-unavailable']).toBe(1);
  expect(row.variants.combined.unavailableReasons['no-reference']).toBe(1);
  expect(row.variants.combined.comparisons['settlement-only']).toMatchObject({
    availablePairs: 2,
    scoredPairs: 1,
    pairsWithFallback: 1,
  });
});

test('paired effects require the same reference and volatility inputs', () => {
  const events = recordedEvent();
  variant(events[0]).minuteVolatility = 0.002;
  const pair = checkpoint(evaluate(events)).variants.combined.comparisons['settlement-only'];
  expect(pair).toMatchObject({ availablePairs: 0, mismatchedReferences: 1, scoredPairs: 0 });
  expect(pair.delta.brier).toBeNull();
});

test('an available variant needs a recorded reference no later than its prediction capture', () => {
  const events = recordedEvent();
  delete variant(events[0], 'spot-only').referenceAt;
  variant(events[0], 'futures-only').referenceAt++;
  const row = checkpoint(evaluate(events));
  expect(row.variants['spot-only'].unavailableReasons['invalid-reference']).toBe(1);
  expect(row.variants['futures-only'].unavailableReasons['invalid-reference']).toBe(1);
  expect(row.variants.combined.metrics.examples).toBe(1);
});

test('consecutive-event block sensitivity is deterministic and never grants activation', () => {
  const events = Array.from({ length: 16 }, (_, index) =>
    recordedEvent(index, { outcome: index % 2 ? 'yes' : 'no' }),
  ).flat();
  const first = checkpoint(evaluate(events)).variants.combined.comparisons['settlement-only'];
  const second = checkpoint(evaluate(events)).variants.combined.comparisons['settlement-only'];
  expect(first.sensitivity).toEqual(second.sensitivity);
  expect(first.sensitivity[0]).toMatchObject({
    requestedBlockLength: 4,
    independentWindows: 16,
    blocks: 4,
    blockSizes: [4, 4, 4, 4],
    sensitivityOnly: true,
  });
  expect(first.sensitivity[1]).toMatchObject({
    requestedBlockLength: 8,
    blocks: 2,
    blockSizes: [8, 8],
  });
  expect(first.sensitivity[0].intervals.brier).toHaveLength(2);
  expect(first).not.toHaveProperty('eligibleForPromotion');
  expect(first).not.toHaveProperty('passed');
});

test('reordered database rows do not change which captures or bootstrap samples are scored', () => {
  const events = Array.from({ length: 12 }, (_, index) =>
    recordedEvent(index, { outcome: index % 2 ? 'yes' : 'no' }),
  ).flat();
  expect(evaluate([...events].reverse())).toEqual(evaluate(events));
});

test('block sensitivity does not bridge unobserved time gaps or claim intervals from one block', () => {
  const sparse = [0, 2, 4].flatMap((index) => recordedEvent(index));
  const pair = checkpoint(evaluate(sparse)).variants.combined.comparisons['settlement-only'];
  expect(pair.sensitivity[0].blockSizes).toEqual([1, 1, 1]);
  const small = checkpoint(evaluate(recordedEvent())).variants.combined.comparisons[
    'settlement-only'
  ];
  expect(small.sensitivity.every((row) => row.intervals === null)).toBe(true);
});

test('empty evidence reports missing results and evaluation does not modify its inputs', () => {
  const empty = evaluate([]);
  expect(empty.status).toBe('no-recorded-experiments');
  expect(checkpoint(empty).variants.combined.metrics.brier).toBeNull();
  const events = recordedEvent();
  const original = JSON.stringify(events);
  evaluate(events);
  expect(JSON.stringify(events)).toBe(original);
  expect(() => evaluateResearchExperiments([], { now: NaN })).toThrow('valid evaluation timestamp');
});
