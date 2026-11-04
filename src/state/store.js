import { configureStore } from '@reduxjs/toolkit';
import { coinbaseApi } from '@/services/coinbase/coinbase.api';
import forecastReducer from '@/features/Forecasting/state/slices/forecastSlice';
import { researchApi } from '@/services/research/research.api';
import { kalshiApi } from '@/services/kalshi/kalshi.api';

export function makeStore() {
  return configureStore({
    reducer: {
      tracker: forecastReducer,
      [coinbaseApi.reducerPath]: coinbaseApi.reducer,
      [researchApi.reducerPath]: researchApi.reducer,
      [kalshiApi.reducerPath]: kalshiApi.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(
        coinbaseApi.middleware,
        researchApi.middleware,
        kalshiApi.middleware,
      ),
  });
}
