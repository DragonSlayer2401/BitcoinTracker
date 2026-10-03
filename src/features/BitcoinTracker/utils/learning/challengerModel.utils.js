import jStat from 'jstat';
import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import { getKalshiMarketProbability, getKalshiQuoteSnapshot } from '../kalshi/marketQuote.utils';
import { PRESSURE_RESEARCH_POLICIES, MARKET_BLEND_POLICY } from '../researchVariantConfig.utils';
import {
  getLearningFeatureSchema,
  getLearningPipeline,
  isLearningFeatureSnapshot,
  isLearningSchemaCompatibleWithBaseline,
  matchesLearningPipeline,
} from './features.utils';
import { getBoundedProbability, logit, predictLogistic } from './statistics.utils';
import {
  applyCheckpointCalibration,
  getChallengerCheckpoint,
  isCheckpointCalibration,
  MINIMUM_CHALLENGER_CALIBRATION_WINDOWS,
  DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION,
} from './challengerCheckpoint.utils';
import {
  DIRECTIONAL_REVERSAL_KIND,
  DIRECTIONAL_REVERSAL_POLICY_VERSION,
  DIRECTIONAL_REVERSAL_FEATURE_NAMES,
  getDirectionalCurrentSide,
  getDirectionalReversalFeatures,
  getDirectionalOutcomeProbability,
  DIRECTIONAL_REGULARIZATION_POLICY,
  DIRECTIONAL_REGULARIZATION_GRID,
} from './directionalReversal.utils';
export { DIRECTIONAL_REVERSAL_KIND, DIRECTIONAL_REVERSAL_POLICY_VERSION };

export const LEGACY_CHALLENGER_MODEL_VERSION = 'forecast-challenger-v1';
export const LEGACY_CHALLENGER_POLICY_VERSION = 'kalshi-pressure-policies-v1';
export const CHALLENGER_MODEL_VERSION = 'forecast-challenger-v2';
export const CHALLENGER_POLICY_VERSION = 'kalshi-pressure-policies-v2';
// Only newly fitted reversal candidates opt into these additional coefficient positions.
// An absent version preserves the six inputs used by saved V1 and V2 artifacts.
export const REVERSAL_PRESSURE_FEATURE_VERSION = 'reversal-pressure-context-v1';
export const LEGACY_CHALLENGER_KINDS = Object.freeze([
  'reversal',
  'forward-pressure',
  'reduced-pressure',
  'fast-decay',
  'market-blend',
]);
export const CHALLENGER_KINDS = Object.freeze([
  ...LEGACY_CHALLENGER_KINDS,
  DIRECTIONAL_REVERSAL_KIND,
]);
export const CHALLENGER_VARIANTS = Object.freeze({
  reversal: 'reversal-candidate',
  'forward-pressure': 'forward-pressure-candidate',
  'reduced-pressure': 'reduced-pressure',
  'fast-decay': 'fast-decay',
  'market-blend': 'market-blend',
  [DIRECTIONAL_REVERSAL_KIND]: 'directional-reversal-candidate',
});
export const LEGACY_CHALLENGER_REQUIREMENTS = Object.freeze({
  minimumTrainingWindows: 60,
  minimumShadowWindows: 60,
  minimumClassExamples: 10,
  minimumReversalExamples: 12,
  minimumModelUses: 30,
  minimumNewWindowsForRetraining: 20,
  blendWeight: 0.2,
  maximumProbabilityAdjustment: 0.05,
  maximumReversalFalseAlarmRate: 0.5,
  familyConfidenceLevel: 0.99,
  bootstrapReplicates: 2000,
  forwardHorizonSeconds: 60,
  minimumMonitoringWindows: 40,
  maximumBrierDeterioration: 0.005,
  maximumAccuracyDeterioration: 0.05,
});
export const CHALLENGER_REQUIREMENTS = Object.freeze({
  ...LEGACY_CHALLENGER_REQUIREMENTS,
  minimumCalibrationWindows: MINIMUM_CHALLENGER_CALIBRATION_WINDOWS,
  minimumConfirmationWindows: 60,
  checkpointToleranceSeconds: 5,
});
const { blendWeight, maximumProbabilityAdjustment, ...directionalRequirements } =
  CHALLENGER_REQUIREMENTS;
export const DIRECTIONAL_REVERSAL_REQUIREMENTS = Object.freeze({
  ...directionalRequirements,
  probabilityMode: 'direct-calibrated-flip',
  calibrationTarget: 'opposite-current-side',
  maximumCalibrationAdjustment: 0.05,
  developmentFamilyCount: 6,
  comparisonCount: 3,
  requiresPositiveDirectionalLift: true,
  regularizationPolicy: DIRECTIONAL_REGULARIZATION_POLICY,
});
export const isDirectionalReversalChallenger = (artifact) =>
  artifact?.kind === DIRECTIONAL_REVERSAL_KIND;
export const getChallengerRequirements = (version, kind) =>
  version === LEGACY_CHALLENGER_MODEL_VERSION
    ? LEGACY_CHALLENGER_REQUIREMENTS
    : kind === DIRECTIONAL_REVERSAL_KIND
      ? DIRECTIONAL_REVERSAL_REQUIREMENTS
      : CHALLENGER_REQUIREMENTS;
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const bounded = (value, limit) => Math.max(-limit, Math.min(limit, value));
export const isFittedChallenger = (kind) =>
  ['reversal', 'forward-pressure', DIRECTIONAL_REVERSAL_KIND].includes(kind);
export const getChallengerPolicyVersion = (kind, version = CHALLENGER_MODEL_VERSION) =>
  kind === DIRECTIONAL_REVERSAL_KIND
    ? DIRECTIONAL_REVERSAL_POLICY_VERSION
    : (PRESSURE_RESEARCH_POLICIES[kind]?.version ??
      (kind === 'market-blend'
        ? MARKET_BLEND_POLICY.version
        : version === LEGACY_CHALLENGER_MODEL_VERSION
          ? LEGACY_CHALLENGER_POLICY_VERSION
          : CHALLENGER_POLICY_VERSION));

/** Small fixed feature sets; all values were observed before the forecast was captured. */
export function getChallengerFeatures(
  kind,
  snapshot,
  reversalFeatureVersion,
  currentSide,
  marketProbability = null,
) {
  if (kind === DIRECTIONAL_REVERSAL_KIND)
    return getDirectionalReversalFeatures(snapshot, currentSide, marketProbability);
  const schema = getLearningFeatureSchema(snapshot?.schemaVersion);
  if (
    !schema ||
    !Array.isArray(snapshot.values) ||
    (reversalFeatureVersion !== undefined &&
      (kind !== 'reversal' || reversalFeatureVersion !== REVERSAL_PRESSURE_FEATURE_VERSION))
  )
    return null;
  const value = (name) => snapshot.values[schema.names.indexOf(name)] ?? 0;
  const spot = value('flow60Available') === 1;
  const futures = value('futuresFlow60Available') === 1;
  const spotPressure = spot ? value('buyPressure60') : 0;
  const absorption = spotPressure * Math.max(0, -value('priceResponseToPressure'));
  if (kind === 'reversal') {
    const features = [
      bounded(logit(snapshot.baselineAboveProbability), 8),
      value('return3'),
      value('acceleration3'),
      spotPressure,
      bounded(absorption, 8),
      Number(spot),
    ];
    if (reversalFeatureVersion === undefined) return features;
    const pressureChangeAvailable = spot && value('flow15Available') === 1;
    const agreementAvailable = spot && futures;
    const futuresPressure = agreementAvailable ? value('futuresPressure60') : 0;
    // Agreement keeps direction: aligned selling is negative, aligned buying positive.
    // Opposing or balanced flow contributes zero, distinct from an unavailable feed.
    const agreement =
      agreementAvailable && Math.sign(spotPressure) === Math.sign(futuresPressure)
        ? Math.sign(spotPressure) * Math.min(Math.abs(spotPressure), Math.abs(futuresPressure))
        : 0;
    return [
      ...features,
      pressureChangeAvailable ? value('pressureChange') : 0,
      agreement,
      Number(pressureChangeAvailable),
      Number(agreementAvailable),
    ];
  }
  if (kind === 'forward-pressure')
    return [
      spotPressure,
      futures ? value('futuresPressure60') : 0,
      spot && value('flow15Available') === 1 ? value('pressureChange') : 0,
      bounded(absorption, 8),
      Number(spot),
      Number(futures),
    ];
  return [];
}

export function isChallengerArtifact(artifact) {
  const kind = artifact?.kind;
  const legacy = artifact?.version === LEGACY_CHALLENGER_MODEL_VERSION;
  const directional = isDirectionalReversalChallenger(artifact);
  const reversalFeatureVersion = artifact?.reversalFeatureVersion;
  const hasPressureContext = reversalFeatureVersion === REVERSAL_PRESSURE_FEATURE_VERSION;
  const featureCount = directional
    ? DIRECTIONAL_REVERSAL_FEATURE_NAMES.length
    : kind === 'reversal' && hasPressureContext
      ? 10
      : 6;
  const requirements = getChallengerRequirements(artifact?.version, kind);
  const fit = artifact?.model;
  const validFit =
    !isFittedChallenger(kind) ||
    Boolean(
      fit &&
      Array.isArray(fit.indexes) &&
      fit.indexes.length === featureCount &&
      fit.indexes.every((value, index) => value === index) &&
      Array.isArray(fit.means) &&
      fit.means.length === featureCount &&
      fit.means.every(Number.isFinite) &&
      Array.isArray(fit.scales) &&
      fit.scales.length === featureCount &&
      fit.scales.every((value) => Number.isFinite(value) && value > 0) &&
      Array.isArray(fit.coefficients) &&
      fit.coefficients.length === featureCount + 1 &&
      fit.coefficients.every((value) => Number.isFinite(value) && Math.abs(value) <= 1000),
    );
  return Boolean(
    [LEGACY_CHALLENGER_MODEL_VERSION, CHALLENGER_MODEL_VERSION].includes(artifact?.version) &&
    CHALLENGER_KINDS.includes(kind) &&
    (!directional || !legacy) &&
    (reversalFeatureVersion === undefined ||
      (kind === 'reversal' && !legacy && hasPressureContext)) &&
    typeof artifact.id === 'string' &&
    new RegExp(`^${artifact.version}-${kind}-[a-z0-9-]+$`).test(artifact.id) &&
    artifact.variantName === CHALLENGER_VARIANTS[kind] &&
    artifact.status === 'shadow' &&
    artifact.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    artifact.policyVersion ===
      (directional
        ? DIRECTIONAL_REVERSAL_POLICY_VERSION
        : legacy
          ? LEGACY_CHALLENGER_POLICY_VERSION
          : CHALLENGER_POLICY_VERSION) &&
    artifact.variantPolicyVersion === getChallengerPolicyVersion(kind, artifact.version) &&
    timestamp(artifact.trainedAt) &&
    timestamp(artifact.trainingCutoffAt) &&
    artifact.trainingCutoffAt <= artifact.trainedAt &&
    artifact.shadowStartsAt === artifact.trainedAt &&
    artifact.featureVersion === artifact.pipeline?.featureVersion &&
    getLearningFeatureSchema(artifact.featureVersion) &&
    isLearningSchemaCompatibleWithBaseline(
      artifact.featureVersion,
      artifact.pipeline.baselineModelVersion,
    ) &&
    getLearningPipeline({ ...artifact.pipeline, schemaVersion: artifact.featureVersion }) &&
    artifact.pipeline.referenceSource === 'cf-brti' &&
    artifact.pipeline.featureInputSource === 'cf-brti-history' &&
    Object.entries(requirements).every(([key, value]) => artifact.requirements?.[key] === value) &&
    Number.isFinite(artifact.applicability?.minimumHorizonMinutes) &&
    artifact.applicability.minimumHorizonMinutes > 0 &&
    artifact.applicability.maximumHorizonMinutes >= artifact.applicability.minimumHorizonMinutes &&
    artifact.applicability.maximumHorizonMinutes <= 15 &&
    (legacy ||
      (isCheckpointCalibration(artifact.calibration, artifact.trainedAt) &&
        (directional
          ? artifact.calibration.version === DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION &&
            artifact.calibration.target === 'opposite-current-side'
          : artifact.calibration.version !== DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION) &&
        artifact.trainingCutoffAt >= artifact.calibration.cutoffAt)) &&
    validFit &&
    (!directional ||
      (fit.regularization?.version === DIRECTIONAL_REGULARIZATION_POLICY &&
        fit.regularization.criterion === 'event-weighted-forward-validation-brier' &&
        DIRECTIONAL_REGULARIZATION_GRID.includes(fit.penalty) &&
        fit.regularization.selectedPenalty === fit.penalty &&
        Array.isArray(fit.regularization.grid) &&
        fit.regularization.grid.length === DIRECTIONAL_REGULARIZATION_GRID.length &&
        fit.regularization.grid.every(
          (value, index) => value === DIRECTIONAL_REGULARIZATION_GRID[index],
        ) &&
        Array.isArray(fit.regularization.folds) &&
        fit.regularization.fallback === (fit.regularization.folds.length === 0) &&
        (!fit.regularization.fallback || fit.penalty === 0.5) &&
        fit.regularization.folds.every(
          (fold) =>
            Number.isSafeInteger(fold.trainingWindows) &&
            fold.trainingWindows >= 30 &&
            fold.validationWindows === 10 &&
            timestamp(fold.trainingCutoffAt) &&
            timestamp(fold.validationStartedAt) &&
            timestamp(fold.validationCutoffAt) &&
            fold.trainingCutoffAt <= fold.validationStartedAt &&
            fold.validationStartedAt <= fold.validationCutoffAt &&
            fold.validationCutoffAt <= artifact.calibration.primaryCutoffAt,
        ))),
  );
}

export function matchesChallengerPipeline(artifact, snapshot) {
  return (
    matchesLearningPipeline(snapshot, artifact?.pipeline) &&
    snapshot?.schemaVersion === artifact?.featureVersion
  );
}

function getBoundedCorrection(baseline, candidate) {
  return getBoundedProbability(
    baseline +
      bounded(
        CHALLENGER_REQUIREMENTS.blendWeight * (candidate - baseline),
        CHALLENGER_REQUIREMENTS.maximumProbabilityAdjustment,
      ),
  );
}

function getForwardPressureProbability(artifact, features, baseForecast, input) {
  if (features[4] === 0 && features[5] === 0) return baseForecast.aboveProbability;
  const distribution =
    baseForecast.researchVariants?.['settlement-only'] ??
    baseForecast.researchExperiment?.variants?.['settlement-only'];
  const sigma = distribution?.minuteVolatility;
  const mean = distribution?.expectedSettlementAverage;
  const deviation = distribution?.settlementStandardDeviation;
  const reference = distribution?.referencePrice;
  const target = baseForecast.target ?? input?.kalshiMarket?.target;
  const expiresAt = baseForecast.expiresAt ?? input?.kalshiMarket?.expiresAt;
  const now = input?.now;
  if (
    ![sigma, mean, deviation, reference, target].every(
      (value) => Number.isFinite(value) && value > 0,
    ) ||
    !timestamp(now) ||
    !timestamp(expiresAt) ||
    expiresAt <= now ||
    distribution.referenceSource !== 'cf-brti'
  )
    return null;
  const predicted = artifact.model.indexes.reduce(
    (sum, index, column) =>
      sum +
      (artifact.model.coefficients[column + 1] * (features[index] - artifact.model.means[column])) /
        artifact.model.scales[column],
    artifact.model.coefficients[0],
  );
  // Learn one minute of pressure response, then hold that price displacement constant.
  // Never multiply a short-horizon regression by the entire remaining forecast horizon.
  const logShift = bounded(predicted, 1) * sigma;
  let effect = 0;
  for (let second = 1; second <= 60; second++) {
    const time = expiresAt - 60_000 + second * 1000;
    effect += Math.max(0, Math.min(1, (time - now) / 60_000)) / 60;
  }
  const shiftedMean = mean + reference * Math.expm1(logShift) * effect;
  if (!Number.isFinite(shiftedMean) || !(shiftedMean > 0) || target <= 0.005) return null;
  const volatility = Math.sqrt(Math.log1p((deviation / shiftedMean) ** 2));
  if (!Number.isFinite(volatility) || volatility <= 0) return null;
  const median = Math.log(shiftedMean) - volatility ** 2 / 2;
  return getBoundedProbability(
    jStat.normal.cdf((median - Math.log(target - 0.005)) / volatility, 0, 1),
  );
}

/** A challenger returns one YES probability; missing inputs never block the underlying forecast. */
export function predictChallengerProbability(
  artifact,
  { baseForecast, learningFeatures, input, windowStartAt, variantBase } = {},
) {
  const now = learningFeatures?.featureCutoffAt;
  if (
    !isChallengerArtifact(artifact) ||
    artifact.retirement ||
    !baseForecast?.available ||
    !probability(baseForecast.aboveProbability) ||
    (baseForecast.target !== undefined && baseForecast.target !== learningFeatures?.target) ||
    (baseForecast.expiresAt !== undefined &&
      baseForecast.expiresAt !== learningFeatures?.expiresAt) ||
    (input?.now !== undefined && input.now !== now) ||
    !isLearningFeatureSnapshot(learningFeatures, {
      target: learningFeatures?.target,
      expiresAt: learningFeatures?.expiresAt,
      cutoffAt: now,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    }) ||
    !matchesChallengerPipeline(artifact, learningFeatures) ||
    !timestamp(windowStartAt) ||
    windowStartAt <= artifact.trainedAt ||
    windowStartAt > now ||
    now < artifact.trainedAt ||
    learningFeatures.settlementKnownFraction !== 0 ||
    Math.abs(baseForecast.aboveProbability - learningFeatures.baselineAboveProbability) > 1e-9
  )
    return null;
  const horizon = (learningFeatures.expiresAt - now) / 60_000;
  const domain = artifact.applicability;
  if (
    horizon < domain.minimumHorizonMinutes - 5 / 60 ||
    horizon > domain.maximumHorizonMinutes + 5 / 60
  )
    return baseForecast.aboveProbability;
  const raw = getUncalibratedChallengerProbability(artifact, {
    baseForecast,
    learningFeatures,
    input,
    variantBase,
  });
  if (!probability(raw) || artifact.version === LEGACY_CHALLENGER_MODEL_VERSION) return raw;
  if (isDirectionalReversalChallenger(artifact)) {
    const checkpoint = getChallengerCheckpoint(horizon);
    const calibration = artifact.calibration.checkpoints.find(
      (entry) => entry.checkpointMinutes === checkpoint,
    );
    if (calibration?.status !== 'fitted') return baseForecast.aboveProbability;
    const currentSide = getDirectionalSideFromForecast(baseForecast, learningFeatures);
    const rawFlip = getDirectionalOutcomeProbability(raw, currentSide);
    return getDirectionalOutcomeProbability(
      applyCheckpointCalibration(rawFlip, horizon, artifact.calibration),
      currentSide,
    );
  }
  const calibrated = applyCheckpointCalibration(raw, horizon, artifact.calibration);
  return isFittedChallenger(artifact.kind)
    ? getBoundedProbability(
        baseForecast.aboveProbability +
          bounded(
            calibrated - baseForecast.aboveProbability,
            CHALLENGER_REQUIREMENTS.maximumProbabilityAdjustment,
          ),
      )
    : calibrated;
}

/** Used only with partitioned historical rows during fitting; production uses the guarded predictor. */
export function getUncalibratedChallengerProbability(
  artifact,
  { baseForecast, learningFeatures, input, variantBase },
) {
  if (!isFittedChallenger(artifact.kind)) {
    const estimate = variantBase ?? baseForecast.researchVariants?.[artifact.variantName];
    const raw =
      artifact.version === LEGACY_CHALLENGER_MODEL_VERSION
        ? estimate?.aboveProbability
        : (estimate?.rawAboveProbability ?? estimate?.aboveProbability);
    return estimate?.available &&
      estimate.policyVersion === artifact.variantPolicyVersion &&
      probability(raw)
      ? raw
      : null;
  }
  const features = getChallengerFeatures(
    artifact.kind,
    learningFeatures,
    artifact.reversalFeatureVersion,
    getDirectionalSideFromForecast(baseForecast, learningFeatures),
    isDirectionalReversalChallenger(artifact)
      ? getKalshiMarketProbability(
          Object.hasOwn(input ?? {}, 'kalshiQuote')
            ? input.kalshiQuote
            : getKalshiQuoteSnapshot(input?.kalshiMarket, input?.now),
          input?.kalshiMarket,
          input?.now,
        )
      : null,
  );
  if (!features) return null;
  const prediction =
    artifact.kind === 'reversal' || isDirectionalReversalChallenger(artifact)
      ? predictLogistic(artifact.model, features)
      : getForwardPressureProbability(artifact, features, baseForecast, input);
  if (isDirectionalReversalChallenger(artifact))
    return getDirectionalOutcomeProbability(
      prediction,
      getDirectionalSideFromForecast(baseForecast, learningFeatures),
    );
  return probability(prediction)
    ? getBoundedCorrection(baseForecast.aboveProbability, prediction)
    : null;
}

function getDirectionalSideFromForecast(baseForecast, learningFeatures) {
  return getDirectionalCurrentSide(
    baseForecast.kalshi?.referencePrice ??
      baseForecast.researchVariants?.combined?.referencePrice ??
      baseForecast.referencePrice,
    learningFeatures?.target,
  );
}

/** Only the exact timing bands approved in the untouched confirmation cohort may affect live calls. */
export function isApprovedChallengerHorizon(artifact, horizonMinutes) {
  if (artifact?.version === LEGACY_CHALLENGER_MODEL_VERSION) return true;
  const evaluation = artifact?.activation?.shadowEvaluation;
  return (
    artifact?.version === CHALLENGER_MODEL_VERSION &&
    evaluation?.phase === 'confirmation' &&
    evaluation.eligibleForPromotion === true &&
    Array.isArray(evaluation.approvedCheckpoints) &&
    evaluation.approvedCheckpoints.includes(getChallengerCheckpoint(horizonMinutes))
  );
}
