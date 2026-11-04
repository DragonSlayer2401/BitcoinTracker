'use client';

import { useMemo } from 'react';
import BitcoinPriceSummary from './features/MarketFeeds/components/BitcoinPriceSummary';
import PriceChart from './features/PriceChart/PriceChart';
import { getCoinbaseChartData } from './features/PriceChart/utils/coinbaseChart.utils';

/** Reuse the existing Coinbase feed; chart controls never request extra market data. */
const MarketData = ({ marketData, now }) => {
  const { benchmarkData, candles, ticker, isQuoteFresh, hasQuoteError, currentMarket } = marketData;
  const { chartData, evaluatedAt } = useMemo(() => {
    // A socket update can arrive between clock ticks; evaluate it against the actual current time.
    const evaluatedAt = Number.isFinite(now) && now > 0 ? Math.max(now, Date.now()) : now;
    return {
      chartData: getCoinbaseChartData({
        candles,
        ticker,
        now: evaluatedAt,
        isQuoteFresh: isQuoteFresh && !hasQuoteError,
      }),
      evaluatedAt,
    };
  }, [candles, ticker, now, isQuoteFresh, hasQuoteError]);
  return (
    <>
      <BitcoinPriceSummary benchmarkData={benchmarkData} compact />
      <PriceChart
        chartData={chartData}
        target={currentMarket?.target ?? null}
        deadline={currentMarket?.expiresAt ?? null}
        now={evaluatedAt}
      />
    </>
  );
};

export default MarketData;
