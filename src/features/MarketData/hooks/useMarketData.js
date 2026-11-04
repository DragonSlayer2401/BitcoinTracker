import { useMemo } from 'react';
import { useGetKalshiBenchmarkQuery, useGetKalshiMarketsQuery } from '@/services/kalshi/kalshi.api';
import useCoinbaseMarketData from '../features/MarketFeeds/hooks/useCoinbaseMarketData';
import useDerivativesMarketData from '../features/MarketFeeds/hooks/useDerivativesMarketData';
import { getBenchmarkChartData } from '../utils/benchmarkChart.utils';

const EMPTY_MARKETS = [];

const useMarketData = ({ now, preferredTicker }) => {
  const marketsQuery = useGetKalshiMarketsQuery(undefined, {
    pollingInterval: 15_000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const kalshiMarkets = marketsQuery.data?.markets ?? EMPTY_MARKETS;
  const currentMarket =
    kalshiMarkets.find((market) => market.startsAt <= now && market.expiresAt > now) ?? null;
  const selectedMarket =
    kalshiMarkets.find((market) => market.ticker === preferredTicker && market.expiresAt > now) ??
    currentMarket ??
    kalshiMarkets.find((market) => market.expiresAt > now) ??
    null;
  const benchmarkQuery = useGetKalshiBenchmarkQuery(selectedMarket?.expiresAt, {
    skip: !selectedMarket,
    pollingInterval: 2000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const benchmark = benchmarkQuery.data;
  const benchmarkData = useMemo(() => getBenchmarkChartData(benchmark, now), [benchmark, now]);
  const coinbase = useCoinbaseMarketData(now);
  const derivatives = useDerivativesMarketData();

  return {
    ...coinbase,
    derivatives,
    kalshiMarkets,
    currentMarket,
    selectedMarket,
    hasContractError: marketsQuery.isError,
    benchmark,
    benchmarkData,
  };
};

export default useMarketData;
