import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const kalshiApi = createApi({
  reducerPath: 'kalshiApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/api/kalshi/', timeout: 20_000 }),
  endpoints: (builder) => ({
    getKalshiMarkets: builder.query({
      query: () => ({ url: 'markets', cache: 'no-store' }),
    }),
    getKalshiMarket: builder.query({
      query: (ticker) => ({ url: `markets/${encodeURIComponent(ticker)}`, cache: 'no-store' }),
    }),
    getKalshiBenchmark: builder.query({
      query: (expiresAt) => ({
        url: 'benchmark',
        params: expiresAt ? { expiresAt } : undefined,
        cache: 'no-store',
      }),
    }),
  }),
});

export const { useGetKalshiMarketsQuery, useGetKalshiMarketQuery, useGetKalshiBenchmarkQuery } =
  kalshiApi;
