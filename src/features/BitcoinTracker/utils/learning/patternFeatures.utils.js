import { isLearningFeatureSnapshot } from './features.utils';
import { PATTERN_FEATURE_DEFINITIONS } from '../patterns/patternConfig';

// This separate snapshot does not change the positions or dimensions of v2/v3 coefficients.
export const LEGACY_PATTERN_FEATURE_VERSION = 'deadline-pattern-features-v4';
export const LEGACY_PATTERN_DETECTOR_VERSION = 'brti-patterns-v1';
export const PATTERN_FEATURE_VERSION = 'deadline-pattern-features-v5';
export const PATTERN_DETECTOR_VERSION = 'brti-patterns-v2';
export const PATTERN_FAMILIES = Object.freeze([
  'rangeBreakouts',
  'targetCrossings',
  'compressionExpansion',
  'trendPullback',
  'candles',
]);
export const PATTERN_FEATURE_NAMES = Object.freeze([
  ...PATTERN_FEATURE_DEFINITIONS.map(({ name }) => name),
  ...PATTERN_FEATURE_DEFINITIONS.map(({ name }) => `${name}Available`),
]);
const featureCount = PATTERN_FEATURE_DEFINITIONS.length;
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const copy = (value) => JSON.parse(JSON.stringify(value));

/** Frozen positional encodings remain distinct even when their dimensions are unchanged. */
export function getPatternFeatureSchema(version) {
  if (version === PATTERN_FEATURE_VERSION)
    return { patternVersion: PATTERN_DETECTOR_VERSION, names: PATTERN_FEATURE_NAMES };
  if (version === LEGACY_PATTERN_FEATURE_VERSION)
    return { patternVersion: LEGACY_PATTERN_DETECTOR_VERSION, names: PATTERN_FEATURE_NAMES };
  return null;
}

/** Durations use fractions of a contract; USD excursions use per-mille of the exact target. */
function encodeFeature({ name, unit }, value, target) {
  const divisor =
    unit === 'USD'
      ? target / 1000
      : name.includes('Seconds')
        ? 900
        : name.includes('Minutes')
          ? 15
          : 1;
  return Math.max(-8, Math.min(8, value / divisor));
}

/** Capture optional inputs once. Old prospective records are never passed through this builder. */
export function getPatternLearningFeatures({ learningFeatures, chartPatterns } = {}) {
  const schemaVersion =
    chartPatterns?.version === LEGACY_PATTERN_DETECTOR_VERSION
      ? LEGACY_PATTERN_FEATURE_VERSION
      : PATTERN_FEATURE_VERSION;
  const patternVersion = getPatternFeatureSchema(schemaVersion).patternVersion;
  const baselineValid = isLearningFeatureSnapshot(learningFeatures, {
    target: learningFeatures?.target,
    expiresAt: learningFeatures?.expiresAt,
    cutoffAt: learningFeatures?.featureCutoffAt,
  });
  if (!baselineValid)
    return {
      schemaVersion,
      available: false,
      patternAvailable: false,
      reason: 'A valid contemporaneous baseline snapshot is required.',
      values: null,
    };
  const cutoffAt = learningFeatures.featureCutoffAt;
  const detectorValid = Boolean(
    chartPatterns?.version === patternVersion &&
    chartPatterns.source === 'brti' &&
    chartPatterns.capturedAt === cutoffAt &&
    chartPatterns.targetPrice === learningFeatures.target &&
    isTimestamp(chartPatterns.availableAt) &&
    chartPatterns.availableAt <= cutoffAt &&
    cutoffAt - chartPatterns.availableAt <= 120_000,
  );
  const observed = PATTERN_FEATURE_DEFINITIONS.map(
    ({ name, family }) =>
      detectorValid &&
      chartPatterns.families?.[family]?.available === true &&
      isNumber(chartPatterns.features?.[name]),
  );
  const patternAvailable = observed.some(Boolean);
  return {
    schemaVersion,
    baselineFeatureVersion: learningFeatures.schemaVersion,
    baselineFeatures: copy(learningFeatures),
    patternVersion,
    patternSource: 'brti',
    available: true,
    patternAvailable,
    reason: patternAvailable
      ? null
      : 'Pattern inputs are unavailable; retain baseline probability.',
    values: [
      ...PATTERN_FEATURE_DEFINITIONS.map((definition, index) =>
        observed[index]
          ? encodeFeature(
              definition,
              chartPatterns.features[definition.name],
              learningFeatures.target,
            )
          : 0,
      ),
      ...observed.map(Number),
    ],
    familyAvailability: Object.fromEntries(
      PATTERN_FAMILIES.map((family) => [
        family,
        PATTERN_FEATURE_DEFINITIONS.some(
          (definition, index) => definition.family === family && observed[index],
        ),
      ]),
    ),
    featureCutoffAt: cutoffAt,
    availableAt: detectorValid ? chartPatterns.availableAt : null,
    target: learningFeatures.target,
    expiresAt: learningFeatures.expiresAt,
    outcomeDefinition: learningFeatures.outcomeDefinition,
  };
}

export function isPatternLearningFeatureSnapshot(
  snapshot,
  { target, expiresAt, cutoffAt, baselineFeatures } = {},
) {
  const baseline = snapshot?.baselineFeatures;
  const schema = getPatternFeatureSchema(snapshot?.schemaVersion);
  return Boolean(
    schema &&
    snapshot.available === true &&
    snapshot.patternVersion === schema.patternVersion &&
    snapshot.patternSource === 'brti' &&
    snapshot.baselineFeatureVersion === baseline?.schemaVersion &&
    isLearningFeatureSnapshot(baseline, { target, expiresAt, cutoffAt }) &&
    snapshot.target === target &&
    snapshot.expiresAt === expiresAt &&
    snapshot.featureCutoffAt === cutoffAt &&
    snapshot.outcomeDefinition === baseline.outcomeDefinition &&
    (!baselineFeatures || JSON.stringify(baseline) === JSON.stringify(baselineFeatures)) &&
    Array.isArray(snapshot.values) &&
    snapshot.values.length === PATTERN_FEATURE_NAMES.length &&
    snapshot.values.every((value) => isNumber(value) && Math.abs(value) <= 8) &&
    snapshot.values.slice(featureCount).every((value) => value === 0 || value === 1) &&
    snapshot.values
      .slice(0, featureCount)
      .every((value, index) => snapshot.values[index + featureCount] === 1 || value === 0) &&
    snapshot.patternAvailable === snapshot.values.slice(featureCount).some(Boolean) &&
    (snapshot.availableAt === null ||
      (isTimestamp(snapshot.availableAt) &&
        snapshot.availableAt <= cutoffAt &&
        cutoffAt - snapshot.availableAt <= 120_000)) &&
    (!snapshot.patternAvailable || snapshot.availableAt !== null) &&
    PATTERN_FAMILIES.every(
      (family) =>
        snapshot.familyAvailability?.[family] ===
        PATTERN_FEATURE_DEFINITIONS.some(
          (definition, index) =>
            definition.family === family && snapshot.values[featureCount + index] === 1,
        ),
    ),
  );
}

export function getPatternAvailabilitySignature(snapshot) {
  return snapshot.values.slice(featureCount).join('');
}

export function getPatternModelValues(snapshot) {
  return [...snapshot.baselineFeatures.values, ...snapshot.values];
}

/** Predeclared family removal includes the missingness indicators for those features. */
export function getPatternModelIndexes(kind, baselineLength) {
  const baselineIndexes = Array.from({ length: baselineLength }, (_, index) => index);
  if (kind === 'baseline-control') return baselineIndexes;
  const excludedFamily = kind.startsWith('without-') ? kind.slice('without-'.length) : null;
  return [
    ...baselineIndexes,
    ...PATTERN_FEATURE_NAMES.flatMap((_, index) =>
      PATTERN_FEATURE_DEFINITIONS[index % featureCount].family === excludedFamily
        ? []
        : [baselineLength + index],
    ),
  ];
}

/** Conflicting duplicates invalidate evidence instead of silently replacing the first capture. */
export function getConflictingPatternForecastIds(events, now) {
  const fingerprints = new Map();
  const conflicts = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (
      event?.event !== 'decision' ||
      typeof event.forecastId !== 'string' ||
      !isTimestamp(event.recordedAt) ||
      event.recordedAt > now
    )
      continue;
    const fingerprint = JSON.stringify(
      {
        chartPatterns: event.chartPatterns,
        patternLearningFeatures: event.patternLearningFeatures,
        patternShadowPredictions: event.patternShadowPredictions,
      },
      (_key, entry) =>
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? Object.fromEntries(
              Object.keys(entry)
                .sort()
                .map((key) => [key, entry[key]]),
            )
          : entry,
    );
    if (fingerprints.has(event.forecastId) && fingerprints.get(event.forecastId) !== fingerprint)
      conflicts.add(event.forecastId);
    fingerprints.set(event.forecastId, fingerprint);
  }
  return conflicts;
}
