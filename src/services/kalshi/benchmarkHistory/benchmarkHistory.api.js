import { kalshiApi } from '../kalshi.api';

const benchmarkHistoryApi = kalshiApi.injectEndpoints({
  endpoints: (builder) => ({
    getBenchmarkHistory: builder.query({
      query: ({ hours, endingAt }) => ({
        url: 'benchmark/history',
        params: { hours, endingAt },
        cache: 'no-store',
        // Four sequential hourly reads can outlast the default live-request timeout.
        timeout: 45_000,
      }),
      keepUnusedDataFor: 3600,
    }),
  }),
});

export const { useGetBenchmarkHistoryQuery } = benchmarkHistoryApi;
