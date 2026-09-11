import { configureStore } from '@reduxjs/toolkit';
import { coinbaseApi } from '@/services/coinbase/coinbase.api';
import trackerReducer from '@/features/BitcoinTracker/state/slices/trackerSlice';
import { researchApi } from '@/services/research/research.api';
import { kalshiApi } from '@/services/kalshi/kalshi.api';

export function makeStore() {
  return configureStore({
    reducer: {
      tracker: trackerReducer,
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
