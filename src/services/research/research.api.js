import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const researchApi = createApi({
  reducerPath: 'researchApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/api/research/', timeout: 15_000 }),
  endpoints: (builder) => ({
    getResearchModels: builder.query({ query: () => ({ url: 'models', cache: 'no-store' }) }),
  }),
});

export const { useGetResearchModelsQuery } = researchApi;
