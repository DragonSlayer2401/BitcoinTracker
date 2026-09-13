import {
  FIXED_PREDICTION_POLICY_VERSION,
  MARKET_AWARE_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
  KALSHI_POLICY_VERSION,
  usesSnapshotPolicy,
  getFixedForecastAnalysis,
  getQualifyingDirection,
} from '../fixedPrediction.utils';
import { DEADLINE_OUTCOME_DEFINITION, isVerifiedDeadlineOutcome } from '../outcome.utils';
import {
  KALSHI_OUTCOME_DEFINITION,
  isKalshiContract,
  isVerifiedKalshiOutcome,
} from '../kalshi/contract.utils';
import {
  isLearnedModelVersion,
  isKalshiModelVersion,
  isSnapshotModelVersion,
  hasValidLearningMetadata,
  hasValidKalshiMetadata,
  hasValidDerivativesMetadata,
} from './modelValidation.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '../kalshi/forecast.utils';
import { DERIVATIVES_LEARNING_FEATURE_VERSION } from '../learning/features.utils';
import {
  isRecord,
  isTimestamp,
  isPositiveNumber,
  isProbability,
  isIdentifier,
  hasOwnField,
  hasExactFields,
  FORECAST_DURATION_MS,
} from './validation.utils';

const SCHEDULE_START_GRACE_MS = 15 * 1000;
const OBSERVATION_WINDOW_MS = 15 * 1000;

const snapshotFields = [
  'id',
  'createdAt',
  'expiresAt',
  'price',
  'target',
  'aboveProbability',
  'belowProbability',
  'direction',
  'modelVersion',
  'status',
];
const resultFields = ['observedPrice', 'observedAt', 'outcome', 'correct'];
const analysisFields = ['startedAt', 'earliestAt', 'deadline', 'policyVersion'];
const withholdingReasons = [
  'insufficient-time',
  'no-consensus',
  'market-data-unavailable',
  'model-unavailable',
  'market-conditions',
];

export function getValidatedForecast(value) {
  if (!isRecord(value)) return null;

  const fields = getExpectedForecastFields(value);
  const startsAt = hasOwnField(value, 'startsAt') ? value.startsAt : value.createdAt;
  if (
    !hasExactFields(value, fields) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.modelVersion) ||
    !hasCompatibleForecastModel(value, startsAt) ||
    !hasValidForecastTiming(value, startsAt) ||
    !hasValidForecastPrediction(value) ||
    !hasValidForecastAnalysis(value, startsAt) ||
    !hasValidWithholdingReason(value) ||
    !hasValidResolvedOutcome(value)
  ) {
    return null;
  }

  return Object.fromEntries(
    fields.map((field) => [
      field,
      field === 'analysis'
        ? Object.fromEntries(analysisFields.map((key) => [key, value.analysis[key]]))
        : value[field],
    ]),
  );
}

function getExpectedForecastFields(value) {
  const hasStartsAt = hasOwnField(value, 'startsAt');
  const hasTimingMode = hasOwnField(value, 'timingMode');
  const hasAnalysis = hasOwnField(value, 'analysis');
  const hasOutcomeDefinition = hasOwnField(value, 'outcomeDefinition');
  const usesKalshi = value.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const usesSnapshotCapture = usesSnapshotPolicy(value.analysis?.policyVersion);
  const usesLearnedModel = isLearnedModelVersion(value.modelVersion);
  const fields = [...snapshotFields];
  if (hasStartsAt) fields.push('startsAt');
  if (hasTimingMode) fields.push('timingMode');
  if (hasAnalysis) fields.push('analysis');
  if (usesSnapshotCapture) fields.push('calculationMode');
  if (usesLearnedModel) fields.push('learning');
  if (hasOutcomeDefinition) fields.push('outcomeDefinition');
  if (usesKalshi) fields.push('kalshiMarket', 'kalshi');
  if (hasOwnField(value, 'derivatives')) fields.push('derivatives');
  if (value.status === 'withheld') fields.push('withholdingReason');
  if (value.status === 'resolved') fields.push(...resultFields);
  if (usesKalshi && value.status === 'resolved') fields.push('kalshiOutcome');
  if (hasOutcomeDefinition && !usesKalshi && value.status === 'resolved')
    fields.push('observedTradeId', 'confirmedThrough', 'completeSince');
  return fields;
}

function hasCompatibleForecastModel(value, startsAt) {
  const usesKalshi = value.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const usesSnapshotCapture = usesSnapshotPolicy(value.analysis?.policyVersion);
  const usesLearnedModel = isLearnedModelVersion(value.modelVersion);
  const hasNoFixedPrediction = ['analyzing', 'withheld'].includes(value.status);
  const usesDerivatives =
    value.modelVersion === KALSHI_DERIVATIVES_MODEL_VERSION ||
    value.learning?.featureVersion === DERIVATIVES_LEARNING_FEATURE_VERSION;
  if (
    usesSnapshotCapture !== isSnapshotModelVersion(value.modelVersion) ||
    (usesKalshi &&
      (!isKalshiContract(value.kalshiMarket) ||
        value.kalshiMarket.target !== value.target ||
        value.kalshiMarket.expiresAt !== value.expiresAt ||
        value.kalshiMarket.startsAt !== startsAt ||
        value.analysis?.policyVersion !== KALSHI_POLICY_VERSION ||
        !isKalshiModelVersion(value.modelVersion) ||
        (hasNoFixedPrediction
          ? value.kalshi !== null
          : !hasValidKalshiMetadata(value.kalshi, value)))) ||
    (!usesKalshi &&
      (isKalshiModelVersion(value.modelVersion) ||
        value.analysis?.policyVersion === KALSHI_POLICY_VERSION)) ||
    (usesLearnedModel &&
      (hasNoFixedPrediction || !hasValidLearningMetadata(value.learning, value))) ||
    (usesDerivatives &&
      !hasNoFixedPrediction &&
      !hasValidDerivativesMetadata(value.derivatives, value)) ||
    (hasOwnField(value, 'derivatives') &&
      (!usesKalshi ||
        !usesDerivatives ||
        (hasNoFixedPrediction
          ? value.derivatives !== null
          : !hasValidDerivativesMetadata(value.derivatives, value)))) ||
    (usesSnapshotCapture &&
      (hasNoFixedPrediction
        ? value.calculationMode !== null
        : usesLearnedModel
          ? value.calculationMode !== 'outcome-trained'
          : !['pressure-adjusted', 'baseline-fallback'].includes(value.calculationMode)))
  ) {
    return false;
  }
  return true;
}

function hasValidForecastTiming(value, startsAt) {
  const hasStartsAt = hasOwnField(value, 'startsAt');
  const hasTimingMode = hasOwnField(value, 'timingMode');
  const hasOutcomeDefinition = hasOwnField(value, 'outcomeDefinition');
  const isEndTimeCapture = hasTimingMode && value.timingMode === 'end';
  if (
    !isTimestamp(value.createdAt) ||
    !isTimestamp(startsAt) ||
    !isTimestamp(value.expiresAt) ||
    (hasOutcomeDefinition &&
      (![DEADLINE_OUTCOME_DEFINITION, KALSHI_OUTCOME_DEFINITION].includes(
        value.outcomeDefinition,
      ) ||
        ![MARKET_AWARE_POLICY_VERSION, PRESSURE_POLICY_VERSION, KALSHI_POLICY_VERSION].includes(
          value.analysis?.policyVersion,
        ))) ||
    (hasTimingMode && (!isEndTimeCapture || !hasStartsAt)) ||
    value.createdAt < startsAt ||
    (isEndTimeCapture
      ? value.createdAt >= value.expiresAt
      : value.createdAt - startsAt > SCHEDULE_START_GRACE_MS) ||
    value.expiresAt - startsAt !== FORECAST_DURATION_MS
  ) {
    return false;
  }
  return true;
}

function hasValidForecastPrediction(value) {
  const usesKalshi = value.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const hasAnalysis = hasOwnField(value, 'analysis');
  const hasNoFixedPrediction = ['analyzing', 'withheld'].includes(value.status);
  if (
    !isPositiveNumber(value.price) ||
    !isPositiveNumber(value.target) ||
    (hasNoFixedPrediction
      ? value.aboveProbability !== null ||
        value.belowProbability !== null ||
        value.direction !== 'neutral' ||
        !hasAnalysis
      : !isProbability(value.aboveProbability) ||
        !isProbability(value.belowProbability) ||
        Math.abs(value.aboveProbability + value.belowProbability - 1) > 0.000001) ||
    !['above', 'below', 'neutral'].includes(value.direction) ||
    ![
      'analyzing',
      'pending',
      'resolved',
      'unobserved',
      'withheld',
      ...(usesKalshi ? ['awaiting-settlement'] : []),
    ].includes(value.status)
  ) {
    return false;
  }
  return true;
}

function hasValidForecastAnalysis(value, startsAt) {
  if (!hasOwnField(value, 'analysis')) return true;

  const hasOutcomeDefinition = hasOwnField(value, 'outcomeDefinition');
  const isEndTimeCapture = hasOwnField(value, 'timingMode') && value.timingMode === 'end';
  const hasNoFixedPrediction = ['analyzing', 'withheld'].includes(value.status);
  const analysis = value.analysis;
  if (
    !isEndTimeCapture ||
    !hasExactFields(analysis, analysisFields) ||
    !isTimestamp(analysis.startedAt) ||
    !isTimestamp(analysis.earliestAt) ||
    !isTimestamp(analysis.deadline) ||
    analysis.startedAt < startsAt ||
    analysis.startedAt >= value.expiresAt
  ) {
    return false;
  }
  const expectedAnalysis = getFixedForecastAnalysis({
    startedAt: analysis.startedAt,
    expiresAt: value.expiresAt,
    policyVersion: analysis.policyVersion,
  });
  if (
    ![
      FIXED_PREDICTION_POLICY_VERSION,
      MARKET_AWARE_POLICY_VERSION,
      PRESSURE_POLICY_VERSION,
      KALSHI_POLICY_VERSION,
    ].includes(analysis.policyVersion) ||
    ([MARKET_AWARE_POLICY_VERSION, PRESSURE_POLICY_VERSION, KALSHI_POLICY_VERSION].includes(
      analysis.policyVersion,
    ) &&
      !hasOutcomeDefinition) ||
    !analysisFields.every((field) => analysis[field] === expectedAnalysis[field]) ||
    (hasNoFixedPrediction
      ? value.createdAt !== analysis.startedAt
      : value.createdAt < analysis.earliestAt ||
        value.createdAt > analysis.deadline ||
        value.direction !==
          getQualifyingDirection({ ...value, available: true }, analysis.policyVersion))
  ) {
    return false;
  }

  return true;
}

function hasValidWithholdingReason(value) {
  const usesSnapshotCapture = usesSnapshotPolicy(value.analysis?.policyVersion);
  if (
    value.status === 'withheld' &&
    (!withholdingReasons.includes(value.withholdingReason) ||
      (usesSnapshotCapture &&
        ['no-consensus', 'market-conditions'].includes(value.withholdingReason)) ||
      (value.withholdingReason === 'insufficient-time') !==
        value.analysis.earliestAt > value.analysis.deadline)
  ) {
    return false;
  }

  return true;
}

function hasValidResolvedOutcome(value) {
  if (value.status !== 'resolved') return true;

  const usesKalshi = value.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const hasOutcomeDefinition = hasOwnField(value, 'outcomeDefinition');
  if (
    !isPositiveNumber(value.observedPrice) ||
    !isTimestamp(value.observedAt) ||
    (usesKalshi
      ? !isVerifiedKalshiOutcome(
          value.kalshiOutcome,
          value.kalshiMarket,
          value.kalshiOutcome?.confirmedThrough,
        ) ||
        value.observedPrice !== value.kalshiOutcome.observedPrice ||
        value.observedAt !== value.expiresAt
      : hasOutcomeDefinition
        ? !isVerifiedDeadlineOutcome(
            { ...value, status: 'observed' },
            value.expiresAt,
            value.confirmedThrough,
          )
        : value.observedAt < value.expiresAt ||
          value.observedAt > value.expiresAt + OBSERVATION_WINDOW_MS)
  ) {
    return false;
  }

  const outcome = usesKalshi
    ? value.kalshiOutcome.outcome
    : value.observedPrice > value.target
      ? 'above'
      : value.observedPrice < value.target
        ? 'below'
        : 'equal';
  const correct =
    value.direction === 'neutral' || outcome === 'equal' ? null : value.direction === outcome;

  if (value.outcome !== outcome || value.correct !== correct) return false;

  return true;
}
