import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const coinbaseApi = createApi({
  reducerPath: 'coinbaseApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/api/market/', timeout: 10_000 }),
  endpoints: (builder) => ({
    getTicker: builder.query({
      query: () => ({ url: 'ticker', cache: 'no-store' }),
    }),
    getCandles: builder.query({
      query: () => ({ url: 'candles', cache: 'no-store' }),
    }),
  }),
});

export const { useGetTickerQuery, useGetCandlesQuery } = coinbaseApi;
