/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createResearchRepository } from '@/services/research/research.repository';
import { createLearningService } from '@/services/research/learning.service';
import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { LEARNING_FEATURE_VERSION, LEARNING_FEATURE_NAMES } from '../utils/learning/features.utils';
import {
  PATTERN_FEATURE_VERSION,
  PATTERN_DETECTOR_VERSION,
  PATTERN_FEATURE_NAMES,
  PATTERN_FAMILIES,
  getPatternLearningFeatures,
  getPatternModelIndexes,
  getPatternModelValues,
  getPatternAvailabilitySignature,
} from '../utils/learning/patternFeatures.utils';
import {
  PATTERN_CANDIDATE_KINDS,
  PATTERN_MODEL_VERSION,
  LEGACY_PATTERN_MODEL_VERSION,
  isPatternModelArtifact,
  predictPatternCandidates,
  applyPatternModel,
  hasPatternActivation,
} from '../utils/learning/patternModel.utils';
import { getPatternSuiteRegistrations } from '../utils/learning/patternCohorts.utils';
import {
  evaluatePatternPromotion,
  evaluatePatternActiveModel,
} from '../utils/learning/patternPromotion.utils';
import { PATTERN_FEATURE_DEFINITIONS } from '../utils/patterns/patternConfig';
import { fitLogistic } from '../utils/learning/statistics.utils';

jest.mock('server-only', () => ({}));
const MINUTE = 60000;
const START = Date.UTC(2026, 9, 1);
const TRAINED = START - 10 * MINUTE;
const REGISTERED = START - MINUTE;
const clone = (value) => JSON.parse(JSON.stringify(value));
const marketFor = (index) => ({
  ticker: `KXBTC15M-PROMOTION${index}`,
  eventTicker: `KXBTC15M-PROMOTION${index}`,
  seriesTicker: 'KXBTC15M',
  startsAt: START + index * 17 * MINUTE,
  expiresAt: START + index * 17 * MINUTE + 15 * MINUTE,
  target: 100000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  supported: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
});

function inputs(index, now = marketFor(index).startsAt + 3 * MINUTE) {
  const market = marketFor(index);
  const learningFeatures = {
    schemaVersion: LEARNING_FEATURE_VERSION,
    available: true,
    values: LEARNING_FEATURE_NAMES.map(() => 0),
    baselineAboveProbability: 0.7,
    targetDistance: 0,
    target: market.target,
    expiresAt: market.expiresAt,
    featureCutoffAt: now,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    referenceSource: 'cf-brti',
    featureInputSource: 'cf-brti-history',
    baselineModelVersion: 'kalshi-brti-average-v2',
    settlementKnownFraction: 0,
  };
  const chartPatterns = {
    version: PATTERN_DETECTOR_VERSION,
    source: 'brti',
    capturedAt: now,
    availableAt: now,
    targetPrice: market.target,
    families: Object.fromEntries(
      PATTERN_FAMILIES.map((family) => [
        family,
        { available: true, complete: true, coverage: 1, availableAt: now },
      ]),
    ),
    features: Object.fromEntries(
      PATTERN_FEATURE_DEFINITIONS.map(({ name }) => [
        name,
        name === 'candleBodyDirection' ? (index % 2 ? 1 : -1) : 0,
      ]),
    ),
  };
  return {
    learningFeatures,
    chartPatterns,
    patternLearningFeatures: getPatternLearningFeatures({ learningFeatures, chartPatterns }),
  };
}
function suiteFor() {
  const snapshot = inputs(0).patternLearningFeatures;
  const featureValues = getPatternModelValues(snapshot);
  const directionIndex =
    LEARNING_FEATURE_NAMES.length + PATTERN_FEATURE_NAMES.indexOf('candleBodyDirection');
  const rows = Array.from({ length: 80 }, (_, index) => ({
    outcome: index % 2,
    features: featureValues.map((value, column) =>
      column === directionIndex ? (index % 2 ? 1 : -1) : value,
    ),
  }));
  const controlRows = rows.map((row, index) => ({ ...row, outcome: Number(index % 10 < 7) }));
  const suiteId = `${TRAINED}-promotion`;
  return PATTERN_CANDIDATE_KINDS.map((kind) => ({
    id: `${PATTERN_MODEL_VERSION}-${kind}-${suiteId}`,
    suiteId,
    kind,
    version: PATTERN_MODEL_VERSION,
    status: 'shadow',
    trainedAt: TRAINED,
    shadowStartsAt: TRAINED,
    trainingCutoffAt: TRAINED - 3 * MINUTE,
    calibrationCutoffAt: TRAINED - 2 * MINUTE,
    evaluationCutoffAt: TRAINED - MINUTE,
    featureVersion: PATTERN_FEATURE_VERSION,
    patternVersion: PATTERN_DETECTOR_VERSION,
    baselineFeatureVersion: LEARNING_FEATURE_VERSION,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    datasetFingerprint: 'promotion',
    applicability: {
      baselineModelVersion: 'kalshi-brti-average-v2',
      featureInputSources: ['cf-brti-history'],
      referenceSources: ['cf-brti'],
      minimumHorizonMinutes: 1,
      maximumHorizonMinutes: 15,
      minimumTargetDistance: -8,
      maximumTargetDistance: 8,
      availabilityPatterns: ['0000000'],
    },
    patternAvailabilityPatterns: [getPatternAvailabilitySignature(snapshot)],
    model: fitLogistic(
      kind === 'baseline-control' ? controlRows : rows,
      getPatternModelIndexes(kind, LEARNING_FEATURE_NAMES.length),
      { penalty: 0.02 },
    ),
    calibration: {
      version: 'platt-v1',
      model: { indexes: [0], means: [0], scales: [1], coefficients: [0, 1], penalty: 0.02 },
    },
  }));
}
let suite;
let registrations;
let events;
let cutoff;
function record(index, { active = null, reversed = false, omitShadows = false } = {}) {
  const market = marketFor(index);
  const recorder = createResearchRecorder({ recorderId: 'pattern-promotion' });
  const output = [];
  for (const horizon of [12, 9, 6, 3, 1]) {
    const now = market.expiresAt - horizon * MINUTE;
    const captured = inputs(index, now);
    let estimate = {
      target: market.target,
      expiresAt: market.expiresAt,
      available: true,
      aboveProbability: 0.7,
      belowProbability: 0.3,
      direction: 'above',
      modelVersion: captured.learningFeatures.baselineModelVersion,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      ...captured,
      kalshi: {
        referenceSource: 'cf-brti',
        priceDynamicsSource: 'cf-brti-history',
        observedSampleCount: 0,
      },
    };
    if (active)
      estimate = applyPatternModel(
        estimate,
        { snapshot: captured.patternLearningFeatures, windowStartAt: market.startsAt, now },
        active,
      );
    estimate.patternShadowPredictions = omitShadows
      ? []
      : predictPatternCandidates({
          candidates: suite,
          snapshot: captured.patternLearningFeatures,
          windowStartAt: market.startsAt,
        });
    output.push(
      ...recorder.advance({
        now,
        markets: [{ ...market, receivedAt: now }],
        ticker: { time: now, receivedAt: now, price: 100001 },
        getEstimate: () => estimate,
      }).rows,
    );
  }
  const outcome = reversed ? 1 - (index % 2) : index % 2;
  const now = market.expiresAt + 1000;
  output.push(
    ...recorder.advance({
      now,
      markets: [
        {
          ...market,
          receivedAt: now,
          status: 'finalized',
          result: outcome ? 'yes' : 'no',
          settlementPrice: outcome ? 100001 : 99999,
        },
      ],
      getEstimate: () => null,
    }).rows,
  );
  return output;
}
function evaluate(rows = events, changes = {}) {
  return evaluatePatternPromotion(suite[0], rows, {
    now: cutoff,
    patternSuites: registrations,
    candidates: suite,
    ...changes,
  });
}
beforeAll(() => {
  suite = suiteFor();
  registrations = getPatternSuiteRegistrations(
    suite.map((model) => ({ ...model, registeredAt: REGISTERED })),
  );
  events = Array.from({ length: 120 }, (_, index) => record(index)).flat();
  cutoff = marketFor(120).startsAt;
});

test('only independent frozen future evidence makes the current combined model eligible', () => {
  expect(suite.every(isPatternModelArtifact)).toBe(true);
  const report = evaluate();
  expect(report).toMatchObject({
    eligibleForPromotion: true,
    evaluationComplete: true,
    independentWindows: 120,
    modelUses: 120,
    callCoverage: 1,
  });
  expect(report.cohortForecastIds).toHaveLength(120);
  expect(evaluate(events.slice(0, -10))).toMatchObject({ eligibleForPromotion: false });
  expect(
    evaluate([], {
      candidates: suite.map((model) => ({ ...model, evaluation: { eligibleForPromotion: true } })),
    }),
  ).toMatchObject({ eligibleForPromotion: false });
  expect(evaluate(events, { patternSuites: [] }).eligibleForPromotion).toBe(false);
  expect(
    evaluatePatternPromotion(suite[1], events, {
      now: cutoff,
      patternSuites: registrations,
      candidates: suite,
    }).eligibleForPromotion,
  ).toBe(false);
});

test('a failed fixed cohort cannot be repaired by omitting features or appending favorable later outcomes', () => {
  const changed = clone(events);
  const first = changed.find((row) => row.event === 'decision');
  for (const row of changed.filter(
    (entry) =>
      entry.event === 'decision' && entry.kalshiMarket.ticker === first.kalshiMarket.ticker,
  ))
    row.patternShadowPredictions = [];
  const report = evaluate(changed);
  expect(report.eligibleForPromotion).toBe(false);
  expect(report.eligibleWindows).toBe(120);
  const future = [
    ...changed,
    ...Array.from({ length: 12 }, (_, index) => record(120 + index)).flat(),
  ];
  expect(evaluate(future, { now: marketFor(133).startsAt }).cohortForecastIds).toEqual(
    report.cohortForecastIds,
  );
  const incompatible = clone(events);
  for (const row of incompatible.filter((entry) => entry.event === 'decision'))
    row.patternLearningFeatures.schemaVersion = 'deadline-pattern-features-v4';
  expect(evaluate(incompatible).eligibleForPromotion).toBe(false);
  const bad = Array.from({ length: 120 }, (_, index) => record(index, { reversed: true })).flat();
  expect(evaluate(bad).eligibleForPromotion).toBe(false);
});

test('unsupported schemas, absent activation and retirement retain the exact production baseline', () => {
  const capture = inputs(121);
  const baseline = {
    target: capture.learningFeatures.target,
    expiresAt: capture.learningFeatures.expiresAt,
    available: true,
    aboveProbability: 0.7,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const options = {
    snapshot: capture.patternLearningFeatures,
    windowStartAt: marketFor(121).startsAt,
    now: capture.learningFeatures.featureCutoffAt,
  };
  expect(applyPatternModel(baseline, options, suite[0])).toBe(baseline);
  const active = {
    ...suite[0],
    activation: { modelId: suite[0].id, activatedAt: cutoff, shadowEvaluation: evaluate() },
  };
  expect(hasPatternActivation(active, options.now)).toBe(true);
  for (const malformed of [
    { ...options.snapshot, values: null },
    { ...options.snapshot, baselineFeatures: null },
    { ...options.snapshot, target: options.snapshot.target + 1 },
    { ...options.snapshot, expiresAt: options.snapshot.expiresAt + 1 },
  ])
    expect(applyPatternModel(baseline, { ...options, snapshot: malformed }, active)).toBe(baseline);
  expect(applyPatternModel(baseline, options, active)).toMatchObject({
    modelVersion: PATTERN_MODEL_VERSION,
    learning: {
      featureVersion: PATTERN_FEATURE_VERSION,
      baselineFeatureVersion: LEARNING_FEATURE_VERSION,
    },
  });
  expect(
    applyPatternModel(
      baseline,
      {
        ...options,
        snapshot: { ...options.snapshot, schemaVersion: 'deadline-pattern-features-v4' },
      },
      active,
    ),
  ).toBe(baseline);
  expect(
    applyPatternModel(baseline, options, { ...active, retirement: { retiredAt: cutoff + 1 } }),
  ).toBe(baseline);
  const legacy = {
    ...suite[0],
    version: LEGACY_PATTERN_MODEL_VERSION,
    id: suite[0].id.replace(PATTERN_MODEL_VERSION, LEGACY_PATTERN_MODEL_VERSION),
    featureVersion: 'deadline-pattern-features-v4',
    patternVersion: 'brti-patterns-v1',
  };
  expect(isPatternModelArtifact(legacy)).toBe(true);
  expect(evaluatePatternPromotion(legacy, events, { now: cutoff }).eligibleForPromotion).toBe(
    false,
  );
});

test('persisted unchanged incumbent history admits legitimate baseline fallback and rejects replacement', () => {
  const incumbent = {
    id: 'outcome-logistic-kalshi-v2-incumbent',
    activation: { activatedAt: REGISTERED - MINUTE },
  };
  const activationHistory = [
    {
      sequence: 1,
      modelId: incumbent.id,
      activatedAt: incumbent.activation.activatedAt,
      retiredAt: null,
    },
  ];
  expect(evaluate(events, { incumbent, activationHistory }).eligibleForPromotion).toBe(true);
  expect(evaluate(events, { incumbent }).eligibleForPromotion).toBe(false);
  expect(
    evaluate(events, {
      incumbent,
      activationHistory: [
        ...activationHistory,
        {
          sequence: 2,
          modelId: 'changed-incumbent',
          activatedAt: marketFor(60).startsAt,
          retiredAt: null,
        },
      ],
    }).eligibleForPromotion,
  ).toBe(false);
});

test('active monitoring retains later windows after a new shadow suite replaces the original boundary', () => {
  const active = {
    ...suite[0],
    activation: { modelId: suite[0].id, activatedAt: cutoff, shadowEvaluation: evaluate() },
  };
  const later = Array.from({ length: 120 }, (_, index) =>
    record(121 + index, { active, reversed: true, omitShadows: true }),
  ).flat();
  const newRegistration = {
    ...registrations[0],
    suiteId: `${cutoff}-new`,
    trainedAt: cutoff - 1,
    registeredAt: cutoff + 1,
  };
  const report = evaluatePatternActiveModel(active, later, {
    now: marketFor(242).startsAt,
    patternSuites: [...registrations, newRegistration],
  });
  expect(report).toMatchObject({
    status: 'disabled',
    independentWindows: 120,
    modelUses: 120,
    callCoverage: 1,
  });
});

test('activation rechecks persisted evidence, serves the activated model, and retirement disables it', async () => {
  const client = createClient({ url: 'file::memory:' });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(REGISTERED);
  try {
    const repository = createResearchRepository({ client });
    for (const artifact of suite) await repository.writeModelArtifact(artifact);
    const forged = { ...evaluate(), independentWindows: 999 };
    await expect(
      repository.activatePatternModelArtifact(suite[0].id, {
        activatedAt: cutoff,
        shadowEvaluation: forged,
      }),
    ).rejects.toThrow(/persisted prospective evidence/);
    for (let index = 0; index < events.length; index += 100)
      await repository.persistEvidenceRows(events.slice(index, index + 100));
    clock.mockReturnValue(cutoff);
    const service = createLearningService(repository);
    const current = await service.getResearchModels();
    expect(current.active).toBeNull();
    const report = evaluate(events, {
      patternSuites: await repository.readPatternSuiteRegistrations(),
    });
    await expect(
      repository.activateModelArtifact(suite[0].id, {
        activatedAt: cutoff,
        shadowEvaluation: report,
      }),
    ).rejects.toThrow(/deliberately/);
    await expect(
      repository.activatePatternModelArtifact(suite[0].id, {
        activatedAt: cutoff,
        shadowEvaluation: { ...report, modelUses: 119 },
      }),
    ).rejects.toThrow(/persisted prospective evidence/);
    const result = await service.activatePatternCandidate({ modelId: suite[0].id, now: cutoff });
    expect(result.activated).toBe(true);
    expect((await service.getResearchModels()).patterns.active.id).toBe(suite[0].id);
    await repository.retireModelArtifact(suite[0].id, {
      retiredAt: cutoff + 1,
      reason: 'Test retirement after complete monitoring evidence.',
    });
    expect((await service.getResearchModels()).active).toBeNull();
    await expect(
      repository.activatePatternModelArtifact(suite[0].id, {
        activatedAt: cutoff + 2,
        shadowEvaluation: report,
      }),
    ).rejects.toThrow(/retired/);
  } finally {
    clock.mockRestore();
    client.close();
  }
});
