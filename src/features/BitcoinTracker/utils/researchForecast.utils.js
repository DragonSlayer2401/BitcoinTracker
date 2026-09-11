import { getPressureForecast } from './pressureForecast.utils';
import { getKalshiMarketConditions } from './kalshi/marketConditions.utils';
import { getLearningFeatures } from './learning/features.utils';
import { applyOutcomeModel, predictOutcomeCandidate } from './learning/model.utils';
import { getKalshiForecast } from './kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from './kalshi/contract.utils';

// All displayed risks and archived candidates share the same target, deadline, and input time.
export function getResearchForecast(input, models = {}, windowStartAt = null) {
  const effectiveInput = {
    ...input,
    target: input.kalshiMarket?.target,
    expiresAt: input.kalshiMarket?.expiresAt,
    horizonMinutes: (input.kalshiMarket?.expiresAt - input.now) / 60_000,
  };
  const pressureBase = getPressureForecast(effectiveInput);
  const base = getKalshiForecast(effectiveInput, pressureBase);
  const outcomeDefinition = KALSHI_OUTCOME_DEFINITION;
  const expiresAt =
    effectiveInput.expiresAt ??
    input.now + (effectiveInput.horizonMinutes ?? base.horizonMinutes) * 60_000;
  const conditions = getKalshiMarketConditions({ ...effectiveInput, forecast: base });
  const learningFeatures = getLearningFeatures({
    forecast: base,
    conditions,
    stream: input.stream,
    spot: base.kalshi?.referencePrice ?? input.ticker?.price,
    target: effectiveInput.target,
    now: input.now,
    expiresAt,
    outcomeDefinition,
  });
  const estimate = applyOutcomeModel(
    base,
    {
      learningFeatures,
      target: effectiveInput.target,
      expiresAt,
      now: input.now,
    },
    models?.active?.outcomeDefinition === outcomeDefinition ? models.active : null,
  );
  const candidate =
    models?.candidate?.outcomeDefinition === outcomeDefinition ? models.candidate : null;
  const shadowProbability =
    candidate && Number.isFinite(windowStartAt) && candidate.trainedAt < windowStartAt
      ? predictOutcomeCandidate(candidate, learningFeatures)
      : null;
  return {
    ...estimate,
    target: effectiveInput.target,
    expiresAt,
    outcomeDefinition,
    learningFeatures,
    shadowPrediction: Number.isFinite(shadowProbability)
      ? {
          modelId: candidate.id,
          aboveProbability: shadowProbability,
          featureCutoffAt: input.now,
        }
      : null,
  };
}
