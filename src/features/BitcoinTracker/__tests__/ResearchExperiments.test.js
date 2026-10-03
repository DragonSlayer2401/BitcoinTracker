import { getResearchForecast as getLatestResearchForecast } from '../utils/researchForecast.utils';
import {
  createResearchInputSnapshot,
  replayResearchInputSnapshot,
} from '../utils/researchExperiments.utils';
import {
  getResearchVariantNames,
  RESEARCH_EXPERIMENT_V1,
  RESEARCH_EXPERIMENT_V2,
  RESEARCH_EXPERIMENT_V3,
  RESEARCH_EXPERIMENT_V4,
  RESEARCH_EXPERIMENT_V5,
} from '../utils/researchVariantConfig.utils';
import { getKalshiForecast } from '../utils/kalshi/forecast.utils';
import { getEvidenceRow } from '../utils/evidenceStorage.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import {
  LEGACY_CHALLENGER_MODEL_VERSION as CHALLENGER_MODEL_VERSION,
  LEGACY_CHALLENGER_POLICY_VERSION as CHALLENGER_POLICY_VERSION,
  LEGACY_CHALLENGER_REQUIREMENTS as CHALLENGER_REQUIREMENTS,
  CHALLENGER_MODEL_VERSION as CURRENT_CHALLENGER_MODEL_VERSION,
  CHALLENGER_POLICY_VERSION as CURRENT_CHALLENGER_POLICY_VERSION,
  CHALLENGER_REQUIREMENTS as CURRENT_CHALLENGER_REQUIREMENTS,
  CHALLENGER_VARIANTS,
  getChallengerPolicyVersion,
  DIRECTIONAL_REVERSAL_KIND,
  DIRECTIONAL_REVERSAL_POLICY_VERSION,
  DIRECTIONAL_REVERSAL_REQUIREMENTS,
  isChallengerArtifact,
} from '../utils/learning/challengerModel.utils';
import {
  CHALLENGER_CALIBRATION_VERSION,
  DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION,
  fitCheckpointCalibration,
} from '../utils/learning/challengerCheckpoint.utils';
import {
  DIRECTIONAL_REVERSAL_FEATURE_NAMES,
  DIRECTIONAL_REGULARIZATION_GRID,
  DIRECTIONAL_REGULARIZATION_POLICY,
} from '../utils/learning/directionalReversal.utils';

const MINUTE = 60_000;
const END = Date.UTC(2026, 8, 14, 12, 15);
const NOW = END - 5 * MINUTE;
const START = END - 15 * MINUTE;
const RESEARCH_VARIANT_NAMES = getResearchVariantNames(RESEARCH_EXPERIMENT_V1);
const getCurrentResearchForecast = (input, models, windowStartAt, options = {}) =>
  getLatestResearchForecast(input, models, windowStartAt, {
    researchVersion: RESEARCH_EXPERIMENT_V2,
    ...options,
  });
const getResearchForecast = (input, models, windowStartAt) =>
  getCurrentResearchForecast(input, models, windowStartAt, {
    researchVersion: RESEARCH_EXPERIMENT_V1,
  });

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
  function challenger(values, kind = 'reduced-pressure') {
    const features = getCurrentResearchForecast(values).learningFeatures;
    return {
      id: `${CHALLENGER_MODEL_VERSION}-${kind}-fixture`,
      version: CHALLENGER_MODEL_VERSION,
      policyVersion: CHALLENGER_POLICY_VERSION,
      variantPolicyVersion: getChallengerPolicyVersion(kind, CHALLENGER_MODEL_VERSION),
      kind,
      variantName: CHALLENGER_VARIANTS[kind],
      status: 'shadow',
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      trainedAt: START - 1,
      trainingCutoffAt: START - 2,
      shadowStartsAt: START - 1,
      featureVersion: features.schemaVersion,
      pipeline: {
        baselineModelVersion: features.baselineModelVersion,
        referenceSource: features.referenceSource,
        featureInputSource: features.featureInputSource,
        featureVersion: features.schemaVersion,
      },
      requirements: { ...CHALLENGER_REQUIREMENTS },
      applicability: { minimumHorizonMinutes: 1, maximumHorizonMinutes: 15 },
      ...(kind === 'reversal'
        ? {
            model: {
              indexes: [0, 1, 2, 3, 4, 5],
              means: Array(6).fill(0),
              scales: Array(6).fill(1),
              coefficients: [-2, 0, 0, 0, 0, 0, 0],
            },
          }
        : {}),
    };
  }

  function directionalChallenger(values) {
    const features = getLatestResearchForecast(values).learningFeatures;
    const size = DIRECTIONAL_REVERSAL_FEATURE_NAMES.length;
    return {
      ...challenger(values),
      id: `${CURRENT_CHALLENGER_MODEL_VERSION}-${DIRECTIONAL_REVERSAL_KIND}-fixture`,
      version: CURRENT_CHALLENGER_MODEL_VERSION,
      kind: DIRECTIONAL_REVERSAL_KIND,
      variantName: CHALLENGER_VARIANTS[DIRECTIONAL_REVERSAL_KIND],
      policyVersion: DIRECTIONAL_REVERSAL_POLICY_VERSION,
      variantPolicyVersion: DIRECTIONAL_REVERSAL_POLICY_VERSION,
      requirements: { ...DIRECTIONAL_REVERSAL_REQUIREMENTS },
      pipeline: {
        baselineModelVersion: features.baselineModelVersion,
        referenceSource: features.referenceSource,
        featureInputSource: features.featureInputSource,
        featureVersion: features.schemaVersion,
      },
      calibration: {
        version: DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION,
        target: 'opposite-current-side',
        primaryCutoffAt: START - 4000,
        startedAt: START - 3000,
        cutoffAt: START - 2000,
        independentWindows: 20,
        checkpoints: fitCheckpointCalibration(
          Array.from({ length: 20 }, (_, index) => ({
            horizonMinutes: 6,
            probability: 0.8,
            outcome: index % 2,
          })),
        ),
      },
      model: {
        indexes: Array.from({ length: size }, (_, index) => index),
        means: Array(size).fill(0),
        scales: Array(size).fill(1),
        coefficients: [Math.log(0.8 / 0.2), ...Array(size).fill(0)],
        penalty: 0.5,
        regularization: {
          version: DIRECTIONAL_REGULARIZATION_POLICY,
          criterion: 'event-weighted-forward-validation-brier',
          selectedPenalty: 0.5,
          grid: [...DIRECTIONAL_REGULARIZATION_GRID],
          folds: [],
          fallback: true,
        },
      },
    };
  }

  function activateDirectionalChallenger(artifact) {
    return {
      ...artifact,
      activation: {
        modelId: artifact.id,
        activatedAt: START,
        shadowEvaluation: {
          modelId: artifact.id,
          phase: 'confirmation',
          eligibleForPromotion: true,
          approvedCheckpoints: [6],
          evaluatedAt: START,
        },
      },
    };
  }

  test('v5 adds one directional comparison while preserving every v4 calculation and replay', () => {
    const values = input();
    const previous = getLatestResearchForecast(values, {}, START, {
      researchVersion: RESEARCH_EXPERIMENT_V4,
    });
    const current = getLatestResearchForecast(values, {}, START);
    expect(current.researchExperiment.version).toBe(RESEARCH_EXPERIMENT_V5);
    expect(Object.keys(current.researchExperiment.variants)).toHaveLength(11);
    expect(Object.keys(previous.researchExperiment.variants)).toHaveLength(10);
    for (const [name, variant] of Object.entries(previous.researchExperiment.variants))
      expect(current.researchExperiment.variants[name]).toEqual(variant);
    expect(current.researchExperiment.production).toEqual(previous.researchExperiment.production);
    expect(current.kalshi).toEqual(previous.kalshi);
    expect(current.researchExperiment.variants['directional-reversal-candidate']).toMatchObject({
      available: false,
      aboveProbability: null,
      belowProbability: null,
    });
    for (const forecast of [previous, current]) {
      const snapshot = createResearchInputSnapshot(values, {}, START, forecast);
      const saved = JSON.stringify(snapshot);
      expect(replayResearchInputSnapshot(JSON.parse(saved)).researchExperiment).toEqual(
        forecast.researchExperiment,
      );
      expect(JSON.stringify(snapshot)).toBe(saved);
    }
  });

  test('v5 archives a direct reversal separately before activation and replays the approved call', () => {
    const values = input();
    values.kalshiMarket.startsAt = NOW - 9 * MINUTE;
    values.kalshiMarket.expiresAt = NOW + 6 * MINUTE;
    const candidate = directionalChallenger(values);
    expect(isChallengerArtifact(candidate)).toBe(true);
    const base = getLatestResearchForecast(values, {}, START);
    const models = { challengers: { candidates: [candidate] } };
    const shadow = getLatestResearchForecast(values, models, START);
    const comparison = shadow.researchExperiment.variants[candidate.variantName];
    expect(shadow.aboveProbability).toBe(base.aboveProbability);
    expect(shadow.learning).toBeUndefined();
    expect(comparison).toMatchObject({ available: true, modelId: candidate.id });
    expect(base.aboveProbability).toBeGreaterThan(0.5);
    expect(comparison.aboveProbability).toBeLessThan(0.5);
    expect(Math.abs(comparison.aboveProbability - base.aboveProbability)).toBeGreaterThan(0.05);

    models.challengers.active = activateDirectionalChallenger(candidate);
    const active = getLatestResearchForecast(values, models, START);
    expect(active.learning).toMatchObject({
      applied: true,
      modelId: candidate.id,
      calibrationVersion: DIRECTIONAL_REVERSAL_POLICY_VERSION,
      baselineAboveProbability: base.aboveProbability,
    });
    expect(active.aboveProbability).toBe(comparison.aboveProbability);
    expect(active.target).toBe(base.target);
    expect(active.expiresAt).toBe(base.expiresAt);
    expect(active.kalshi).toEqual(base.kalshi);
    expect(active.intervalAvailable).toBe(false);
    for (const [forecast, capturedModels] of [
      [shadow, { challengers: { candidates: [candidate] } }],
      [active, models],
    ]) {
      const snapshot = createResearchInputSnapshot(values, capturedModels, START, forecast);
      const replay = replayResearchInputSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(replay.aboveProbability).toBe(forecast.aboveProbability);
      expect(replay.researchExperiment).toEqual(forecast.researchExperiment);
    }
  });

  test.each([
    [RESEARCH_EXPERIMENT_V1, 4],
    [RESEARCH_EXPERIMENT_V2, 10],
    [RESEARCH_EXPERIMENT_V3, 10],
    [RESEARCH_EXPERIMENT_V4, 10],
  ])(
    '%s cannot acquire the new directional family during prediction or replay',
    (version, size) => {
      const values = input();
      values.kalshiMarket.startsAt = NOW - 9 * MINUTE;
      values.kalshiMarket.expiresAt = NOW + 6 * MINUTE;
      const candidate = directionalChallenger(values);
      expect(isChallengerArtifact(candidate)).toBe(true);
      const models = {
        challengers: { candidates: [candidate], active: activateDirectionalChallenger(candidate) },
      };
      const previous = getLatestResearchForecast(values, {}, START, { researchVersion: version });
      const result = getLatestResearchForecast(values, models, START, { researchVersion: version });
      expect(Object.keys(result.researchExperiment.variants)).toHaveLength(size);
      expect(result.researchExperiment.variants).not.toHaveProperty(candidate.variantName);
      expect(result.researchExperiment).toEqual(previous.researchExperiment);
      expect(result.aboveProbability).toBe(previous.aboveProbability);
      expect(result.learning).toBeUndefined();
      const snapshot = createResearchInputSnapshot(values, models, START, result);
      expect(replayResearchInputSnapshot(snapshot).researchExperiment).toEqual(
        previous.researchExperiment,
      );
    },
  );

  test.each(['reduced-pressure', 'reversal'])(
    'records frozen %s without applying it before activation',
    (kind) => {
      const values = input();
      const candidate = challenger(values, kind);
      const models = { challengers: { candidates: [candidate], active: null } };
      const base = getCurrentResearchForecast(values, {}, START);
      const shadow = getCurrentResearchForecast(values, models, START);
      expect(shadow.aboveProbability).toBe(base.aboveProbability);
      expect(shadow.researchExperiment.variants[candidate.variantName]).toMatchObject({
        available: true,
        modelId: candidate.id,
        referenceSource: 'cf-brti',
      });
      expect(shadow.researchExperiment.variants[candidate.variantName].aboveProbability).not.toBe(
        base.aboveProbability,
      );
      const snapshot = createResearchInputSnapshot(values, models, START, shadow);
      expect(replayResearchInputSnapshot(snapshot).researchExperiment).toEqual(
        shadow.researchExperiment,
      );
      candidate.activation = {
        modelId: candidate.id,
        activatedAt: NOW - 1,
        shadowEvaluation: {
          modelId: candidate.id,
          eligibleForPromotion: true,
          evaluatedAt: NOW - 1,
        },
      };
      models.challengers.active = candidate;
      const active = getCurrentResearchForecast(values, models, START);
      expect(active.learning).toMatchObject({
        applied: true,
        modelId: candidate.id,
        baselineAboveProbability: base.aboveProbability,
      });
      expect(active.aboveProbability).toBe(
        shadow.researchExperiment.variants[candidate.variantName].aboveProbability,
      );
      expect(active.belowProbability).toBe(1 - active.aboveProbability);
      expect(
        replayResearchInputSnapshot(createResearchInputSnapshot(values, models, START, active))
          .aboveProbability,
      ).toBe(active.aboveProbability);
    },
  );

  test.each([
    'unvalidated',
    'future-activation',
    'different-evaluation',
    'future-training',
    'retired',
  ])('ignores a %s challenger without withholding a forecast', (reason) => {
    const values = input();
    const artifact = challenger(values);
    artifact.activation = {
      modelId: artifact.id,
      activatedAt: NOW - 1,
      shadowEvaluation: { modelId: artifact.id, eligibleForPromotion: true, evaluatedAt: NOW - 1 },
    };
    if (reason === 'unvalidated') artifact.activation.shadowEvaluation.eligibleForPromotion = false;
    if (reason === 'future-activation') artifact.activation.activatedAt = NOW + 1;
    if (reason === 'different-evaluation')
      artifact.activation.shadowEvaluation.modelId = 'another-model';
    if (reason === 'future-training') artifact.trainedAt = artifact.shadowStartsAt = START + 1;
    if (reason === 'retired') artifact.retirement = { retiredAt: NOW - 1 };
    const result = getCurrentResearchForecast(values, { challengers: { active: artifact } }, START);
    expect(result.available).toBe(true);
    expect(result.learning?.applied).not.toBe(true);
    expect(result.aboveProbability).toBe(getCurrentResearchForecast(values).aboveProbability);
  });
  test('records v2 alternatives without replacing production and replays both generations', () => {
    const values = input();
    values.kalshiMarket = { ...values.kalshiMarket, receivedAt: NOW, yesBid: 0.29, yesAsk: 0.31 };
    const current = getCurrentResearchForecast(values, {}, START);
    const legacy = getResearchForecast(values, {}, START);
    expect(current.aboveProbability).toBe(legacy.aboveProbability);
    expect(current.researchExperiment.version).toBe(RESEARCH_EXPERIMENT_V2);
    expect(Object.keys(current.researchExperiment.variants)).toEqual(
      getResearchVariantNames(RESEARCH_EXPERIMENT_V2),
    );
    expect(current.researchExperiment.variants['market-blend'].aboveProbability).not.toBe(
      current.aboveProbability,
    );
    expect(current.researchExperiment.variants['reversal-candidate'].available).toBe(false);
    for (const forecast of [current, legacy]) {
      const snapshot = createResearchInputSnapshot(values, {}, START, forecast);
      expect(
        replayResearchInputSnapshot(JSON.parse(JSON.stringify(snapshot))).researchExperiment,
      ).toEqual(forecast.researchExperiment);
    }
  });
  test('v3 preserves both a calibrated incumbent and its same-family replacement in exact replay', () => {
    const getV3ResearchForecast = (values, models, windowStartAt) =>
      getLatestResearchForecast(values, models, windowStartAt, {
        researchVersion: RESEARCH_EXPERIMENT_V3,
      });
    const values = input();
    values.kalshiMarket.startsAt = NOW - 9 * MINUTE;
    values.kalshiMarket.expiresAt = NOW + 6 * MINUTE;
    const active = {
      ...challenger(values),
      id: `${CURRENT_CHALLENGER_MODEL_VERSION}-reduced-pressure-active`,
      version: CURRENT_CHALLENGER_MODEL_VERSION,
      policyVersion: CURRENT_CHALLENGER_POLICY_VERSION,
      requirements: { ...CURRENT_CHALLENGER_REQUIREMENTS },
      calibration: {
        version: CHALLENGER_CALIBRATION_VERSION,
        primaryCutoffAt: START - 4000,
        startedAt: START - 3000,
        cutoffAt: START - 2000,
        independentWindows: 20,
        checkpoints: fitCheckpointCalibration(
          Array.from({ length: 20 }, (_, index) => ({
            horizonMinutes: 6,
            probability: 0.8,
            outcome: index % 2,
          })),
        ),
      },
    };
    active.activation = {
      modelId: active.id,
      activatedAt: START,
      shadowEvaluation: {
        modelId: active.id,
        phase: 'confirmation',
        eligibleForPromotion: true,
        approvedCheckpoints: [6],
        evaluatedAt: START,
      },
    };
    const candidate = {
      ...active,
      id: `${CURRENT_CHALLENGER_MODEL_VERSION}-reduced-pressure-replacement`,
      activation: undefined,
      calibration: { ...active.calibration, checkpoints: fitCheckpointCalibration([]) },
    };
    const models = { challengers: { active, candidates: [candidate] } };
    const result = getV3ResearchForecast(values, models, values.kalshiMarket.startsAt);
    expect(result.learning).toMatchObject({ applied: true, modelId: active.id });
    expect(result.researchExperiment.version).toBe(RESEARCH_EXPERIMENT_V3);
    expect(result.researchExperiment.activePrediction.modelId).toBe(active.id);
    expect(result.researchExperiment.variants['reduced-pressure'].modelId).toBe(candidate.id);
    expect(result.researchExperiment.activePrediction.aboveProbability).not.toBe(
      result.researchExperiment.variants['reduced-pressure'].aboveProbability,
    );
    expect(
      replayResearchInputSnapshot(
        createResearchInputSnapshot(values, models, values.kalshiMarket.startsAt, result),
      ).researchExperiment,
    ).toEqual(result.researchExperiment);
    active.activation.shadowEvaluation.approvedCheckpoints = [9];
    const outside = getV3ResearchForecast(values, models, values.kalshiMarket.startsAt);
    expect(outside.available).toBe(true);
    expect(outside.learning?.applied).not.toBe(true);
    expect(outside.aboveProbability).toBe(getV3ResearchForecast(values).aboveProbability);
  });
  test('current sparse-history calculations and legacy strict-history calculations each replay exactly', () => {
    const values = input();
    values.benchmark.samples = values.benchmark.samples.filter(
      (sample) => sample.time !== NOW - 90_000,
    );
    const current = getLatestResearchForecast(values, {}, START, {
      researchVersion: RESEARCH_EXPERIMENT_V4,
    });
    const legacy = getLatestResearchForecast(values, {}, START, {
      researchVersion: RESEARCH_EXPERIMENT_V3,
    });
    expect(current.researchExperiment.version).toBe(RESEARCH_EXPERIMENT_V4);
    expect(current.kalshi.priceDynamicsSource).toBe('cf-brti-history');
    expect(legacy.kalshi.priceDynamicsSource).toBe('coinbase-candles');
    expect(current.modelVersion).not.toBe(legacy.modelVersion);
    for (const forecast of [current, legacy]) {
      const snapshot = createResearchInputSnapshot(values, {}, START, forecast);
      expect(replayResearchInputSnapshot(snapshot).researchExperiment).toEqual(
        forecast.researchExperiment,
      );
    }
  });
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

  test('accepts only negligible browser-versus-Node floating-point variation without rewriting saved values', () => {
    const snapshot = createResearchInputSnapshot(input(), {}, START);
    const original = snapshot.expectedExperiment.variants.combined.aboveProbability;
    snapshot.expectedExperiment.variants.combined.aboveProbability += Number.EPSILON;
    const saved = JSON.stringify(snapshot);
    const replay = replayResearchInputSnapshot(snapshot);
    expect(replay.researchExperiment.variants.combined.aboveProbability).toBe(original);
    expect(JSON.stringify(snapshot)).toBe(saved);
    snapshot.expectedExperiment.variants.combined.aboveProbability = original + 1e-10;
    expect(() => replayResearchInputSnapshot(snapshot)).toThrow(/differs/);
  });

  test.each([
    [
      'market identity',
      (experiment) => {
        experiment.marketTicker += '-changed';
      },
    ],
    [
      'deadline',
      (experiment) => {
        experiment.expiresAt += 1;
      },
    ],
    [
      'missing key',
      (experiment) => {
        delete experiment.variants.combined.aboveProbability;
      },
    ],
    [
      'extra key',
      (experiment) => {
        experiment.variants.combined.extra = null;
      },
    ],
    [
      'number type',
      (experiment) => {
        experiment.variants.combined.aboveProbability = String(
          experiment.variants.combined.aboveProbability,
        );
      },
    ],
    [
      'null type',
      (experiment) => {
        experiment.variants.combined.aboveProbability = null;
      },
    ],
    [
      'array shape',
      (experiment) => {
        experiment.variants.combined.fallbacks = {};
      },
    ],
    [
      'non-finite number',
      (experiment) => {
        experiment.variants.combined.aboveProbability = Infinity;
      },
    ],
  ])('replay still rejects a changed %s', (_, mutate) => {
    const snapshot = createResearchInputSnapshot(input(), {}, START);
    mutate(snapshot.expectedExperiment);
    expect(() => replayResearchInputSnapshot(snapshot)).toThrow(/differs/);
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
