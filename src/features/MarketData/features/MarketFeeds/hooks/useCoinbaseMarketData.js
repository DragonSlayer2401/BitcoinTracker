import { useGetCandlesQuery, useGetTickerQuery } from '@/services/coinbase/coinbase.api';
import useCoinbaseStream from './useCoinbaseStream';

const EMPTY_CANDLES = [];
const STREAM_FALLBACK_DELAY_MS = 5000;
const MAXIMUM_QUOTE_AGE_MS = 20_000;
const ALLOWED_CLOCK_SKEW_MS = 5000;
const CANDLE_DURATION_MS = 60_000;
const MAXIMUM_HISTORY_AGE_MS = 120_000;

function getFeedStatusLabel({ isFeedFresh, isLoading, isQuoteFresh, hasTickerRequestError }) {
  if (isFeedFresh) return 'Live market data';
  if (isLoading) return 'Connecting to market';
  if (isQuoteFresh && !hasTickerRequestError) return 'Price live · history delayed';
  return 'Market data delayed';
}

/** Own Coinbase subscriptions, stream fallback, and the freshness of the displayed feed. */
export default function useCoinbaseMarketData(now) {
  const stream = useCoinbaseStream();
  const quoteQuery = useGetTickerQuery(undefined, {
    pollingInterval: 5000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const candleQuery = useGetCandlesQuery(undefined, {
    pollingInterval: CANDLE_DURATION_MS,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });

  // REST keeps estimates available while the execution stream reconnects or gathers history.
  const hasStreamTicker = Boolean(
    stream.ticker && now - stream.ticker.receivedAt <= STREAM_FALLBACK_DELAY_MS,
  );
  const ticker = hasStreamTicker ? stream.ticker : quoteQuery.data;
  const candles = candleQuery.data || EMPTY_CANDLES;
  const quoteAge = ticker && now ? now - ticker.time : null;
  const isQuoteFresh =
    quoteAge !== null &&
    quoteAge <= MAXIMUM_QUOTE_AGE_MS &&
    quoteAge >= -ALLOWED_CLOCK_SKEW_MS &&
    now - ticker.receivedAt <= MAXIMUM_QUOTE_AGE_MS &&
    now - ticker.receivedAt >= -ALLOWED_CLOCK_SKEW_MS;
  const hasQuoteError = !hasStreamTicker && quoteQuery.isError;
  const hasRequestError = hasQuoteError || candleQuery.isError;
  const isLoading = (!hasStreamTicker && quoteQuery.isLoading) || candleQuery.isLoading;

  // A forming candle cannot establish completed history or the approximate 15-minute change.
  const completedCandles = candles.filter(
    (candle) => now && candle.time + CANDLE_DURATION_MS <= now,
  );
  const lastCandleTime = completedCandles.at(-1)?.time;
  const historyAge = Number.isFinite(lastCandleTime)
    ? now - (lastCandleTime + CANDLE_DURATION_MS)
    : null;
  const isHistoryFresh =
    historyAge !== null && historyAge <= MAXIMUM_HISTORY_AGE_MS && !candleQuery.isError;
  const isFeedFresh = isQuoteFresh && !hasQuoteError && isHistoryFresh;
  const priorPrice = completedCandles.at(-16)?.close;
  const priceChange = priorPrice && ticker ? ticker.price / priorPrice - 1 : null;

  const refreshMarketData = () => {
    quoteQuery.refetch();
    candleQuery.refetch();
  };

  return {
    stream,
    ticker,
    candles,
    quoteAge,
    historyAge,
    priceChange,
    hasStreamTicker,
    isQuoteFresh,
    isFeedFresh,
    hasQuoteError,
    hasRequestError,
    isLoading,
    isRefreshing: quoteQuery.isFetching || candleQuery.isFetching,
    feedStatusLabel: getFeedStatusLabel({
      isFeedFresh,
      isLoading,
      isQuoteFresh,
      hasTickerRequestError: quoteQuery.isError,
    }),
    refreshMarketData,
  };
}
