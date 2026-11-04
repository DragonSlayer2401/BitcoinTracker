import { getLearningFeatureSchema } from './features.utils';
import { logit } from './statistics.utils';

export const DIRECTIONAL_REVERSAL_KIND = 'directional-reversal';
export const DIRECTIONAL_REVERSAL_POLICY_VERSION = 'kalshi-directional-reversal-v1';
export const DIRECTIONAL_REGULARIZATION_GRID = Object.freeze([0.001, 0.01, 0.1, 0.5]);
export const DIRECTIONAL_REGULARIZATION_POLICY = 'chronological-ridge-selection-v1';
export const DIRECTIONAL_REVERSAL_FEATURE_NAMES = Object.freeze([
  'absoluteTargetDistance',
  'remainingFraction',
  'return3TowardOppositeSide',
  'acceleration3TowardOppositeSide',
  'spotPressure60TowardOppositeSide',
  'futuresPressure60TowardOppositeSide',
  'spotPressureAvailable',
  'futuresPressureAvailable',
  'marketFlipLogOdds',
  'marketQuoteAvailable',
]);

/** Equality after cent rounding belongs to YES, matching the recorded benchmark. */
export function getDirectionalCurrentSide(referencePrice, target) {
  return Number.isFinite(referencePrice) &&
    referencePrice > 0 &&
    Number.isFinite(target) &&
    target > 0
    ? Number(Math.round(referencePrice * 100) / 100 >= target)
    : null;
}

/** Positive directional inputs point toward the side that would defeat the current-side call. */
export function getDirectionalReversalFeatures(snapshot, currentSide, marketProbability = null) {
  const schema = getLearningFeatureSchema(snapshot?.schemaVersion);
  if (!schema || !Array.isArray(snapshot.values) || ![0, 1].includes(currentSide)) return null;
  const value = (name) => snapshot.values[schema.names.indexOf(name)] ?? 0;
  const towardOpposite = currentSide === 1 ? -1 : 1;
  const spotAvailable = value('flow60Available') === 1;
  const futuresAvailable = value('futuresFlow60Available') === 1;
  const marketAvailable =
    Number.isFinite(marketProbability) && marketProbability >= 0 && marketProbability <= 1;
  const horizon = (snapshot.expiresAt - snapshot.featureCutoffAt) / 60_000;
  const features = [
    Math.min(8, Math.abs(snapshot.targetDistance)),
    horizon / 15,
    towardOpposite * value('return3'),
    towardOpposite * value('acceleration3'),
    spotAvailable ? towardOpposite * value('buyPressure60') : 0,
    futuresAvailable ? towardOpposite * value('futuresPressure60') : 0,
    Number(spotAvailable),
    Number(futuresAvailable),
    marketAvailable
      ? Math.max(
          -8,
          Math.min(8, logit(getDirectionalOutcomeProbability(marketProbability, currentSide))),
        )
      : 0,
    Number(marketAvailable),
  ];
  return features.every(Number.isFinite) && horizon > 0 && horizon <= 15 ? features : null;
}

/** Flip means the final official outcome differs, not that price ever touches the target. */
export function getDirectionalOutcomeProbability(flipProbability, currentSide) {
  if (
    !Number.isFinite(flipProbability) ||
    flipProbability < 0 ||
    flipProbability > 1 ||
    ![0, 1].includes(currentSide)
  )
    return null;
  return currentSide === 1 ? 1 - flipProbability : flipProbability;
}
