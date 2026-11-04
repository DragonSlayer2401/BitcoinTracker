import { useCallback } from 'react';
import { getKalshiQuoteSnapshot } from '@/features/MarketData/utils/kalshi/marketQuote.utils';
import {
  getKalshiMarketConditions,
  hasIndependentKalshiBenchmark,
} from '@/features/Forecasting/features/LiveEstimates/utils/kalshi/marketConditions.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { createResearchInputSnapshot } from '../utils/researchExperiments.utils';

const useResearchEstimates = ({ marketData, models }) => {
  const { candles, ticker, stream, derivatives, benchmark, kalshiMarkets, hasRequestError } =
    marketData;
  const getResearchEstimate = useCallback(
    ({
      target: forecastTarget,
      now: evaluatedAt,
      expiresAt,
      kalshiMarket: contract,
      kalshiQuote,
      benchmark: capturedBenchmark,
      captureResearchInputs = false,
    }) => {
      const input = {
        candles,
        ticker,
        stream,
        derivatives,
        target: forecastTarget,
        now: evaluatedAt,
        expiresAt,
        horizonMinutes: (expiresAt - evaluatedAt) / 60_000,
        kalshiMarket: contract,
        kalshiQuote:
          kalshiQuote === undefined
            ? getKalshiQuoteSnapshot(
                kalshiMarkets.find((market) => market.ticker === contract?.ticker),
                evaluatedAt,
              )
            : kalshiQuote,
        benchmark: capturedBenchmark ?? benchmark,
      };
      const result = getResearchForecast(input, models, expiresAt - 900_000);
      if (captureResearchInputs) {
        result.researchInputSnapshot = createResearchInputSnapshot(
          input,
          models,
          expiresAt - 900_000,
          result,
        );
      }
      return hasRequestError && !hasIndependentKalshiBenchmark(result)
        ? { ...result, available: false, aboveProbability: null, belowProbability: null }
        : result;
    },
    [candles, ticker, stream, derivatives, models, hasRequestError, benchmark, kalshiMarkets],
  );
  const getResearchConditions = useCallback(
    ({ target: forecastTarget, now: evaluatedAt, expiresAt, forecast: estimate }) =>
      getKalshiMarketConditions({
        candles,
        ticker,
        target: forecastTarget,
        now: evaluatedAt,
        horizonMinutes: (expiresAt - evaluatedAt) / 60_000,
        forecast: estimate,
      }),
    [candles, ticker],
  );

  return { getResearchEstimate, getResearchConditions };
};

export default useResearchEstimates;
