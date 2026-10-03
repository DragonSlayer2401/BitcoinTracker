import { researchApi } from '../research.api';

const tradingAdvisorApi = researchApi.injectEndpoints({
  endpoints: (builder) => ({
    getTradingAdvisorReport: builder.query({
      query: () => ({ url: 'trading-advisor', cache: 'no-store' }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const { useGetTradingAdvisorReportQuery } = tradingAdvisorApi;
