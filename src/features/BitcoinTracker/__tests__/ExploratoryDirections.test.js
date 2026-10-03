import { compareExploratoryDirections } from '../utils/exploratoryDirections.utils';
import { getKalshiOutcome, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import {
  DERIVATIVES_LEARNING_FEATURE_NAMES,
  DERIVATIVES_LEARNING_FEATURE_VERSION,
} from '../utils/learning/features.utils';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 18, 12);
const AS_OF = START + 24 * 60 * MINUTE;

function recordedWindow(
  index,
  {
    startsAt = START + index * 30 * MINUTE,
    checkpoints = [12],
    outcome = 1,
    resolvedAt = startsAt + 15 * MINUTE + 1000,
    recorder = 'first',
    captureOffset = 0,
    values = {},
    targetDistance = 0.25,
    probability = 0.75,
    marketProbability = 0.75,
    marketAvailable = true,
    spot = 100_010,
  } = {},
) {
  const contract = {
    ticker: `KXBTC15M-EXPLORE${index}`,
    eventTicker: `KXBTC15M-EXPLORE${index}`,
    seriesTicker: 'KXBTC15M',
    target: 100_000,
    startsAt,
    expiresAt: startsAt + 15 * MINUTE,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  return checkpoints.flatMap((checkpointMinutes) => {
    const capturedAt = contract.expiresAt - checkpointMinutes * MINUTE + captureOffset;
    const forecastId = `${recorder}:${contract.ticker}:${checkpointMinutes}`;
    const decision = {
      eventId: `${forecastId}:decision`,
      event: 'decision',
      forecastId,
      source: 'kalshi',
      recordedAt: capturedAt,
      capturedAt,
      inputObservedAt: capturedAt,
      featureCutoffAt: capturedAt,
      inputStatus: 'captured',
      cohort: 'kalshi-background',
      checkpointMinutes,
      kalshiMarket: contract,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      windowStartAt: startsAt,
      expiresAt: contract.expiresAt,
      target: contract.target,
      spot,
      aboveProbability: probability,
      belowProbability: 1 - probability,
      learningFeatures: {
        schemaVersion: DERIVATIVES_LEARNING_FEATURE_VERSION,
        available: true,
        values: DERIVATIVES_LEARNING_FEATURE_NAMES.map((name) => values[name] ?? 0),
        baselineAboveProbability: probability,
        targetDistance,
        target: contract.target,
        expiresAt: contract.expiresAt,
        featureCutoffAt: capturedAt,
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        referenceSource: 'cf-brti',
        featureInputSource: 'cf-brti-history',
        baselineModelVersion: 'kalshi-brti-derivatives-v2',
        settlementKnownFraction: 0,
      },
      researchExperiment: {
        version: 'kalshi-ablation-v4',
        variants: {
          'market-only': { available: marketAvailable, aboveProbability: marketProbability },
        },
      },
    };
    const kalshiOutcome = getKalshiOutcome(
      {
        ...contract,
        status: 'finalized',
        result: outcome ? 'yes' : 'no',
        settlementPrice: outcome ? 100_020 : 99_980,
        receivedAt: resolvedAt,
      },
      resolvedAt,
    );
    return [
      decision,
      {
        ...decision,
        eventId: `${forecastId}:outcome`,
        event: 'outcome',
        recordedAt: resolvedAt,
        researchExperiment: null,
        outcomeStatus: 'observed',
        kalshiOutcome,
        observedPrice: kalshiOutcome.observedPrice,
        observedAt: kalshiOutcome.observedAt,
        confirmedThrough: kalshiOutcome.confirmedThrough,
        outcome: kalshiOutcome.outcome,
      },
    ];
  });
}

const compare = (events, asOf = AS_OF) => compareExploratoryDirections(events, { asOf });
const rule = (report, name, { partition = 'holdout', minutes = null } = {}) =>
  report[partition].comparisons
    .find((comparison) => comparison.checkpointMinutes === minutes)
    .rules.find((comparison) => comparison.rule === name);

test('deduplicates the earliest capture before scoring and preserves its original values', () => {
  const original = recordedWindow(0, { outcome: 0, values: { return3: -0.2 } });
  const later = recordedWindow(0, {
    outcome: 0,
    recorder: 'duplicate',
    captureOffset: 1000,
    values: { return3: 0.2 },
  });
  const events = [...later, ...original];
  const before = JSON.stringify(events);
  const report = compare(events);
  expect(report.counts).toMatchObject({ duplicateDecisions: 1, scoredRows: 1, contracts: 1 });
  expect(rule(report, 'momentum3')).toMatchObject({ correct: 1, beneficialChanges: 1 });
  expect(JSON.stringify(events)).toBe(before);
});

test('does not replace an unresolved earliest capture with a later resolved duplicate', () => {
  const [unresolved] = recordedWindow(0);
  const later = recordedWindow(0, { recorder: 'duplicate', captureOffset: 1000 });
  expect(compare([unresolved, ...later]).counts).toMatchObject({
    selectedDecisions: 1,
    selectedWithoutVerifiedFeaturesOrOutcome: 1,
    scoredRows: 0,
  });
});

test('excludes a known unreplayable earliest capture without substituting a replayable duplicate', () => {
  const original = recordedWindow(0);
  original[0].researchReplay = { replayable: false, status: 'stored' };
  const later = recordedWindow(0, { recorder: 'duplicate', captureOffset: 1000 });
  later[0].researchReplay = { replayable: true, status: 'stored' };
  const report = compare([...later, ...original]);
  expect(report.analysisVersion).toBe('simple-directional-rules-v2');
  expect(report.counts).toMatchObject({
    selectedDecisions: 1,
    duplicateDecisions: 1,
    excludedKnownUnreplayableCaptures: 1,
    selectedWithoutVerifiedFeaturesOrOutcome: 0,
    scoredRows: 0,
  });
});

test('known unreplayable future futures timestamps cannot strengthen a rule comparison', () => {
  const events = recordedWindow(0, { outcome: 0, values: { return3: -1 } });
  const decision = events[0];
  decision.derivatives = { available: true, asOf: decision.capturedAt + 200 };
  // The archive has already rejected this capture's future input; the report honors that verdict.
  decision.researchReplay = { replayable: false, status: 'stored' };
  const before = JSON.stringify(events);
  const report = compare(events);
  expect(report.counts.excludedKnownUnreplayableCaptures).toBe(1);
  expect(rule(report, 'momentum3')).toMatchObject({ rows: 0, correct: 0, beneficialChanges: 0 });
  expect(JSON.stringify(events)).toBe(before);
});

test.each([undefined, {}, { replayable: true }, { replayable: null }])(
  'retains legacy unknown replay metadata and explicitly replayable captures: %p',
  (researchReplay) => {
    const events = recordedWindow(0);
    events[0].researchReplay = researchReplay;
    expect(compare(events).counts).toMatchObject({
      excludedKnownUnreplayableCaptures: 0,
      scoredRows: 1,
    });
  },
);

test('keeps all checkpoints together and purges labels published after the holdout begins', () => {
  const events = Array.from({ length: 6 }, (_, index) =>
    recordedWindow(index, {
      startsAt: START + index * 15 * MINUTE,
      checkpoints: [12, 9, 6, 3, 1],
    }),
  ).flat();
  const report = compare(events);
  expect(report.counts).toMatchObject({
    developmentGroupsBeforePurge: 4,
    purgedGroups: 1,
    purgedRows: 5,
    purgedContracts: ['KXBTC15M-EXPLORE3'],
  });
  expect(report.development).toMatchObject({ rows: 15, contracts: 3 });
  expect(report.holdout).toMatchObject({
    rows: 10,
    contracts: 2,
    firstStartAt: START + 60 * MINUTE,
  });
  expect(rule(report, 'current-side', { minutes: 9 }).rows).toBe(2);
});

test.each([
  [0, 1],
  [-1, 0],
])(
  'requires publication strictly before holdout: offset %i milliseconds',
  (offset, purgedGroups) => {
    const report = compare([
      ...recordedWindow(0, { resolvedAt: START + 60 * MINUTE + offset }),
      ...recordedWindow(1),
      ...recordedWindow(2),
    ]);
    expect(report.counts.purgedGroups).toBe(purgedGroups);
  },
);

test('keeps overlapping contracts in one chronological group', () => {
  const report = compare([
    ...recordedWindow(0),
    ...recordedWindow(1, { startsAt: START + 10 * MINUTE }),
    ...recordedWindow(2, { startsAt: START + 30 * MINUTE }),
    ...recordedWindow(3, { startsAt: START + 60 * MINUTE }),
  ]);
  expect(report.counts).toMatchObject({ independentGroups: 3, developmentGroupsBeforePurge: 2 });
  expect(report.development).toMatchObject({ contracts: 3, independentGroups: 2 });
  expect(report.holdout).toMatchObject({ contracts: 1, independentGroups: 1 });
});

test('weights independent groups equally when some contracts have more checkpoints', () => {
  const report = compare([
    ...recordedWindow(0, { checkpoints: [12, 9, 6, 3, 1] }),
    ...recordedWindow(1, { outcome: 0 }),
    ...recordedWindow(2),
  ]);
  const baseline = rule(report, 'current-side', { partition: 'development' });
  expect(baseline.accuracy).toBeCloseTo(5 / 6);
  expect(baseline.groupWeightedAccuracy).toBeCloseTo(0.5);
  expect(baseline.independentGroups).toBe(2);
});

test('asOf excludes unpublished outcomes, including one millisecond before publication', () => {
  const events = recordedWindow(0);
  const publication = events[1].recordedAt;
  expect(compare(events, publication - 1).counts.scoredRows).toBe(0);
  expect(compare(events, publication).counts.scoredRows).toBe(1);
  expect(() => compareExploratoryDirections(events)).toThrow('fixed asOf');
});

test.each([
  ...[1, 2, 3, 6].map((version) => [
    `version ${version}`,
    (decision) => (decision.researchExperiment.version = `kalshi-ablation-v${version}`),
  ]),
  ['proxy', (decision) => (decision.learningFeatures.referenceSource = 'coinbase-proxy')],
  ['input', (decision) => (decision.learningFeatures.featureInputSource = 'coinbase-candles')],
  [
    'baseline',
    (decision) => (decision.learningFeatures.baselineModelVersion = 'kalshi-brti-derivatives-v1'),
  ],
  ['manual', (decision) => (decision.cohort = 'manual')],
])('excludes incompatible %s evidence from this frozen experiment', (_, change) => {
  const events = recordedWindow(0);
  change(events[0]);
  expect(compare(events).counts.scoredRows).toBe(0);
});

test('V4 and V5 use identical rules and can share the unchanged native BRTI pipeline', () => {
  const events = [
    ...recordedWindow(0, { outcome: 0, values: { return3: -0.2 }, marketProbability: 0.3 }),
    ...recordedWindow(1, { values: { return3: 0.2 } }),
    ...recordedWindow(2, { values: { return3: -0.2 } }),
  ];
  const original = compare(events);
  const v5Events = JSON.parse(JSON.stringify(events));
  for (const event of v5Events) {
    if (event.event === 'decision') event.researchExperiment.version = 'kalshi-ablation-v5';
  }
  expect(compare(v5Events)).toEqual(original);
  const mixed = events.map((event, index) => (index < 2 ? event : v5Events[index]));
  expect(compare(mixed)).toEqual(original);
  expect(original.supportedResearchVersions).toEqual(['kalshi-ablation-v4', 'kalshi-ablation-v5']);
  expect(original.counts).toMatchObject({ scoredRows: 3, contracts: 3 });
});

test.each([
  ['boundary', 0.5, -0.3, 1, -0.4, 1, 1],
  ['outside', 0.500001, -0.3, 1, -0.4, 1, 0],
  ['missing spot', 0.25, -0.3, 0, -0.4, 1, 0],
  ['missing futures', 0.25, -0.3, 1, 0, 0, 0],
  ['opposite', 0.25, -0.3, 1, 0.4, 1, 0],
  ['balanced', 0.25, 0, 1, -0.4, 1, 0],
])(
  'pressure agreement respects %s eligibility',
  (_, distance, spot, spotFlag, futures, futuresFlag, changes) => {
    const report = compare(
      recordedWindow(0, {
        outcome: 0,
        targetDistance: distance,
        values: {
          buyPressure60: spot,
          flow60Available: spotFlag,
          futuresPressure60: futures,
          futuresFlow60Available: futuresFlag,
        },
      }),
    );
    expect(rule(report, 'near-agreement60')).toMatchObject({
      changedCalls: changes,
      beneficialChanges: changes,
      harmfulChanges: 0,
    });
  },
);

test('reports helpful and harmful changes separately against the matching current-side baseline', () => {
  const report = compare([
    ...recordedWindow(0, { outcome: 0, values: { return3: -1 }, marketProbability: 0.2 }),
    ...recordedWindow(1, { outcome: 1, values: { return3: -1 }, marketProbability: 0.2 }),
    ...recordedWindow(2),
  ]);
  for (const name of ['momentum3', 'market']) {
    expect(rule(report, name, { partition: 'development' })).toMatchObject({
      rows: 2,
      changedCalls: 2,
      beneficialChanges: 1,
      harmfulChanges: 1,
      netCorrectChange: 0,
      groupWeightedAccuracyChange: 0,
    });
  }
});

test.each([
  [0.5, true],
  [0.1, false],
  [null, true],
])(
  'neutral or unavailable signals fall back to the current side',
  (marketProbability, marketAvailable) => {
    const report = compare(
      recordedWindow(0, { marketProbability, marketAvailable, probability: 0.5, spot: 100_000 }),
    );
    for (const name of ['current-side', 'live', 'momentum3', 'reversal3', 'market'])
      expect(rule(report, name)).toMatchObject({ correct: 1, changedCalls: 0 });
    expect(report.purpose).toBe('exploratory-only');
  },
);
