import { configureStore } from '@reduxjs/toolkit';
import { coinbaseApi } from '@/services/coinbase/coinbase.api';
import trackerReducer from '@/features/BitcoinTracker/state/slices/trackerSlice';

export function makeStore() {
  return configureStore({
    reducer: {
      tracker: trackerReducer,
      [coinbaseApi.reducerPath]: coinbaseApi.reducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(coinbaseApi.middleware),
  });
}
