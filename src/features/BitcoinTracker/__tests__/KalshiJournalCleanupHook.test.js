import { createElement, StrictMode } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import useForecastJournal from '../hooks/useForecastJournal';
import reducer from '../state/slices/trackerSlice';
import { cleanupLegacyBrowserResearch } from '../utils/kalshi/browserCleanup.utils';

jest.mock('../utils/kalshi/browserCleanup.utils', () => ({
  cleanupLegacyBrowserResearch: jest.fn(),
}));

function view(preloadedState) {
  const store = configureStore({ reducer: { tracker: reducer }, preloadedState });
  const wrapper = ({ children }) =>
    createElement(StrictMode, null, createElement(Provider, { store }, children));
  return { store, ...renderHook(() => useForecastJournal(), { wrapper }) };
}

describe('cleanup gates journal readiness and upload startup', () => {
  beforeEach(() => {
    window.localStorage.clear();
    cleanupLegacyBrowserResearch.mockReset();
  });

  test('stays unready until cleanup completes, reusing one operation under StrictMode', async () => {
    let resolve;
    cleanupLegacyBrowserResearch.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const hook = view();
    expect(hook.result.current).toBe(false);
    expect(cleanupLegacyBrowserResearch).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('bitcoin-tracker:journal:v1')).toBeNull();
    await act(async () => {
      resolve({ forecasts: [], scheduledForecast: null });
    });
    expect(hook.result.current).toBe(true);
    expect(hook.store.getState().tracker.storageWarning).toBeNull();
  });

  test('failed cleanup pauses recording and uploads and leaves the journal untouched', async () => {
    const original = '{ unreadable existing journal';
    window.localStorage.setItem('bitcoin-tracker:journal:v1', original);
    cleanupLegacyBrowserResearch.mockRejectedValue(new Error('IndexedDB blocked'));
    const hook = view();
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current).toBe(false);
    expect(hook.store.getState().tracker.storageWarning).toMatch(
      /IndexedDB blocked.*uploads are paused.*Reload to retry/,
    );
    expect(window.localStorage.getItem('bitcoin-tracker:journal:v1')).toBe(original);
  });

  test('an already-open tab cannot requeue old Redux forecasts after storage cleanup', async () => {
    cleanupLegacyBrowserResearch.mockResolvedValue({ forecasts: [], scheduledForecast: null });
    const hook = view({
      tracker: {
        forecasts: [{ id: 'old', status: 'pending' }],
        scheduledForecast: null,
        storageWarning: null,
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current).toBe(false);
    expect(hook.store.getState().tracker.storageWarning).toMatch(
      /Old forecast state.*uploads are paused/,
    );
    expect(window.localStorage.getItem('bitcoin-tracker:journal:v1')).toBeNull();
  });
});
