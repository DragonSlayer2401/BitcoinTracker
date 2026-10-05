import { getKalshiContract, isSameKalshiContract } from '../../../utils/kalshi/contract.utils';
import {
  getKalshiMarketProbability,
  getKalshiQuoteSnapshot,
} from '../../../utils/kalshi/marketQuote.utils';
import { getKalshiPurchaseValue } from '../../../utils/kalshi/purchaseValue.utils';
import { getResearchForecast } from '../../../utils/researchForecast.utils';
import { getChallengerCheckpoint } from '../../../utils/learning/challengerCheckpoint.utils';
import {
  createResearchInputSnapshot,
  RESEARCH_INPUT_SNAPSHOT_VERSION,
} from '../../../utils/researchExperiments.utils';

export const ADVISOR_FORECAST_RECONCILIATION_VERSION = 'advisor-forecast-reconciliation-v1';
// A frozen exploratory flag for review, not a fitted trading rule or a stale-data diagnosis.
export const ADVISOR_FORECAST_DISAGREEMENT_THRESHOLD = 0.15;

const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const difference = (left, right) => (probability(left) && probability(right) ? left - right : null);

/** Derive the comparison midpoint from the exact two-sided execution depth. */
export function getAdvisorBookQuote({ contract, book, now }) {
  if (
    !timestamp(now) ||
    !timestamp(book?.requestedAt) ||
    !timestamp(book?.receivedAt) ||
    book.requestedAt > book.receivedAt ||
    book.receivedAt > now ||
    (book.target !== undefined && book.target !== contract?.target) ||
    (book.expiresAt !== undefined && book.expiresAt !== contract?.expiresAt)
  )
    return null;
  // Reuse execution's contract, freshness, price precision and ordered-depth validation.
  // Fees do not change a midpoint, and remain the execution engine's responsibility.
  const value = getKalshiPurchaseValue({
    book,
    contract,
    aboveProbability: 0.5,
    contracts: 1,
    accountType: 'direct',
    now,
  });
  if (!value.available || !book.yesAsks.length || !book.noAsks.length) return null;
  const yesAsk = book.yesAsks[0].price;
  const noAsk = book.noAsks[0].price;
  const quote = {
    marketTicker: contract.ticker,
    target: contract.target,
    expiresAt: contract.expiresAt,
    requestedAt: book.requestedAt,
    receivedAt: book.receivedAt,
    yesBid: Math.round((1 - noAsk) * 10_000) / 10_000,
    yesAsk,
    noBid: Math.round((1 - yesAsk) * 10_000) / 10_000,
    noAsk,
  };
  return getKalshiMarketProbability(quote, contract, now) === null ? null : quote;
}

function getMarketBlendEvidence(
  variant,
  artifact = null,
  horizonMinutes = null,
  rawModelVersion = null,
) {
  const rawAboveProbability = variant?.rawAboveProbability ?? variant?.aboveProbability;
  const available = Boolean(
    variant?.available &&
    variant.appliedMarket &&
    probability(variant.marketProbability) &&
    probability(variant.marketWeight) &&
    probability(rawAboveProbability) &&
    probability(variant.aboveProbability),
  );
  const checkpointMinutes = getChallengerCheckpoint(horizonMinutes);
  const checkpoint = artifact?.calibration?.checkpoints?.find(
    (entry) => entry.checkpointMinutes === checkpointMinutes,
  );
  const outsideApplicability =
    artifact &&
    (horizonMinutes < artifact.applicability?.minimumHorizonMinutes - 5 / 60 ||
      horizonMinutes > artifact.applicability?.maximumHorizonMinutes + 5 / 60);
  return {
    available,
    reason: available
      ? null
      : (variant?.marketReason ?? variant?.reason ?? 'market_blend_unavailable'),
    appliedMarket: available,
    rawAboveProbability: available ? rawAboveProbability : null,
    aboveProbability: available ? variant.aboveProbability : null,
    modelId: variant?.modelId ?? null,
    modelVersion: variant?.modelVersion ?? null,
    rawModelVersion:
      rawModelVersion ??
      artifact?.pipeline?.baselineModelVersion ??
      (variant?.modelId ? null : (variant?.modelVersion ?? null)),
    policyVersion: variant?.policyVersion ?? null,
    calibrationVersion: artifact?.calibration?.version ?? null,
    calibrationStatus: !artifact?.calibration
      ? 'not_calibrated'
      : outsideApplicability
        ? 'outside_applicability'
        : (checkpoint?.status ?? 'outside_checkpoint'),
    checkpointMinutes,
    trainedAt: artifact?.trainedAt ?? null,
    trainingCutoffAt: artifact?.trainingCutoffAt ?? null,
    marketProbability: available ? variant.marketProbability : null,
    marketWeight: available ? variant.marketWeight : null,
  };
}

function getRecordedMarketBlends(experiment, models, horizonMinutes) {
  const blend = experiment?.variants?.['market-blend'];
  const challenger = models?.challengers?.candidates?.find(
    (candidate) => candidate.id === blend?.modelId,
  );
  const active = models?.challengers?.active;
  const activePrediction = experiment?.activePrediction;
  const rawModelVersion = experiment?.variants?.combined?.modelVersion ?? null;
  return {
    marketBlend: getMarketBlendEvidence(blend, challenger, horizonMinutes, rawModelVersion),
    activeMarketBlend:
      active?.variantName === 'market-blend' && activePrediction?.modelId === active.id
        ? getMarketBlendEvidence(activePrediction, active, horizonMinutes, rawModelVersion)
        : null,
  };
}

/** Keep production and both frozen blend candidates attached to the same replayable inputs. */
export function createAdvisorForecast(input, models = {}, windowStartAt = null) {
  const estimate = getResearchForecast(input, models, windowStartAt);
  const researchInputSnapshot = createResearchInputSnapshot(input, models, windowStartAt, estimate);
  const quote = Object.hasOwn(input, 'kalshiQuote')
    ? input.kalshiQuote
    : getKalshiQuoteSnapshot(input.kalshiMarket, input.now);
  const horizonMinutes = (input.kalshiMarket?.expiresAt - input.now) / 60_000;
  return {
    available: estimate.available && researchInputSnapshot.timing.replayable,
    reason: estimate.reason ?? null,
    aboveProbability: estimate.aboveProbability,
    capturedAt: input.now,
    modelVersion: estimate.modelVersion,
    modelId: estimate.learning?.modelId ?? null,
    contract: getKalshiContract(input.kalshiMarket),
    marketTicker: input.kalshiMarket?.ticker ?? null,
    referencePrice: estimate.kalshi?.referencePrice ?? null,
    referenceAt: estimate.kalshi?.referenceAt ?? null,
    referenceReceivedAt: estimate.kalshi?.referenceReceivedAt ?? null,
    referenceSource: estimate.kalshi?.referenceSource ?? null,
    volatility: estimate.volatility ?? null,
    minuteVolatility:
      estimate.kalshi?.minuteVolatility ?? estimate.pressure?.components?.minuteVolatility ?? null,
    researchInputSnapshot,
    marketProbability: getKalshiMarketProbability(quote, input.kalshiMarket, input.now),
    marketQuoteReceivedAt: quote?.receivedAt ?? null,
    ...getRecordedMarketBlends(estimate.researchExperiment, models, horizonMinutes),
  };
}

function getForecastEvidence(forecast) {
  const snapshot = forecast?.researchInputSnapshot;
  const input = snapshot?.input;
  const contract = getKalshiContract(forecast?.contract ?? input?.kalshiMarket);
  const quote = input
    ? Object.hasOwn(input, 'kalshiQuote')
      ? input.kalshiQuote
      : getKalshiQuoteSnapshot(input.kalshiMarket, input.now)
    : null;
  return {
    available: forecast?.available === true,
    reason: forecast?.reason ?? null,
    aboveProbability: probability(forecast?.aboveProbability) ? forecast.aboveProbability : null,
    capturedAt: forecast?.capturedAt ?? null,
    modelVersion: forecast?.modelVersion ?? null,
    modelId: forecast?.modelId ?? null,
    contract,
    marketTicker: forecast?.marketTicker ?? contract?.ticker ?? null,
    referencePrice: forecast?.referencePrice ?? null,
    referenceAt: forecast?.referenceAt ?? null,
    referenceReceivedAt: forecast?.referenceReceivedAt ?? null,
    referenceSource: forecast?.referenceSource ?? null,
    marketProbability: Object.hasOwn(forecast ?? {}, 'marketProbability')
      ? probability(forecast.marketProbability)
        ? forecast.marketProbability
        : null
      : getKalshiMarketProbability(quote, contract, forecast?.capturedAt),
    marketQuoteReceivedAt: forecast?.marketQuoteReceivedAt ?? quote?.receivedAt ?? null,
  };
}

/** Record disagreement without changing the approved production or entry policy. */
export function getAdvisorForecastReconciliation({
  contract,
  originalForecast,
  currentForecast,
  book,
  now,
}) {
  const quote = getAdvisorBookQuote({ contract, book, now });
  const original = getForecastEvidence(originalForecast);
  const current = getForecastEvidence(currentForecast);
  const snapshot = currentForecast?.researchInputSnapshot;
  const experiment = snapshot?.expectedExperiment;
  const snapshotMatches = Boolean(
    snapshot?.version === RESEARCH_INPUT_SNAPSHOT_VERSION &&
    snapshot.timing?.replayable === true &&
    snapshot.capturedAt === now &&
    snapshot.input?.now === now &&
    current.capturedAt === now &&
    isSameKalshiContract(snapshot.input?.kalshiMarket, contract) &&
    isSameKalshiContract(current.contract, contract) &&
    experiment?.capturedAt === now &&
    experiment.marketTicker === contract.ticker &&
    experiment.target === contract.target &&
    experiment.expiresAt === contract.expiresAt &&
    experiment.production?.aboveProbability === current.aboveProbability &&
    (experiment.production?.modelId ?? null) === current.modelId &&
    experiment.production?.modelVersion === current.modelVersion,
  );
  const sameExecutionBook = Boolean(
    quote &&
    snapshotMatches &&
    Object.entries(quote).every(([key, value]) => snapshot.input.kalshiQuote?.[key] === value),
  );
  const reason = !quote
    ? 'execution_book_unavailable'
    : !snapshotMatches
      ? 'current_input_snapshot_unavailable'
      : !sameExecutionBook
        ? 'execution_book_not_used_in_forecast'
        : !current.available || !probability(current.aboveProbability)
          ? (current.reason ?? 'current_forecast_unavailable')
          : null;
  const executionBookProbability = getKalshiMarketProbability(quote, contract, now);
  const gaps = {
    originalForecastToExecutionBook: difference(
      original.aboveProbability,
      executionBookProbability,
    ),
    currentForecastToExecutionBook:
      reason === null ? difference(current.aboveProbability, executionBookProbability) : null,
    researchMarketToExecutionBook: difference(original.marketProbability, executionBookProbability),
    forecastChange:
      reason === null ? difference(current.aboveProbability, original.aboveProbability) : null,
  };
  const unavailableBlend = {
    ...getMarketBlendEvidence(null),
    reason: reason ?? 'market_blend_unavailable',
  };
  const recordedBlends =
    reason === null
      ? getRecordedMarketBlends(experiment, snapshot.models, (contract.expiresAt - now) / 60_000)
      : { marketBlend: unavailableBlend, activeMarketBlend: null };
  return {
    version: ADVISOR_FORECAST_RECONCILIATION_VERSION,
    mode: 'shadow-only',
    observedAt: now,
    contract: getKalshiContract(contract),
    originalForecast: original,
    currentForecast: current,
    recomputed: reason === null,
    sameExecutionBook,
    reason,
    executionBookProbability,
    executionBookRequestedAt: book?.requestedAt ?? null,
    executionBookReceivedAt: book?.receivedAt ?? null,
    originalResearchMarketProbability: original.marketProbability,
    originalResearchMarketQuoteReceivedAt: original.marketQuoteReceivedAt,
    gaps,
    disagreementThreshold: ADVISOR_FORECAST_DISAGREEMENT_THRESHOLD,
    largeDisagreement: [
      gaps.originalForecastToExecutionBook,
      gaps.currentForecastToExecutionBook,
      gaps.researchMarketToExecutionBook,
    ].some((gap) => gap !== null && Math.abs(gap) >= ADVISOR_FORECAST_DISAGREEMENT_THRESHOLD),
    ...recordedBlends,
  };
}
