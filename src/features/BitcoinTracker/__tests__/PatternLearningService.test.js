/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createResearchRepository } from '@/services/research/research.repository';
import { createLearningService } from '@/services/research/learning.service';
import {
  advancePatternLearning,
  selectPatternCandidates,
} from '@/services/research/patterns/patternLearning.service';
import { getResearchForecast } from '../utils/researchForecast.utils';
import {
  createResearchInputSnapshot,
  replayResearchInputSnapshot,
} from '../utils/researchExperiments.utils';
import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { evaluatePatternChallengers } from '../utils/patternEvaluation.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { getLearningFeatureSchema } from '../utils/learning/features.utils';
import {
  PATTERN_FEATURE_VERSION,
  PATTERN_DETECTOR_VERSION,
  getPatternModelIndexes,
  getPatternModelValues,
  getPatternAvailabilitySignature,
} from '../utils/learning/patternFeatures.utils';
import {
  PATTERN_MODEL_VERSION,
  PATTERN_CANDIDATE_KINDS,
  isPatternModelArtifact,
  predictPatternCandidates,
} from '../utils/learning/patternModel.utils';
import { trainPatternCandidates } from '../utils/learning/patternTraining.utils';
import { fitLogistic } from '../utils/learning/statistics.utils';
import { createKalshiForecastRecord } from '../utils/kalshi/forecastRecord.utils';
import { getValidatedForecast } from '../utils/journal.utils';

jest.mock('server-only', () => ({}));
jest.mock('../utils/learning/patternTraining.utils', () => ({ trainPatternCandidates: jest.fn() }));

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 4, 12, 9);
const contract = {
  ticker: 'KXBTC15M-PATTERN-SERVICE',
  eventTicker: 'KXBTC15M-PATTERN-SERVICE',
  seriesTicker: 'KXBTC15M',
  startsAt: NOW - 9 * MINUTE,
  expiresAt: NOW + 6 * MINUTE,
  target: 50000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
  receivedAt: NOW,
};
function input() {
  const samples = Array.from({ length: 1801 }, (_, index) => ({
    time: NOW - (1800 - index) * 1000,
    price: 50000 * Math.exp(Math.sin(index / 30) * 0.0001),
  }));
  return {
    now: NOW,
    kalshiMarket: contract,
    ticker: { price: 50001, time: NOW, receivedAt: NOW, bid: 50000, ask: 50002, volume: 100 },
    benchmark: { status: 'live', samples, current: samples.at(-1), receivedAt: NOW },
    candles: Array.from({ length: 120 }, (_, index) => ({
      time: NOW - (120 - index) * MINUTE,
      open: 50000,
      close: index % 2 ? 50010 : 49990,
      high: 50020,
      low: 49980,
      volume: 10,
    })),
  };
}

// Small fitted artifacts test plumbing. Full chronological training is covered by PatternLearning.
function fittedSuite(snapshot, trainedAt = contract.startsAt - MINUTE, fingerprint = 'fixture') {
  const baseline = snapshot.baselineFeatures;
  const values = getPatternModelValues(snapshot);
  const schema = getLearningFeatureSchema(baseline.schemaVersion);
  const rows = Array.from({ length: 20 }, (_, index) => ({
    features: values,
    outcome: Number(index < 15),
  }));
  const calibration = fitLogistic(
    rows.map((row) => ({ ...row, features: [0] })),
    [0],
    { penalty: 0.02 },
  );
  const suiteId = `${trainedAt}-${fingerprint}`;
  return PATTERN_CANDIDATE_KINDS.map((kind) => ({
    id: `${PATTERN_MODEL_VERSION}-${kind}-${suiteId}`,
    suiteId,
    kind,
    version: PATTERN_MODEL_VERSION,
    status: 'shadow',
    trainedAt,
    shadowStartsAt: trainedAt,
    trainingCutoffAt: trainedAt - 3 * MINUTE,
    calibrationCutoffAt: trainedAt - 2 * MINUTE,
    evaluationCutoffAt: trainedAt - MINUTE,
    featureVersion: PATTERN_FEATURE_VERSION,
    baselineFeatureVersion: baseline.schemaVersion,
    patternVersion: PATTERN_DETECTOR_VERSION,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    datasetFingerprint: fingerprint,
    applicability: {
      baselineModelVersion: baseline.baselineModelVersion,
      referenceSources: [baseline.referenceSource],
      featureInputSources: [baseline.featureInputSource],
      minimumHorizonMinutes: 1,
      maximumHorizonMinutes: 15,
      minimumTargetDistance: -8,
      maximumTargetDistance: 8,
      availabilityPatterns: [
        schema.availabilityIndexes.map((index) => baseline.values[index]).join(''),
      ],
    },
    patternAvailabilityPatterns: [getPatternAvailabilitySignature(snapshot)],
    model: fitLogistic(rows, getPatternModelIndexes(kind, baseline.values.length), {
      penalty: 0.02,
    }),
    calibration: { version: 'platt-v1', model: calibration },
  }));
}
let suite;
beforeAll(() => {
  suite = fittedSuite(getResearchForecast(input()).patternLearningFeatures);
});
beforeEach(() => {
  trainPatternCandidates.mockReset();
});

test('serves one complete coherent suite, excluding partial, duplicated and retired variants', () => {
  expect(suite.every(isPatternModelArtifact)).toBe(true);
  expect(selectPatternCandidates([...suite].reverse())).toEqual(suite);
  expect(selectPatternCandidates(suite.slice(1))).toEqual([]);
  expect(selectPatternCandidates([...suite, suite[0]])).toEqual([]);
  expect(
    selectPatternCandidates(
      suite.map((model, index) =>
        index === 0 ? { ...model, retirement: { retiredAt: NOW } } : model,
      ),
    ),
  ).toEqual([]);
  expect(
    selectPatternCandidates(
      suite.map((model, index) =>
        index === 0 ? { ...model, datasetFingerprint: 'other' } : model,
      ),
    ),
  ).toEqual([]);
});

test('reuses the frozen suite without fitting, and resumes partial writes at their original cutoff', async () => {
  const repository = { writeModelArtifact: jest.fn() };
  expect(await advancePatternLearning(repository, [], suite, NOW)).toMatchObject({
    candidates: suite,
  });
  expect(trainPatternCandidates).not.toHaveBeenCalled();
  trainPatternCandidates.mockReturnValue({ status: 'shadow', artifacts: suite });
  const events = [{ event: 'later-evidence' }];
  await advancePatternLearning(repository, events, suite.slice(0, 2), NOW);
  expect(trainPatternCandidates).toHaveBeenCalledWith(events, { now: suite[0].trainedAt });
  expect(repository.writeModelArtifact).toHaveBeenCalledTimes(7);
});

test('a changed historical fingerprint cannot replace a partially persisted experiment', async () => {
  const replacement = suite.map((model) => ({ ...model, suiteId: `${model.trainedAt}-changed` }));
  trainPatternCandidates.mockReturnValue({ status: 'shadow', artifacts: replacement });
  const repository = { writeModelArtifact: jest.fn() };
  expect(await advancePatternLearning(repository, [], suite.slice(0, 2), NOW)).toMatchObject({
    status: 'incomplete-suite',
    candidates: [],
  });
  expect(repository.writeModelArtifact).not.toHaveBeenCalled();
});

test('malformed optional model lists and missing snapshots retain the valid production forecast', () => {
  const values = input();
  const baseline = getResearchForecast(values, {}, contract.startsAt);
  const forecast = getResearchForecast(values, { patterns: { candidates: {} } }, contract.startsAt);
  expect(forecast.available).toBe(true);
  expect(forecast.aboveProbability).toBe(baseline.aboveProbability);
  expect(forecast.patternShadowPredictions).toEqual([]);
  expect(
    predictPatternCandidates({
      candidates: suite,
      snapshot: null,
      windowStartAt: contract.startsAt,
    }),
  ).toEqual([]);
});

test('served fitted artifacts flow through forecast, immutable storage, official settlement and matched evaluation', async () => {
  const client = createClient({ url: 'file::memory:' });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(contract.startsAt - 1);
  try {
    const repository = createResearchRepository({ client });
    for (const artifact of suite) await repository.writeModelArtifact(artifact);
    clock.mockReturnValue(NOW);
    const models = await createLearningService(repository).getResearchModels();
    expect(models.patterns.candidates).toHaveLength(7);
    expect(models.active).toBeNull();
    const values = input();
    const estimate = getResearchForecast(values, models, contract.startsAt);
    const withoutSuite = getResearchForecast(values, {}, contract.startsAt);
    expect(estimate.aboveProbability).toBe(withoutSuite.aboveProbability);
    expect(estimate.patternShadowPredictions).toHaveLength(7);
    expect(estimate.patternShadowPredictions.every((prediction) => prediction.modelUsed)).toBe(
      true,
    );
    const replay = createResearchInputSnapshot(values, models, contract.startsAt, estimate);
    expect(replayResearchInputSnapshot(replay).patternShadowPredictions).toEqual(
      estimate.patternShadowPredictions,
    );
    const recorder = createResearchRecorder({ recorderId: 'pattern-service' });
    const rows = recorder.advance({
      now: NOW,
      markets: [contract],
      ticker: values.ticker,
      benchmark: values.benchmark,
      getEstimate: () => ({ ...estimate, researchInputSnapshot: replay }),
    }).rows;
    const captured = rows.find((row) => row.event === 'decision' && row.checkpointMinutes === 6);
    await repository.persistEvidenceRows([captured]);
    const frozen = JSON.stringify(captured);
    const settledAt = contract.expiresAt + 1000;
    const outcomes = recorder
      .advance({
        now: settledAt,
        markets: [
          {
            ...contract,
            status: 'finalized',
            result: 'yes',
            settlementPrice: contract.target,
            settledAt: contract.expiresAt,
            receivedAt: settledAt,
          },
        ],
        getEstimate: () => null,
      })
      .rows.filter((row) => row.forecastId === captured.forecastId);
    await repository.persistEvidenceRows(outcomes);
    const stored = await repository.getLearningEvidenceRows();
    const report = evaluatePatternChallengers(stored, {
      now: settledAt,
      patternSuites: await repository.readPatternSuiteRegistrations(),
    });
    expect(report.counts.verifiedOutcomes).toBe(1);
    expect(
      report.comparisons.find(
        (row) => row.candidate === 'combined' && row.comparator === 'baseline-control',
      ),
    ).toMatchObject({ examples: 1, fallbackExamples: 0 });
    expect(
      report.comparisons
        .filter((row) => row.comparator === 'production')
        .every((row) => row.examples === 1),
    ).toBe(true);
    expect(JSON.stringify(captured)).toBe(frozen);
    expect(stored.find((row) => row.event === 'decision').patternShadowPredictions).toEqual(
      estimate.patternShadowPredictions,
    );
    expect(await repository.getActiveModelArtifact()).toBeNull();
  } finally {
    clock.mockRestore();
    client.close();
  }
});

test('an activated pattern forecast preserves its feature schema through journal storage and replay', async () => {
  const artifact = suite[0];
  // This in-memory activation fixture tests serving; persisted promotion proof has its own suite.
  const active = {
    ...artifact,
    activation: {
      modelId: artifact.id,
      activatedAt: contract.startsAt - 1,
      shadowEvaluation: {
        version: 'pattern-promotion-v1',
        phase: 'prospective-pattern-promotion',
        modelId: artifact.id,
        suiteId: artifact.suiteId,
        featureVersion: artifact.featureVersion,
        patternVersion: artifact.patternVersion,
        evaluatedAt: contract.startsAt - 2,
        eligibleForPromotion: true,
        evaluationComplete: true,
        independentWindows: 120,
        callCoverage: 1,
        modelUses: 60,
        reasons: [],
      },
    },
  };
  const models = { active, patterns: { active, candidates: suite } };
  const values = input();
  const estimate = getResearchForecast(values, models, contract.startsAt);
  expect(estimate.modelVersion).toBe(PATTERN_MODEL_VERSION);
  expect(estimate.learning).toMatchObject({
    featureVersion: PATTERN_FEATURE_VERSION,
    baselineFeatureVersion: artifact.baselineFeatureVersion,
    modelId: artifact.id,
  });
  const fixed = {
    ...createKalshiForecastRecord({
      id: 'activated-pattern',
      contract,
      createdAt: contract.startsAt,
      price: values.ticker.price,
      checkpointMinutes: 6,
    }),
    createdAt: NOW,
    aboveProbability: estimate.aboveProbability,
    belowProbability: estimate.belowProbability,
    direction: estimate.direction,
    modelVersion: estimate.modelVersion,
    status: 'pending',
    calculationMode: 'outcome-trained',
    kalshi: estimate.kalshi,
    ...(estimate.derivatives ? { derivatives: estimate.derivatives } : {}),
    learning: estimate.learning,
  };
  expect(getValidatedForecast(fixed)).toEqual(fixed);
  expect(
    getValidatedForecast({
      ...fixed,
      learning: { ...fixed.learning, featureVersion: 'deadline-pattern-features-v4' },
    }),
  ).toBeNull();
  const client = createClient({ url: 'file::memory:' });
  try {
    const repository = createResearchRepository({ client });
    await repository.persistForecastSnapshots([fixed]);
    const stored = await repository.readStoredForecasts({ limit: 10 });
    expect(stored.rows).toEqual([fixed]);
    expect(getValidatedForecast(stored.rows[0])).toEqual(fixed);
  } finally {
    client.close();
  }
  const snapshot = createResearchInputSnapshot(values, models, contract.startsAt, estimate);
  const replay = replayResearchInputSnapshot(snapshot);
  expect(replay.aboveProbability).toBe(estimate.aboveProbability);
  expect(replay.learning).toEqual(estimate.learning);
});
