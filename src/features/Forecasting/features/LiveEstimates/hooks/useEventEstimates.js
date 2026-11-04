import { useMemo } from 'react';
import useLiveKalshiForecast from './useLiveKalshiForecast';
import { getKalshiMarketConditions } from '../utils/kalshi/marketConditions.utils';

const useEventEstimates = ({ now, marketData, selection, research }) => {
  const { recordedForecast, forecasts } = selection;
  const {
    kalshiMarkets,
    selectedMarket,
    hasRequestError,
    candles,
    ticker,
    stream,
    derivatives,
    benchmark,
    hasContractError,
  } = marketData;
  const { models, getResearchEstimate, getResearchConditions } = research;
  const kalshiMarket = recordedForecast?.kalshiMarket
    ? (kalshiMarkets.find((market) => market.ticker === recordedForecast.kalshiMarket.ticker) ??
      recordedForecast.kalshiMarket)
    : selectedMarket;
  const forecastDeadline = kalshiMarket?.expiresAt ?? null;
  const eventForecasts = forecasts.filter(
    (entry) => entry.kalshiMarket?.ticker === kalshiMarket?.ticker,
  );
  const riskForecast =
    [...eventForecasts]
      .filter((entry) => Number.isFinite(entry.aboveProbability))
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? recordedForecast;
  const horizonMinutes =
    forecastDeadline === null ? 15 : Math.min(15, (forecastDeadline - now) / 60_000);
  const target = kalshiMarket?.target ?? NaN;
  // Live estimates can move; observation and reversal risk remain tied to the saved contract.
  const forecast = useLiveKalshiForecast({
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
  });
  const savedRiskEstimate = useMemo(
    () =>
      riskForecast && now
        ? getResearchEstimate({
            target: riskForecast.target,
            expiresAt: riskForecast.expiresAt,
            now: Date.now(),
            kalshiMarket: riskForecast.kalshiMarket,
          })
        : null,
    [riskForecast, now, getResearchEstimate],
  );
  const savedRiskConditions = useMemo(
    () =>
      riskForecast && now
        ? getResearchConditions({
            target: riskForecast.target,
            expiresAt: riskForecast.expiresAt,
            now: Date.now(),
            forecast: savedRiskEstimate,
          })
        : null,
    [riskForecast, now, getResearchConditions, savedRiskEstimate],
  );
  const marketConditions = useMemo(
    () =>
      getKalshiMarketConditions({
        candles,
        ticker,
        target,
        now: now ? Date.now() : now,
        horizonMinutes,
        forecast,
      }),
    [candles, ticker, target, now, horizonMinutes, forecast],
  );
  return {
    kalshiMarket,
    forecastDeadline,
    eventForecasts,
    riskForecast,
    forecast,
    savedRiskEstimate,
    savedRiskConditions,
    marketConditions,
  };
};
export default useEventEstimates;
