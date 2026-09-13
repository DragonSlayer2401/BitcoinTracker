import { useMemo } from 'react';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { getKalshiContract } from '../utils/kalshi/contract.utils';
import { hasIndependentKalshiBenchmark } from '../utils/kalshi/marketConditions.utils';

function getUnavailableForecast(estimate, reason) {
  return {
    ...estimate,
    available: false,
    aboveProbability: null,
    belowProbability: null,
    direction: null,
    reason,
  };
}

/** Recalculate the selected contract's live estimate without changing any saved call. */
export default function useLiveKalshiForecast({
  candles,
  ticker,
  target,
  now,
  stream,
  derivatives,
  models,
  kalshiMarket,
  benchmark,
  forecastDeadline,
  hasRequestError,
  hasContractError,
}) {
  return useMemo(() => {
    const evaluatedAt = now ? Date.now() : now;
    const estimate = getResearchForecast(
      {
        candles,
        ticker,
        target,
        now: evaluatedAt,
        stream,
        derivatives,
        kalshiMarket,
        benchmark,
        expiresAt: forecastDeadline ?? undefined,
        horizonMinutes:
          forecastDeadline === null ? 15 : Math.min(15, (forecastDeadline - evaluatedAt) / 60_000),
      },
      models,
    );

    if (!getKalshiContract(kalshiMarket) || hasContractError) {
      const reason =
        kalshiMarket?.target == null
          ? 'Waiting for Kalshi’s official target.'
          : 'Kalshi contract details could not be verified.';
      return getUnavailableForecast(estimate, reason);
    }

    // Complete BRTI inputs allow estimates to continue through a Coinbase outage.
    if (hasRequestError && !hasIndependentKalshiBenchmark(estimate)) {
      return getUnavailableForecast(
        estimate,
        'The market feed could not be refreshed. Retrying automatically.',
      );
    }

    return estimate;
  }, [
    candles,
    ticker,
    target,
    now,
    hasRequestError,
    forecastDeadline,
    stream,
    derivatives,
    models,
    kalshiMarket,
    benchmark,
    hasContractError,
  ]);
}
