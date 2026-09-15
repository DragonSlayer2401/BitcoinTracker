import { createElement, StrictMode } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import useForecastJournal from '../hooks/useForecastJournal';
import reducer, { forecastBatchRecorded } from '../state/slices/trackerSlice';
import { cleanupLegacyBrowserResearch } from '../utils/kalshi/browserCleanup.utils';
import { createKalshiForecastBatch } from '../utils/kalshi/forecastBatch.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { JOURNAL_STORAGE_KEY, loadJournal } from '../utils/journal.utils';

jest.mock('../utils/kalshi/browserCleanup.utils', () => ({
  cleanupLegacyBrowserResearch: jest.fn(),
}));

// Model Web Locks' queue and automatic release after each callback settles.
function installLocks() {
  let queue = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn((name, options, callback) => {
        const request = queue
          .catch(() => {})
          .then(() => {
            if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            return callback({ name });
          });
        queue = request;
        return request;
      }),
    },
  });
}
function view(preloadedState) {
  const store = configureStore({ reducer: { tracker: reducer }, preloadedState });
  const wrapper = ({ children }) =>
    createElement(StrictMode, null, createElement(Provider, { store }, children));
  return { store, ...renderHook(() => useForecastJournal(), { wrapper }) };
}
const START = Date.UTC(2026, 8, 10, 12, 15);
const contract = {
  ticker: 'KXBTC15M-26SEP100830-30',
  eventTicker: 'KXBTC15M-26SEP100830',
  seriesTicker: 'KXBTC15M',
  target: 77125.62,
  startsAt: START,
  expiresAt: START + 900000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
const makeBatch = () =>
  createKalshiForecastBatch({
    id: 'test',
    contract,
    createdAt: START,
    price: 77200,
    checkpointMinutes: [9, 6],
  });

describe('journal recording ownership and durability', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installLocks();
    cleanupLegacyBrowserResearch.mockReset();
    cleanupLegacyBrowserResearch.mockImplementation(async () => {
      const { forecasts, scheduledForecast } = loadJournal();
      return { forecasts, scheduledForecast };
    });
  });
  afterEach(() => {
    cleanup();
    delete navigator.locks;
    jest.restoreAllMocks();
  });

  test('waits for cleanup once under StrictMode before enabling recording', async () => {
    let resolve;
    cleanupLegacyBrowserResearch.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const hook = view();
    expect(hook.result.current.isReady).toBe(false);
    await act(async () => {});
    expect(cleanupLegacyBrowserResearch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBeNull();
    await act(async () => {
      resolve({ forecasts: [], scheduledForecast: null });
    });
    expect(hook.result.current).toEqual({ isRestored: true, isOwner: true, isReady: true });
  });
  test('failed cleanup preserves existing storage and pauses uploads', async () => {
    const original = '{ unreadable existing journal';
    localStorage.setItem(JOURNAL_STORAGE_KEY, original);
    cleanupLegacyBrowserResearch.mockRejectedValue(new Error('IndexedDB blocked'));
    const hook = view();
    await act(async () => {});
    expect(hook.result.current.isReady).toBe(false);
    expect(hook.store.getState().tracker.storageWarning).toMatch(
      /IndexedDB blocked.*Recording paused/,
    );
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(original);
  });
  test('old Redux records cannot be requeued after storage cleanup', async () => {
    const hook = view({
      tracker: {
        forecasts: [{ id: 'old', status: 'pending' }],
        scheduledForecast: null,
        storageWarning: null,
      },
    });
    await act(async () => {});
    expect(hook.result.current.isReady).toBe(false);
    expect(hook.store.getState().tracker.storageWarning).toMatch(
      /Old forecast state.*uploads are paused/,
    );
  });
  test('only one tab records; another adopts saved calls and takes over when it closes', async () => {
    const owner = view();
    await act(async () => {});
    const follower = view();
    await act(async () => {});
    expect(owner.result.current.isReady).toBe(true);
    expect(follower.result.current.isReady).toBe(false);
    const batch = makeBatch();
    act(() => {
      owner.store.dispatch(forecastBatchRecorded(batch));
      // Saving finishes inside dispatch, before a React persistence effect could run.
      expect(loadJournal().forecasts).toEqual(batch);
      window.dispatchEvent(new StorageEvent('storage', { key: JOURNAL_STORAGE_KEY }));
    });
    expect(follower.store.getState().tracker.forecasts).toEqual(batch);
    await act(async () => owner.unmount());
    expect(follower.result.current.isReady).toBe(true);
    expect(follower.store.getState().tracker.forecasts).toEqual(batch);
  });
  test('storage failure pauses further recording', async () => {
    const hook = view();
    await act(async () => {});
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    act(() => hook.store.dispatch(forecastBatchRecorded(makeBatch())));
    expect(hook.result.current.isReady).toBe(false);
    expect(hook.store.getState().tracker.storageWarning).toMatch(/Recording paused/);
  });
  test('unavailable cross-tab locks disable recording without replacing history', async () => {
    delete navigator.locks;
    const hook = view();
    await act(async () => {});
    expect(hook.result.current.isReady).toBe(false);
    expect(hook.store.getState().tracker.storageWarning).toMatch(/Web Locks/);
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBeNull();
  });
});
