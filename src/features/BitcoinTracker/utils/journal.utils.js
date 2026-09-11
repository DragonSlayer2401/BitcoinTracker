import {
  FIXED_PREDICTION_POLICY_VERSION,
  MARKET_AWARE_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
  KALSHI_POLICY_VERSION,
  usesSnapshotPolicy,
  getFixedForecastAnalysis,
  getQualifyingDirection,
} from './fixedPrediction.utils';
import { DEADLINE_OUTCOME_DEFINITION, isVerifiedDeadlineOutcome } from './outcome.utils';
import { PRESSURE_MODEL_VERSION } from './pressureForecast.utils';
import {
  OUTCOME_MODEL_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
  CALIBRATION_VERSION,
} from './learning/model.utils';
import { LEARNING_FEATURE_VERSION } from './learning/features.utils';
import {
  KALSHI_OUTCOME_DEFINITION,
  isKalshiContract,
  isVerifiedKalshiOutcome,
} from './kalshi/contract.utils';
import { KALSHI_MODEL_VERSION, KALSHI_MODEL_PARAMETERS } from './kalshi/forecast.utils';

const journalKey = 'bitcoin-tracker:journal:v1';
const journalVersion = 7;
const forecastDuration = 15 * 60 * 1000;
const observationWindow = 15 * 1000;
const scheduleStartGrace = 15 * 1000;
const maximumScheduleDelay = 24 * 60 * 60 * 1000;
const maximumForecasts = 100;
// Persisted calls retain the model and assumptions used at capture. A new live
// model must not invalidate or silently recalculate the user's earlier calls.
const legacyKalshiModelParameters = Object.freeze({
  sampleCount: 60,
  maximumBenchmarkAgeMs: 5000,
  minimumProxyBasisLogDeviation: 0.0005,
});
const kalshiBaselineVersions = ['kalshi-brti-average-v1', KALSHI_MODEL_VERSION];
const learnedModelVersions = [
  'outcome-logistic-v1',
  'outcome-logistic-kalshi-v1',
  OUTCOME_MODEL_VERSION,
  KALSHI_OUTCOME_MODEL_VERSION,
];
const kalshiModelVersions = [
  ...kalshiBaselineVersions,
  'outcome-logistic-kalshi-v1',
  KALSHI_OUTCOME_MODEL_VERSION,
];

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
const scheduleFields = ['id', 'createdAt', 'startsAt', 'expiresAt', 'target', 'status'];
const analysisFields = ['startedAt', 'earliestAt', 'deadline', 'policyVersion'];
const withholdingReasons = [
  'insufficient-time',
  'no-consensus',
  'market-data-unavailable',
  'model-unavailable',
  'market-conditions',
];

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const isProbability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isIdentifier = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;

export function getValidatedForecast(value) {
  if (!isRecord(value)) return null;

  const hasStartsAt = Object.prototype.hasOwnProperty.call(value, 'startsAt');
  const hasTimingMode = Object.prototype.hasOwnProperty.call(value, 'timingMode');
  const hasAnalysis = Object.prototype.hasOwnProperty.call(value, 'analysis');
  const hasDeadlineDefinition = Object.prototype.hasOwnProperty.call(value, 'outcomeDefinition');
  const usesKalshi = value.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const usesPressurePolicy = usesSnapshotPolicy(value.analysis?.policyVersion);
  const usesOutcomeModel = learnedModelVersions.includes(value.modelVersion);
  const isEndTimeCapture = hasTimingMode && value.timingMode === 'end';
  const hasNoFixedPrediction = ['analyzing', 'withheld'].includes(value.status);
  const fields = [...snapshotFields];
  if (hasStartsAt) fields.push('startsAt');
  if (hasTimingMode) fields.push('timingMode');
  if (hasAnalysis) fields.push('analysis');
  if (usesPressurePolicy) fields.push('calculationMode');
  if (usesOutcomeModel) fields.push('learning');
  if (hasDeadlineDefinition) fields.push('outcomeDefinition');
  if (usesKalshi) fields.push('kalshiMarket', 'kalshi');
  if (value.status === 'withheld') fields.push('withholdingReason');
  if (value.status === 'resolved') fields.push(...resultFields);
  if (usesKalshi && value.status === 'resolved') fields.push('kalshiOutcome');
  if (hasDeadlineDefinition && !usesKalshi && value.status === 'resolved')
    fields.push('observedTradeId', 'confirmedThrough', 'completeSince');
  const startsAt = hasStartsAt ? value.startsAt : value.createdAt;
  if (
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.modelVersion) ||
    usesPressurePolicy !==
      [PRESSURE_MODEL_VERSION, ...learnedModelVersions, ...kalshiBaselineVersions].includes(
        value.modelVersion,
      ) ||
    (usesKalshi &&
      (!isKalshiContract(value.kalshiMarket) ||
        value.kalshiMarket.target !== value.target ||
        value.kalshiMarket.expiresAt !== value.expiresAt ||
        value.kalshiMarket.startsAt !== startsAt ||
        value.analysis?.policyVersion !== KALSHI_POLICY_VERSION ||
        !kalshiModelVersions.includes(value.modelVersion) ||
        (hasNoFixedPrediction
          ? value.kalshi !== null
          : !isValidatedKalshiMetadata(value.kalshi, value)))) ||
    (!usesKalshi &&
      (kalshiModelVersions.includes(value.modelVersion) ||
        value.analysis?.policyVersion === KALSHI_POLICY_VERSION)) ||
    (usesOutcomeModel && (hasNoFixedPrediction || !isValidatedLearning(value.learning, value))) ||
    (usesPressurePolicy &&
      (hasNoFixedPrediction
        ? value.calculationMode !== null
        : usesOutcomeModel
          ? value.calculationMode !== 'outcome-trained'
          : !['pressure-adjusted', 'baseline-fallback'].includes(value.calculationMode))) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(startsAt) ||
    !isTimestamp(value.expiresAt) ||
    (hasDeadlineDefinition &&
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
      : value.createdAt - startsAt > scheduleStartGrace) ||
    value.expiresAt - startsAt !== forecastDuration ||
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
    return null;
  }

  if (hasAnalysis) {
    const analysis = value.analysis;
    if (
      !isEndTimeCapture ||
      !isRecord(analysis) ||
      Object.keys(analysis).length !== analysisFields.length ||
      !analysisFields.every((field) => Object.prototype.hasOwnProperty.call(analysis, field)) ||
      !isTimestamp(analysis.startedAt) ||
      !isTimestamp(analysis.earliestAt) ||
      !isTimestamp(analysis.deadline) ||
      analysis.startedAt < startsAt ||
      analysis.startedAt >= value.expiresAt
    ) {
      return null;
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
        !hasDeadlineDefinition) ||
      !analysisFields.every((field) => analysis[field] === expectedAnalysis[field]) ||
      (hasNoFixedPrediction
        ? value.createdAt !== analysis.startedAt
        : value.createdAt < analysis.earliestAt ||
          value.createdAt > analysis.deadline ||
          value.direction !==
            getQualifyingDirection({ ...value, available: true }, analysis.policyVersion))
    ) {
      return null;
    }
  }

  if (
    value.status === 'withheld' &&
    (!withholdingReasons.includes(value.withholdingReason) ||
      (usesPressurePolicy &&
        ['no-consensus', 'market-conditions'].includes(value.withholdingReason)) ||
      (value.withholdingReason === 'insufficient-time') !==
        value.analysis.earliestAt > value.analysis.deadline)
  ) {
    return null;
  }

  if (value.status === 'resolved') {
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
        : hasDeadlineDefinition
          ? !isVerifiedDeadlineOutcome(
              { ...value, status: 'observed' },
              value.expiresAt,
              value.confirmedThrough,
            )
          : value.observedAt < value.expiresAt ||
            value.observedAt > value.expiresAt + observationWindow)
    ) {
      return null;
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

    if (value.outcome !== outcome || value.correct !== correct) return null;
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

function isValidatedLearning(learning, forecast) {
  const fields = [
    'applied',
    'modelId',
    'calibrationVersion',
    'trainingCutoffAt',
    'baselineAboveProbability',
    'aboveProbability',
    'featureVersion',
  ];
  const legacyModel = ['outcome-logistic-v1', 'outcome-logistic-kalshi-v1'].includes(
    forecast.modelVersion,
  );
  return (
    isRecord(learning) &&
    Object.keys(learning).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(learning, field)) &&
    learning.applied === true &&
    isIdentifier(learning.modelId) &&
    learning.modelId.startsWith(`${forecast.modelVersion}-`) &&
    /^[a-z0-9-]+$/.test(learning.modelId.slice(forecast.modelVersion.length + 1)) &&
    learning.calibrationVersion === CALIBRATION_VERSION &&
    learning.featureVersion ===
      (legacyModel ? 'deadline-reversal-features-v1' : LEARNING_FEATURE_VERSION) &&
    isTimestamp(learning.trainingCutoffAt) &&
    learning.trainingCutoffAt < forecast.createdAt &&
    isProbability(learning.baselineAboveProbability) &&
    learning.aboveProbability === forecast.aboveProbability
  );
}

function isValidatedKalshiMetadata(metadata, forecast) {
  if (!isRecord(metadata)) return false;
  const counts = ['observedSampleCount', 'missingElapsedSampleCount', 'futureSampleCount'];
  const numbers = [
    'referencePrice',
    'expectedSettlementAverage',
    'settlementStandardDeviation',
    'settlementLowerBound',
    'settlementUpperBound',
  ];
  const usesProxy = metadata.referenceSource === 'coinbase-proxy';
  const parameters = ['kalshi-brti-average-v1', 'outcome-logistic-kalshi-v1'].includes(
    forecast.modelVersion,
  )
    ? legacyKalshiModelParameters
    : KALSHI_MODEL_PARAMETERS;
  return (
    metadata.marketTicker === forecast.kalshiMarket.ticker &&
    metadata.comparison === 'greater_or_equal' &&
    metadata.roundDigits === 2 &&
    ['coinbase-proxy', 'cf-brti'].includes(metadata.referenceSource) &&
    metadata.modelKind === 'experimental' &&
    metadata.approximate === true &&
    counts.every(
      (field) =>
        Number.isSafeInteger(metadata[field]) && metadata[field] >= 0 && metadata[field] <= 60,
    ) &&
    counts.reduce((sum, field) => sum + metadata[field], 0) === 60 &&
    metadata.futureSampleCount ===
      Math.min(60, Math.ceil((forecast.expiresAt - forecast.createdAt) / 1000)) &&
    numbers.every((field) => isPositiveNumber(metadata[field])) &&
    metadata.settlementLowerBound <= metadata.settlementUpperBound &&
    isTimestamp(metadata.referenceAt) &&
    metadata.referenceAt <= forecast.createdAt &&
    (usesProxy
      ? metadata.referenceAt === forecast.createdAt &&
        isPositiveNumber(metadata.basisLogDeviation) &&
        metadata.basisLogDeviation >= parameters.minimumProxyBasisLogDeviation
      : forecast.createdAt - metadata.referenceAt <= parameters.maximumBenchmarkAgeMs &&
        metadata.basisLogDeviation === 0) &&
    (metadata.requiredFutureAverage === null
      ? metadata.missingElapsedSampleCount > 0
      : typeof metadata.requiredFutureAverage === 'number' &&
        Number.isFinite(metadata.requiredFutureAverage) &&
        metadata.missingElapsedSampleCount === 0) &&
    typeof metadata.warning === 'string' &&
    metadata.warning.length <= 500 &&
    (usesProxy
      ? typeof metadata.basisAssumption === 'string'
      : metadata.basisAssumption === null) &&
    isRecord(metadata.parameters) &&
    Object.entries(parameters).every(([key, value]) => metadata.parameters[key] === value)
  );
}

export function getValidatedJournal(value) {
  if (!Array.isArray(value) || value.length > maximumForecasts) return null;

  const forecasts = value.map(getValidatedForecast);
  if (
    forecasts.some((forecast) => forecast === null) ||
    new Set(forecasts.map((forecast) => forecast.id)).size !== forecasts.length ||
    forecasts.filter((forecast) => ['analyzing', 'pending'].includes(forecast.status)).length > 1
  ) {
    return null;
  }

  return forecasts.sort((first, second) => second.createdAt - first.createdAt);
}

export function getValidatedScheduledForecast(value) {
  const usesKalshi = value?.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const hasDefinition =
    isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'outcomeDefinition');
  const hasPolicy = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'policyVersion');
  const fields = [...scheduleFields];
  if (hasDefinition) fields.push('outcomeDefinition');
  if (hasPolicy) fields.push('policyVersion');
  if (usesKalshi) fields.push('marketTicker', 'eventTicker');
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(value, field)) ||
    (hasDefinition &&
      ![DEADLINE_OUTCOME_DEFINITION, KALSHI_OUTCOME_DEFINITION].includes(
        value.outcomeDefinition,
      )) ||
    (hasPolicy &&
      (!hasDefinition ||
        value.policyVersion !== (usesKalshi ? KALSHI_POLICY_VERSION : PRESSURE_POLICY_VERSION))) ||
    (usesKalshi &&
      (!hasPolicy ||
        typeof value.marketTicker !== 'string' ||
        !/^KXBTC15M-\d{2}[A-Z]{3}\d{6}-\d{2}$/.test(value.marketTicker) ||
        typeof value.eventTicker !== 'string' ||
        !/^KXBTC15M-\d{2}[A-Z]{3}\d{6}$/.test(value.eventTicker) ||
        !value.marketTicker.startsWith(`${value.eventTicker}-`) ||
        value.startsAt % 900_000 !== 0 ||
        value.target !== null)) ||
    !isIdentifier(value.id) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.startsAt) ||
    !isTimestamp(value.expiresAt) ||
    value.startsAt <= value.createdAt ||
    value.startsAt - value.createdAt > maximumScheduleDelay ||
    value.expiresAt - value.startsAt !== forecastDuration ||
    (!usesKalshi && (!isPositiveNumber(value.target) || value.target > 1_000_000_000)) ||
    !['scheduled', 'missed'].includes(value.status)
  ) {
    return null;
  }

  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

export function getValidatedJournalState(value) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, 'forecasts') ||
    !Object.prototype.hasOwnProperty.call(value, 'scheduledForecast')
  ) {
    return null;
  }

  const forecasts = getValidatedJournal(value.forecasts);
  const scheduledForecast = getValidatedScheduledForecast(value.scheduledForecast);
  if (
    forecasts === null ||
    (value.scheduledForecast !== null && scheduledForecast === null) ||
    (scheduledForecast !== null &&
      forecasts.some(
        (forecast) =>
          ['analyzing', 'pending'].includes(forecast.status) ||
          forecast.id === scheduledForecast.id,
      ))
  ) {
    return null;
  }

  return { forecasts, scheduledForecast };
}

export function loadJournal(storage) {
  let savedJournal;
  try {
    const journalStorage = storage === undefined ? window.localStorage : storage;
    savedJournal = journalStorage.getItem(journalKey);
  } catch {
    return {
      forecasts: [],
      scheduledForecast: null,
      warning: 'Forecast history is unavailable on this device.',
    };
  }

  if (savedJournal === null) return { forecasts: [], scheduledForecast: null, warning: null };

  try {
    const parsedJournal = JSON.parse(savedJournal);
    if (
      !isRecord(parsedJournal) ||
      ![1, 2, 3, 4, 5, 6, journalVersion].includes(parsedJournal.version) ||
      Object.keys(parsedJournal).length !== (parsedJournal.version === 1 ? 2 : 3)
    ) {
      throw new Error('Invalid journal version.');
    }
    const journal = getValidatedJournalState({
      forecasts: parsedJournal.forecasts,
      scheduledForecast: parsedJournal.version === 1 ? null : parsedJournal.scheduledForecast,
    });
    if (journal === null) throw new Error('Invalid forecast history.');
    if (
      parsedJournal.version < 3 &&
      journal.forecasts.some((forecast) =>
        Object.prototype.hasOwnProperty.call(forecast, 'analysis'),
      )
    ) {
      throw new Error('Analysis requires the current journal version.');
    }
    if (
      parsedJournal.version < 4 &&
      (journal.scheduledForecast?.outcomeDefinition ||
        journal.forecasts.some((forecast) => forecast.outcomeDefinition))
    )
      throw new Error('Deadline outcomes require journal version 4.');
    if (
      parsedJournal.version < 5 &&
      (journal.scheduledForecast?.policyVersion ||
        journal.forecasts.some(
          (forecast) => forecast.analysis?.policyVersion === PRESSURE_POLICY_VERSION,
        ))
    )
      throw new Error('Pressure forecasts require journal version 5.');
    if (
      parsedJournal.version < 7 &&
      journal.forecasts.some((forecast) => forecast.outcomeDefinition === KALSHI_OUTCOME_DEFINITION)
    )
      throw new Error('Kalshi forecasts require journal version 7.');
    if (
      parsedJournal.version < 6 &&
      journal.forecasts.some((forecast) => learnedModelVersions.includes(forecast.modelVersion))
    )
      throw new Error('Learned forecasts require journal version 6.');
    return { ...journal, warning: null };
  } catch {
    return {
      forecasts: [],
      scheduledForecast: null,
      warning: 'Saved forecast history was invalid and has been ignored.',
    };
  }
}

export function saveJournal(forecasts, storage, scheduledForecast = null) {
  const journal = getValidatedJournalState({ forecasts, scheduledForecast });
  if (journal === null) return 'Forecast history could not be saved because it was invalid.';

  try {
    const journalStorage = storage === undefined ? window.localStorage : storage;
    journalStorage.setItem(journalKey, JSON.stringify({ version: journalVersion, ...journal }));
    return null;
  } catch {
    return 'Forecast history could not be saved on this device.';
  }
}
