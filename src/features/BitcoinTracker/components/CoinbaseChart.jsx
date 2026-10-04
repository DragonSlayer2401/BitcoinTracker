'use client';

import { useMemo } from 'react';
import { getCoinbaseChartData } from '../utils/coinbaseChart.utils';
import PriceChart from './PriceChart';

/** Reuse the existing Coinbase feed; chart controls never request extra market data. */
export default function CoinbaseChart({ candles, ticker, now, isQuoteFresh, target, deadline }) {
  const { chartData, evaluatedAt } = useMemo(() => {
    // A socket update can arrive between clock ticks; evaluate it against the actual current time.
    const evaluatedAt = Number.isFinite(now) && now > 0 ? Math.max(now, Date.now()) : now;
    return {
      chartData: getCoinbaseChartData({ candles, ticker, now: evaluatedAt, isQuoteFresh }),
      evaluatedAt,
    };
  }, [candles, ticker, now, isQuoteFresh]);
  return <PriceChart chartData={chartData} target={target} deadline={deadline} now={evaluatedAt} />;
}
