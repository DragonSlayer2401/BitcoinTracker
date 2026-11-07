import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { deserialize, serialize } from 'node:v8';
import { Provider, useSelector } from 'react-redux';
import ForecastJournal from '../../ForecastJournal';
import useForecastJournal from '../../hooks/useForecastJournal';
import useForecastOutcomes from '../../hooks/useForecastOutcomes';
import { JOURNAL_STORAGE_KEY } from '../../utils/journal.utils';
import forecastReducer from '@/features/Forecasting/state/slices/forecastSlice';
import {
  selectForecasts,
  selectStorageWarning,
} from '@/features/Forecasting/state/selectors/forecastSelectors';
import { fetchKalshiMarketClient } from '@/services/kalshi/kalshi.client.service';
import { journalNow } from './journalFixtures';

jest.mock('@/services/kalshi/kalshi.client.service', () => ({
  fetchKalshiMarketClient: jest.fn(),
}));

let clock;
let settlementResponses;
export const setSettlementResponse = (market, requestedTicker = market.ticker) =>
  settlementResponses.set(requestedTicker, market);
export const setSettlementFailure = (ticker, error = new Error('Official results are delayed.')) =>
  settlementResponses.set(ticker, error);

export const setupJournalTests = () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const originalClone = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
  beforeEach(() => {
    localStorage.clear();
    clock = jest.spyOn(Date, 'now').mockReturnValue(journalNow);
    // A new in-memory browser database per test also isolates legacy cleanup.
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    if (!globalThis.structuredClone)
      Object.defineProperty(globalThis, 'structuredClone', {
        configurable: true,
        value: (value) => deserialize(serialize(value)),
      });
    settlementResponses = new Map();
    fetchKalshiMarketClient.mockReset().mockImplementation(async (ticker) => {
      const response = settlementResponses.get(ticker);
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Official result is not available yet.');
      return response;
    });
  });
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    localStorage.clear();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
    if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
    else delete globalThis.indexedDB;
    if (originalClone) Object.defineProperty(globalThis, 'structuredClone', originalClone);
    else delete globalThis.structuredClone;
  });
};

export const saveBrowserJournal = ({ forecasts = [], scheduledForecast = null }) => {
  localStorage.setItem(
    JOURNAL_STORAGE_KEY,
    JSON.stringify({ version: 7, forecasts, scheduledForecast }),
  );
};

// These lifecycle hooks live above the research dialog in TradingDashboard. Keep
// them running with the real journal entry point and the dashboard's visible warnings.
const JournalWorkflow = ({ now, onState }) => {
  const journal = useForecastJournal();
  const forecasts = useSelector(selectForecasts);
  const storageWarning = useSelector(selectStorageWarning);
  const settlement = useForecastOutcomes({ forecasts, now, isReady: journal.isReady });
  onState({ ...journal, storageWarning });
  return (
    <>
      {storageWarning && <p role="alert">{storageWarning}</p>}
      {settlement.warning && <p role="alert">{settlement.warning}</p>}
      <ForecastJournal now={now} isJournalReady={journal.isReady} />
    </>
  );
};

export const renderForecastJournal = async ({
  forecasts,
  scheduledForecast = null,
  now = journalNow,
  lock = 'owner',
  serializedJournal,
} = {}) => {
  if (serializedJournal !== undefined) localStorage.setItem(JOURNAL_STORAGE_KEY, serializedJournal);
  else if (forecasts !== undefined || scheduledForecast)
    saveBrowserJournal({ forecasts, scheduledForecast });
  let grantLock;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value:
      lock === 'unsupported'
        ? undefined
        : {
            request: jest.fn(async (_name, { signal }, callback) => {
              if (lock === 'failed') throw new Error('Browser lock is unavailable.');
              if (lock === 'owner') return await callback();
              await new Promise((resolve, reject) => {
                grantLock = () => {
                  lock = 'owner';
                  resolve(callback());
                };
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('Aborted', 'AbortError')),
                  { once: true },
                );
              });
            }),
          },
  });
  let currentTime = now;
  let store;
  let view;
  let journalState;
  const user = userEvent.setup();
  const renderWorkflow = () => (
    <Provider store={store}>
      <JournalWorkflow now={currentTime} onState={(state) => (journalState = state)} />
    </Provider>
  );
  const waitForJournal = async () => {
    await waitFor(() => {
      if (lock === 'owner')
        expect(
          journalState.isReady || (journalState.isRestored && journalState.storageWarning),
        ).toBeTruthy();
      else expect(journalState.isRestored || journalState.storageWarning).toBeTruthy();
    });
  };
  const mount = async () => {
    clock.mockReturnValue(currentTime);
    store = configureStore({ reducer: { tracker: forecastReducer } });
    view = render(renderWorkflow());
    await waitForJournal();
  };
  await mount();
  return {
    user,
    update: async (time) => {
      currentTime = time;
      clock.mockReturnValue(time);
      await act(async () => view.rerender(renderWorkflow()));
    },
    reload: async () => {
      view.unmount();
      await mount();
    },
    acquireOwnership: async () => {
      await act(async () => {
        grantLock();
      });
      await waitForJournal();
    },
    syncFromOtherTab: async (journal) => {
      await act(async () => {
        saveBrowserJournal(journal);
        window.dispatchEvent(new StorageEvent('storage', { key: JOURNAL_STORAGE_KEY }));
      });
    },
  };
};
