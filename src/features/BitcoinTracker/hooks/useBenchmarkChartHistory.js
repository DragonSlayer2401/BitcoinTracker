import { useMemo } from 'react';
import { useGetBenchmarkHistoryQuery } from '@/services/kalshi/benchmarkHistory/benchmarkHistory.api';
import { mergeBenchmarkChartHistory } from '../utils/benchmarkChart.utils';

const HOUR = 3_600_000;

/** Load older chart readings on demand; the live forecast keeps its own original inputs. */
export default function useBenchmarkChartHistory(benchmarkData, windowMinutes, now) {
  const needsHistory = [120, 240].includes(windowMinutes) && Number.isSafeInteger(now) && now > 0;
  const endingAt = needsHistory ? Math.floor(now / HOUR) * HOUR : 0;
  const history = useGetBenchmarkHistoryQuery(
    { hours: windowMinutes / 60, endingAt },
    {
      skip: !needsHistory,
      pollingInterval: 60_000,
      refetchOnMountOrArgChange: 60,
      refetchOnReconnect: true,
    },
  );
  // currentData prevents a previous range's response from appearing under a new range label.
  const chartData = useMemo(
    () =>
      needsHistory
        ? mergeBenchmarkChartHistory(benchmarkData, history.currentData, now, windowMinutes)
        : benchmarkData,
    [benchmarkData, history.currentData, needsHistory, now, windowMinutes],
  );
  const hasHistoryError =
    needsHistory &&
    (history.isError || ['partial', 'unavailable'].includes(history.currentData?.status));
  const notice = !needsHistory
    ? null
    : hasHistoryError
      ? history.currentData?.reason ||
        'Older BRTI history is unavailable. Existing readings remain visible.'
      : history.isFetching
        ? 'Loading older BRTI history…'
        : null;

  return {
    chartData,
    notice,
    canRetry: hasHistoryError && !history.isFetching,
    retry: history.refetch,
  };
}
