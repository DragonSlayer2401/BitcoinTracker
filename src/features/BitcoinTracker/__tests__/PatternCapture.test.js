/** @jest-environment node */
import { createClient } from '@libsql/client';
import { getResearchForecast } from '../utils/researchForecast.utils';
import {
  createResearchInputSnapshot,
  replayResearchInputSnapshot,
} from '../utils/researchExperiments.utils';
import { getEvidenceRow } from '../utils/evidenceStorage.utils';
import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { createResearchRepository } from '@/services/research/research.repository';
import { evaluatePatternChallengers } from '../utils/patternEvaluation.utils';
import { validateEvidenceRow } from '@/services/research/research.validation';
import { PATTERN_MODEL_VERSION } from '../utils/learning/patternModel.utils';

jest.mock('server-only', () => ({}));
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 4, 12, 9);
const contract = {
  ticker: 'KXBTC15M-PATTERN-CAPTURE',
  eventTicker: 'KXBTC15M-PATTERN',
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
function capture(values = input(), options = {}) {
  const estimate = getResearchForecast(values, {}, contract.startsAt, options);
  const snapshot = createResearchInputSnapshot(values, {}, contract.startsAt, estimate);
  const recorder = createResearchRecorder({ recorderId: 'pattern-capture' });
  const result = recorder.advance({
    now: NOW,
    markets: [contract],
    ticker: values.ticker,
    benchmark: values.benchmark,
    getEstimate: () => ({ ...estimate, researchInputSnapshot: snapshot }),
  });
  return {
    estimate,
    snapshot,
    recorder,
    row: result.rows.find((row) => row.event === 'decision' && row.checkpointMinutes === 6),
  };
}

test('captures optional numerical features without changing the production probability or incumbent schema', () => {
  const values = input();
  const before = JSON.stringify(values);
  const current = getResearchForecast(values, {}, contract.startsAt);
  const legacy = getResearchForecast(values, {}, contract.startsAt, { capturePatterns: false });
  expect(current.available).toBe(true);
  expect(current.aboveProbability).toBe(legacy.aboveProbability);
  expect(current.learningFeatures).toEqual(legacy.learningFeatures);
  expect(current.patternLearningFeatures.schemaVersion).toBe('deadline-pattern-features-v5');
  expect(current.chartPatterns.families.candles.complete).toBe(true);
  expect(JSON.stringify(values)).toBe(before);
});

test('missing benchmark patterns preserve valid proxy forecasts and explicit missingness', () => {
  const values = { ...input(), benchmark: null };
  const { estimate } = capture(values);
  expect(estimate.available).toBe(true);
  expect(estimate.patternLearningFeatures.patternAvailable).toBe(false);
  expect(estimate.patternLearningFeatures.values.every((value) => value === 0)).toBe(true);
  expect(estimate.aboveProbability).toBe(
    getResearchForecast(values, {}, contract.startsAt, { capturePatterns: false }).aboveProbability,
  );
});

test('new replay verifies patterns while historical replay retains absent pattern fields', () => {
  const values = input();
  const { snapshot } = capture(values);
  expect(replayResearchInputSnapshot(snapshot).chartPatterns).toEqual(
    snapshot.expectedPatterns.chartPatterns,
  );
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.expectedPatterns.chartPatterns.features.targetCrossingCount += 1;
  expect(() => replayResearchInputSnapshot(tampered)).toThrow(/pattern evidence/);
  const old = getResearchForecast(values, {}, contract.startsAt, { capturePatterns: false });
  const oldSnapshot = createResearchInputSnapshot(values, {}, contract.startsAt, old);
  const before = JSON.stringify(oldSnapshot);
  expect(replayResearchInputSnapshot(oldSnapshot)).not.toHaveProperty('chartPatterns');
  expect(JSON.stringify(oldSnapshot)).toBe(before);
});

test('storage captures pattern features once, rejects backfill and checks encoded provenance', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    const repository = createResearchRepository({ client });
    const { row } = capture();
    expect(row.patternLearningFeatures.available).toBe(true);
    const missingPatternReplay = JSON.parse(JSON.stringify(row));
    delete missingPatternReplay.researchInputSnapshot.expectedPatterns;
    expect(() => validateEvidenceRow(missingPatternReplay)).toThrow(/pattern schema/);
    await repository.persistEvidenceRows([row]);
    const altered = JSON.parse(JSON.stringify(row));
    altered.patternLearningFeatures.values[0] += 0.5;
    expect(() => validateEvidenceRow(altered)).toThrow(/original captured features/);
    const historical = { ...row, eventId: 'historical:decision:pending', forecastId: 'historical' };
    delete historical.researchInputSnapshot;
    delete historical.chartPatterns;
    delete historical.patternLearningFeatures;
    delete historical.patternShadowPredictions;
    await repository.persistEvidenceRows([historical]);
    await expect(
      repository.persistEvidenceRows([
        {
          ...historical,
          chartPatterns: row.chartPatterns,
          patternLearningFeatures: row.patternLearningFeatures,
          patternShadowPredictions: [],
        },
      ]),
    ).rejects.toThrow();
    const stored = await repository.getLearningEvidenceRows();
    expect(stored.find((saved) => saved.forecastId === 'historical')).not.toHaveProperty(
      'chartPatterns',
    );
  } finally {
    client.close();
  }
});

test('historical detector captures replay and validate with their original feature schema', () => {
  const { snapshot, row } = capture(input(), { patternVersion: 'brti-patterns-v1' });
  const original = JSON.stringify(snapshot);
  expect(row.chartPatterns.version).toBe('brti-patterns-v1');
  expect(row.patternLearningFeatures.schemaVersion).toBe('deadline-pattern-features-v4');
  expect(replayResearchInputSnapshot(snapshot).chartPatterns).toEqual(row.chartPatterns);
  expect(() => validateEvidenceRow(row)).not.toThrow();
  expect(JSON.stringify(snapshot)).toBe(original);
  const withLegacyPrediction = {
    ...row,
    patternShadowPredictions: [
      {
        kind: 'combined',
        modelVersion: 'pattern-logistic-kalshi-v1',
        suiteId: '1-legacy',
        modelId: 'pattern-logistic-kalshi-v1-combined-1-legacy',
        trainedAt: contract.startsAt - 1,
        featureCutoffAt: row.featureCutoffAt,
        modelUsed: false,
        aboveProbability: 0.5,
      },
    ],
  };
  delete withLegacyPrediction.researchInputSnapshot;
  expect(() => validateEvidenceRow(withLegacyPrediction)).not.toThrow();
  const incompatible = {
    ...withLegacyPrediction,
    patternShadowPredictions: [
      {
        ...withLegacyPrediction.patternShadowPredictions[0],
        modelVersion: PATTERN_MODEL_VERSION,
        modelId: `${PATTERN_MODEL_VERSION}-combined-1-legacy`,
      },
    ],
  };
  expect(() => validateEvidenceRow(incompatible)).toThrow(/Pattern predictions/);
});

test('official outcomes attach later while capture and pattern availability remain immutable', () => {
  const { row, recorder } = capture();
  const before = JSON.stringify(row);
  const settledAt = contract.expiresAt + 1000;
  const outcomes = recorder.advance({
    now: settledAt,
    markets: [
      {
        ...contract,
        status: 'finalized',
        result: 'yes',
        settlementPrice: 50000,
        settledAt: contract.expiresAt,
        receivedAt: settledAt,
      },
    ],
    getEstimate: () => null,
  }).rows;
  const report = evaluatePatternChallengers(
    [row, ...outcomes.filter((event) => event.forecastId === row.forecastId)],
    { now: settledAt },
  );
  expect(report.counts.verifiedOutcomes).toBe(1);
  expect(report.featureAvailability.snapshots).toBe(1);
  expect(report.comparisons[0].examples).toBe(0);
  expect(JSON.stringify(row)).toBe(before);
  expect(
    outcomes
      .filter((event) => event.event === 'outcome')
      .every((event) => !Object.hasOwn(event, 'chartPatterns')),
  ).toBe(true);
});

test('outcome and restored evidence never reconstruct pattern inputs', () => {
  const { estimate } = capture();
  const row = getEvidenceRow({
    entry: {
      id: 'restored',
      target: contract.target,
      expiresAt: contract.expiresAt,
      startsAt: contract.startsAt,
      createdAt: NOW,
      aboveProbability: 0.5,
      kalshiMarket: contract,
    },
    now: NOW + 1000,
    event: 'restored',
    estimate,
    inputObservedAt: NOW,
  });
  expect(row).not.toHaveProperty('chartPatterns');
});

test('pattern artifacts cannot activate through generic repository promotion', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    const repository = createResearchRepository({ client });
    await repository.getResearchStatus();
    const artifact = {
      id: 'blocked-pattern',
      version: PATTERN_MODEL_VERSION,
      trainedAt: NOW - MINUTE,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    };
    // Simulate an older writer bypassing validation: promotion must still reject the lane.
    await client.execute({
      sql: 'INSERT INTO model_artifacts(model_id,saved_at,content_hash,payload) VALUES(?,?,?,?)',
      args: [artifact.id, NOW, 'test', JSON.stringify(artifact)],
    });
    await expect(
      repository.activateModelArtifact(artifact.id, {
        activatedAt: NOW,
        shadowEvaluation: { modelId: artifact.id, eligibleForPromotion: true, evaluatedAt: NOW },
      }),
    ).rejects.toThrow(/shadow-only/);
    expect(await repository.getActiveModelArtifact()).toBeNull();
  } finally {
    client.close();
  }
});
