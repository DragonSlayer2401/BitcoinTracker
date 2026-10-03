import { researchApi } from '../research.api';

const paperTradingApi = researchApi.injectEndpoints({
  endpoints: (builder) => ({
    getPaperTradingReport: builder.query({
      query: () => ({ url: 'paper-trading', cache: 'no-store' }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const { useGetPaperTradingReportQuery } = paperTradingApi;
