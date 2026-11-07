/** @jest-environment node */
import { createDirectionalStudySession } from './helpers/directionalStudySession';
import {
  createDirectionalPair,
  createLaterDuplicate,
  studyTime,
} from './helpers/directionalEvidence';

let session;
beforeEach(() => {
  session = undefined;
});
afterEach(async () => session?.dispose());

test('reproduces a frozen JSON study after the archive grows and leaves its input database unchanged', async () => {
  const events = Array.from({ length: 6 }, (_, index) => createDirectionalPair(index)).flat();
  events.push(...createDirectionalPair(0, { checkpointMinutes: 6 }));
  session = await createDirectionalStudySession(events);
  const args = ['--as-of', studyTime(7), '--max-sequence', String(events.length), '--json'];
  const first = await session.run(...args);
  expect(first.code).toBe(0);
  const report = JSON.parse(first.stdout);
  expect(report.snapshot).toEqual({
    databasePath: session.databasePath,
    asOf: studyTime(7),
    maxEvidenceSequence: 14,
  });
  expect(report).toMatchObject({
    analysisVersion: 'simple-directional-rules-v2',
    purpose: 'exploratory-only',
    supportedResearchVersions: ['kalshi-ablation-v4', 'kalshi-ablation-v5'],
    counts: { scoredRows: 7, contracts: 6, independentGroups: 6, purgedGroups: 0 },
    development: { rows: 5, independentGroups: 4, pressureAgreementRows: 0, usableMarketRows: 0 },
    holdout: { rows: 2, independentGroups: 2 },
  });
  expect(report.warning).toContain('These results do not train or activate a model.');
  expect(report.development.comparisons[0].rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: 'current-side', accuracy: 0.6, groupWeightedAccuracy: 0.5 }),
      expect.objectContaining({ rule: 'momentum3', correct: 5, groupWeightedAccuracy: 1 }),
      expect.objectContaining({ rule: 'market', correct: 3, groupWeightedAccuracy: 0.5 }),
      expect.objectContaining({ rule: 'near-agreement60', correct: 3, groupWeightedAccuracy: 0.5 }),
    ]),
  );
  session.appendEvents(createDirectionalPair(6));
  const repeated = await session.run(...args);
  expect(repeated.code).toBe(0);
  expect(JSON.parse(repeated.stdout)).toEqual(report);
  const latest = await session.run('--as-of', studyTime(7), '--json');
  expect(latest.code).toBe(0);
  expect(JSON.parse(latest.stdout)).toMatchObject({
    snapshot: { maxEvidenceSequence: 16 },
    counts: { scoredRows: 8, contracts: 7 },
  });
});

test('reports missing and excluded observations without substituting later duplicate captures', async () => {
  const unresolved = createDirectionalPair(3);
  const unreplayable = createDirectionalPair(4);
  unreplayable[0].researchReplay = { replayable: false };
  const missingFeatures = createDirectionalPair(5);
  missingFeatures[0].learningFeatures.values = [];
  const proxy = createDirectionalPair(6, {
    pipeline: {
      baselineModelVersion: 'kalshi-brti-derivatives-v2',
      referenceSource: 'coinbase-proxy',
      featureInputSource: 'coinbase-candles',
    },
  });
  const manual = createDirectionalPair(7).map((row) => ({ ...row, cohort: 'manual' }));
  const unsupported = createDirectionalPair(8);
  unsupported[0].researchExperiment.version = 'kalshi-ablation-v3';
  const otherBaseline = createDirectionalPair(9);
  otherBaseline[0].learningFeatures.baselineModelVersion = 'kalshi-brti-average-v3';
  session = await createDirectionalStudySession([
    ...Array.from({ length: 3 }, (_, index) => createDirectionalPair(index)).flat(),
    unresolved[0],
    ...createLaterDuplicate(unresolved),
    ...unreplayable,
    ...createLaterDuplicate(unreplayable),
    ...missingFeatures,
    ...proxy,
    ...manual,
    ...unsupported,
    ...otherBaseline,
  ]);
  const result = await session.run('--as-of', studyTime(10), '--json');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    counts: {
      eligibleDecisions: 8,
      selectedDecisions: 6,
      duplicateDecisions: 2,
      excludedKnownUnreplayableCaptures: 1,
      selectedWithoutVerifiedFeaturesOrOutcome: 2,
      scoredRows: 3,
      independentGroups: 3,
    },
    development: { independentGroups: 2 },
    holdout: { independentGroups: 1 },
  });
});

test('honors the requested observation time and purges late development outcomes from the holdout comparison', async () => {
  const pairs = Array.from({ length: 6 }, (_, index) => createDirectionalPair(index));
  pairs[3][1].recordedAt = pairs[4][0].windowStartAt;
  session = await createDirectionalStudySession(pairs.flat());
  const earlier = await session.run('--as-of', studyTime(5), '--json');
  expect(earlier.code).toBe(0);
  expect(JSON.parse(earlier.stdout).counts.scoredRows).toBe(5);
  const complete = await session.run('--as-of', studyTime(6), '--json');
  expect(complete.code).toBe(0);
  expect(JSON.parse(complete.stdout)).toMatchObject({
    counts: {
      scoredRows: 6,
      developmentGroupsBeforePurge: 4,
      purgedGroups: 1,
      purgedRows: 1,
      purgedContracts: [pairs[3][0].kalshiMarket.ticker],
    },
    development: { rows: 3, independentGroups: 3 },
    holdout: { rows: 2, independentGroups: 2, firstStartAt: pairs[4][0].windowStartAt },
  });
});

test('prints help and a readable empty-archive report without inventing accuracy results', async () => {
  session = await createDirectionalStudySession();
  const help = await session.run('--help');
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('pnpm research:compare-directions [--database PATH]');
  expect(help.stdout).toContain(
    'No network requests, database writes, model fitting, or activation.',
  );
  const empty = await session.run('--as-of', studyTime(1));
  expect(empty.code).toBe(0);
  expect(empty.stdout).toContain('Historical exploration, not release validation.');
  expect(empty.stdout).toContain('evidence sequence <= 0');
  expect(empty.stdout).toContain('development: 0 contracts, 0 independent groups, 0 captures');
  expect(empty.stdout).toContain('holdout: 0 contracts, 0 independent groups, 0 captures');
  expect(empty.stdout).toContain('n/a');
});

test.each([
  [
    ['--as-of', '2026-10-01T00:00:00'],
    '--as-of must be an ISO timestamp with an explicit timezone.',
  ],
  [['--max-sequence=-1'], '--max-sequence must be a nonnegative safe integer.'],
  [['--max-sequence', '3'], '--max-sequence exceeds the database snapshot.'],
])(
  'explains an invalid study request %j and lets the operator correct it',
  async (args, message) => {
    session = await createDirectionalStudySession(createDirectionalPair(0));
    const failed = await session.run(...args, '--json');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(`Comparison failed: ${message}`);
    expect(failed.stdout).toBe('');
    const corrected = await session.run('--as-of', studyTime(1), '--max-sequence', '2', '--json');
    expect(corrected.code).toBe(0);
    expect(JSON.parse(corrected.stdout)).toMatchObject({
      snapshot: { maxEvidenceSequence: 2 },
      counts: { scoredRows: 1 },
    });
  },
);
