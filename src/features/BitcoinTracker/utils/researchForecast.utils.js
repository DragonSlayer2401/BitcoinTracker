import { getPressureForecast } from './pressureForecast.utils';
import { getKalshiMarketConditions } from './kalshi/marketConditions.utils';
import { getLearningFeatures } from './learning/features.utils';
import { calculateChartPatterns } from './patterns/chartPatterns.utils';
import { getPatternLearningFeatures } from './learning/patternFeatures.utils';
import {
  predictPatternCandidates,
  applyPatternModel,
  isPatternModelArtifact,
} from './learning/patternModel.utils';
import {
  applyOutcomeModel,
  predictOutcomeCandidate,
  matchesOutcomeModelPipeline,
} from './learning/model.utils';
import { isEarlyModelArtifact } from './learning/earlyModel.utils';
import { getKalshiForecast } from './kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from './kalshi/contract.utils';
import { getKalshiQuoteSnapshot } from './kalshi/marketQuote.utils';
import { getMarketResearchVariants } from './marketBlendForecast.utils';
import {
  RESEARCH_EXPERIMENT_V2,
  RESEARCH_EXPERIMENT_V3,
  RESEARCH_EXPERIMENT_V4,
  RESEARCH_EXPERIMENT_V5,
  getResearchVariantNames,
} from './researchVariantConfig.utils';
import {
  CHALLENGER_MODEL_VERSION,
  isChallengerArtifact,
  isApprovedChallengerHorizon,
  predictChallengerProbability,
} from './learning/challengerModel.utils';

function applyValidatedChallenger(base, artifact, aboveProbability, now, fallback) {
  const activation = artifact?.activation;
  const evaluation = activation?.shadowEvaluation;
  if (
    !isChallengerArtifact(artifact) ||
    !Number.isFinite(aboveProbability) ||
    activation?.modelId !== artifact.id ||
    evaluation?.modelId !== artifact.id ||
    evaluation?.eligibleForPromotion !== true ||
    !Number.isSafeInteger(evaluation.evaluatedAt) ||
    evaluation.evaluatedAt < artifact.trainedAt ||
    !Number.isSafeInteger(activation.activatedAt) ||
    activation.activatedAt < evaluation.evaluatedAt ||
    activation.activatedAt > now
  )
    return fallback;
  if (
    artifact.version === CHALLENGER_MODEL_VERSION &&
    !isApprovedChallengerHorizon(artifact, (base.expiresAt - now) / 60_000)
  )
    return base;
  return {
    ...base,
    modelVersion: artifact.version,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction: aboveProbability > 0.5 ? 'above' : aboveProbability < 0.5 ? 'below' : 'neutral',
    lowerBound: null,
    upperBound: null,
    intervalAvailable: false,
    intervalReason:
      'The validated probability adjustment does not provide a calibrated price range.',
    learning: {
      applied: true,
      modelId: artifact.id,
      calibrationVersion: artifact.policyVersion,
      trainingCutoffAt: artifact.trainingCutoffAt,
      baselineAboveProbability: base.aboveProbability,
      aboveProbability,
      featureVersion: artifact.featureVersion,
    },
  };
}

// All displayed risks and archived candidates share the same target, deadline, and input time.
export function getResearchForecast(input, models = {}, windowStartAt = null, options = {}) {
  const researchVersion = options.researchVersion ?? RESEARCH_EXPERIMENT_V5;
  const recordsActivePrediction = [
    RESEARCH_EXPERIMENT_V3,
    RESEARCH_EXPERIMENT_V4,
    RESEARCH_EXPERIMENT_V5,
  ].includes(researchVersion);
  const effectiveInput = {
    ...input,
    target: input.kalshiMarket?.target,
    expiresAt: input.kalshiMarket?.expiresAt,
    horizonMinutes: (input.kalshiMarket?.expiresAt - input.now) / 60_000,
  };
  const pressureBase = getPressureForecast(effectiveInput);
  const { researchVariants, ...base } = getKalshiForecast(effectiveInput, pressureBase, {
    includeResearchVariants: true,
    researchVersion,
  });
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
  // Pattern evidence is captured alongside the incumbent schema. It never changes its inputs
  // or probabilities; historical replays explicitly retain their original absent fields.
  const chartPatterns =
    options.capturePatterns === false
      ? null
      : calculateChartPatterns({
          version: options.patternVersion,
          benchmark: input.benchmark,
          targetPrice: effectiveInput.target,
          now: input.now,
          pressure: {
            source: 'coinbase',
            available:
              ['live', 'warming'].includes(input.stream?.status) &&
              input.stream?.flow?.windows?.[60]?.available === true,
            imbalance: input.stream?.flow?.windows?.[60]?.imbalance,
            observedAt: input.stream?.quality?.confirmedThrough,
            receivedAt: input.stream?.quality?.heartbeatAt,
          },
        });
  const patternLearningFeatures = chartPatterns
    ? getPatternLearningFeatures({ learningFeatures, chartPatterns })
    : null;
  const patternShadowPredictions = chartPatterns
    ? predictPatternCandidates({
        candidates: models?.patterns?.candidates ?? [],
        snapshot: patternLearningFeatures,
        windowStartAt: windowStartAt ?? input.kalshiMarket?.startsAt,
      })
    : [];
  let estimate = applyOutcomeModel(
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
    candidate &&
    matchesOutcomeModelPipeline(candidate, learningFeatures) &&
    Number.isFinite(windowStartAt) &&
    candidate.trainedAt < windowStartAt
      ? predictOutcomeCandidate(candidate, learningFeatures)
      : null;
  // The early correction and full classifier keep separate frozen prospective records.
  // The collector passes an analysis report; the browser passes the compact models response.
  const earlyCandidate = models?.earlyCandidate ?? models?.early?.candidate;
  const earlyShadowProbability =
    isEarlyModelArtifact(earlyCandidate) &&
    matchesOutcomeModelPipeline(earlyCandidate, learningFeatures) &&
    Number.isFinite(windowStartAt) &&
    earlyCandidate.trainedAt < windowStartAt
      ? predictOutcomeCandidate(earlyCandidate, learningFeatures)
      : null;
  const variants = Object.fromEntries(
    getResearchVariantNames(researchVersion).map((name) => [
      name,
      researchVariants?.[name] ?? {
        available: false,
        reason: base.reason ?? 'No eligible experimental candidate is available yet.',
        modelVersion: base.modelVersion,
        aboveProbability: null,
        belowProbability: null,
        appliedSpot: false,
        appliedFutures: false,
        fallbacks: [],
        referenceSource: null,
        referencePrice: null,
        referenceAt: null,
        minuteVolatility: null,
        basisLogDeviation: null,
        expectedSettlementAverage: null,
        settlementStandardDeviation: null,
        settlementLowerBound: null,
        settlementUpperBound: null,
      },
    ]),
  );
  let activePrediction = null;
  if (
    [
      RESEARCH_EXPERIMENT_V2,
      RESEARCH_EXPERIMENT_V3,
      RESEARCH_EXPERIMENT_V4,
      RESEARCH_EXPERIMENT_V5,
    ].includes(researchVersion)
  ) {
    Object.assign(
      variants,
      getMarketResearchVariants(
        { ...base, researchVariants },
        {
          market: input.kalshiMarket,
          // Old snapshots retain their original calculation. New captures carry the
          // quote separately so immutable contract rules never discard market prices.
          quote: Object.hasOwn(input, 'kalshiQuote')
            ? input.kalshiQuote
            : getKalshiQuoteSnapshot(input.kalshiMarket, input.now),
          now: input.now,
        },
      ),
    );
    const challengers = models?.challengers;
    const policyVariants = { ...variants };
    const predictionInput = {
      baseForecast: { ...base, researchVariants: variants },
      learningFeatures,
      input: effectiveInput,
      windowStartAt: windowStartAt ?? input.kalshiMarket?.startsAt,
    };
    // Record frozen candidates even while production remains unchanged. An active model
    // and its replacement can have different IDs; validation must retain that distinction.
    const recordedArtifacts = [
      ...(Array.isArray(challengers?.candidates) ? challengers.candidates : []),
      ...(challengers?.active ? [challengers.active] : []),
    ];
    for (const artifact of recordedArtifacts) {
      // An older experiment must keep exactly the alternatives available at capture.
      if (!Object.hasOwn(variants, artifact?.variantName)) continue;
      const variantBase = policyVariants[artifact?.variantName];
      const aboveProbability = predictChallengerProbability(artifact, {
        ...predictionInput,
        variantBase,
      });
      if (!Number.isFinite(aboveProbability)) continue;
      const recorded = {
        ...variants.combined,
        ...(variantBase?.available ? variantBase : {}),
        available: true,
        reason: null,
        aboveProbability,
        belowProbability: 1 - aboveProbability,
        modelId: artifact.id,
        modelVersion: artifact.version,
        policyVersion: variantBase?.policyVersion ?? artifact.policyVersion,
        featureCutoffAt: input.now,
        settlementLowerBound: null,
        settlementUpperBound: null,
        ...(recordsActivePrediction
          ? {
              rawAboveProbability: variantBase?.available ? variantBase.aboveProbability : null,
            }
          : {}),
      };
      if (recordsActivePrediction && artifact.id === challengers?.active?.id)
        activePrediction = recorded;
      else variants[artifact.variantName] = recorded;
    }
    if (challengers?.active && Object.hasOwn(variants, challengers.active.variantName)) {
      const artifact = challengers.active;
      // Never stack a challenger on an older learned correction.
      const aboveProbability = predictChallengerProbability(artifact, {
        ...predictionInput,
        variantBase: policyVariants[artifact.variantName],
      });
      estimate = applyValidatedChallenger(base, artifact, aboveProbability, input.now, estimate);
    }
  }
  const patternActive =
    models?.patterns?.active ?? (isPatternModelArtifact(models?.active) ? models.active : null);
  if (patternActive)
    estimate = applyPatternModel(
      base,
      {
        snapshot: patternLearningFeatures,
        now: input.now,
        windowStartAt: windowStartAt ?? input.kalshiMarket?.startsAt,
      },
      patternActive,
    );
  return {
    ...estimate,
    target: effectiveInput.target,
    expiresAt,
    outcomeDefinition,
    learningFeatures,
    ...(chartPatterns ? { chartPatterns, patternLearningFeatures, patternShadowPredictions } : {}),
    researchExperiment: {
      version: researchVersion,
      capturedAt: input.now,
      marketTicker: input.kalshiMarket?.ticker ?? null,
      target: effectiveInput.target ?? null,
      expiresAt: expiresAt ?? null,
      variants,
      ...(recordsActivePrediction ? { activePrediction } : {}),
      production: {
        available: estimate.available,
        reason: estimate.reason ?? null,
        aboveProbability: estimate.aboveProbability,
        belowProbability: estimate.belowProbability,
        modelVersion: estimate.modelVersion,
        modelId: estimate.learning?.modelId ?? null,
      },
    },
    shadowPrediction: Number.isFinite(shadowProbability)
      ? {
          modelId: candidate.id,
          aboveProbability: shadowProbability,
          featureCutoffAt: input.now,
        }
      : null,
    earlyShadowPrediction: Number.isFinite(earlyShadowProbability)
      ? {
          modelId: earlyCandidate.id,
          aboveProbability: earlyShadowProbability,
          featureCutoffAt: input.now,
        }
      : null,
  };
}
