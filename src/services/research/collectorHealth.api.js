import { researchApi } from './research.api';

const collectorHealthApi = researchApi.injectEndpoints({
  endpoints: (builder) => ({
    getCollectorHealth: builder.query({
      query: () => ({ url: 'collector-health', cache: 'no-store' }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const { useGetCollectorHealthQuery } = collectorHealthApi;
