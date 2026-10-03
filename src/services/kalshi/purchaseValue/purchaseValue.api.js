import { kalshiApi } from '../kalshi.api';

const purchaseValueApi = kalshiApi.injectEndpoints({
  endpoints: (builder) => ({
    getKalshiPurchaseValue: builder.query({
      query: (ticker) => ({
        url: `markets/${encodeURIComponent(ticker)}/purchase-value`,
        cache: 'no-store',
      }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const { useGetKalshiPurchaseValueQuery } = purchaseValueApi;
