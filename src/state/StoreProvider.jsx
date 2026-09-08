'use client';

import { useEffect, useRef } from 'react';
import { Provider } from 'react-redux';
import { setupListeners } from '@reduxjs/toolkit/query';
import { makeStore } from './store';

export default function StoreProvider({ children }) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = makeStore();

  useEffect(() => setupListeners(storeRef.current.dispatch), []);

  return <Provider store={storeRef.current}>{children}</Provider>;
}
