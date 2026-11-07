import { resetEvidenceServer, stopEvidenceServer } from './evidenceServer';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { serialize, deserialize } from 'node:v8';
import { Provider, useSelector } from 'react-redux';
import { makeStore } from '@/state/store';
import { kalshiApi } from '@/services/kalshi/kalshi.api';
import { researchApi } from '@/services/research/research.api';
import { coinbaseApi } from '@/services/coinbase/coinbase.api';
import { selectStorageWarning } from '@/features/Forecasting/state/selectors/forecastSelectors';
import Forecasting from '@/features/Forecasting/Forecasting';
import useForecastJournal from '@/features/Forecasting/features/ForecastJournal/hooks/useForecastJournal';
import useForecastSelection from '@/features/Forecasting/features/CheckpointForecasts/hooks/useForecastSelection';
import useCheckpointForecasts from '@/features/Forecasting/features/CheckpointForecasts/hooks/useCheckpointForecasts';
import useEventEstimates from '@/features/Forecasting/features/LiveEstimates/hooks/useEventEstimates';
import useForecastOutcomes from '@/features/Forecasting/features/ForecastJournal/hooks/useForecastOutcomes';
import { JOURNAL_STORAGE_KEY } from '@/features/Forecasting/features/ForecastJournal/utils/journal.utils';
import useForecastResearch from '../../../../hooks/useForecastResearch';
import useForecastEvidence from '../../hooks/useForecastEvidence';
import Methodology from '@/app/_dashboard/Methodology';
import { createMarketFeed, currentMarket, eventStart, nextMarket } from './evidenceFixtures';

let clock;
let stores;
let backgroundLockAvailable;
let downloads;
let blobs;
let journalLockMode;
let grantJournalLock;
export const setBackgroundLockAvailable = (available) => {
  backgroundLockAvailable = available;
};
export const setupEvidenceTests = () => {
  const originals = Object.fromEntries(
    ['indexedDB', 'structuredClone'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const originalCreateUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const originalRevokeUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  beforeEach(() => {
    localStorage.clear();
    resetEvidenceServer();
    clock = jest.spyOn(Date, 'now').mockReturnValue(eventStart);
    stores = [];
    downloads = [];
    blobs = new Map();
    backgroundLockAvailable = true;
    journalLockMode = 'owner';
    grantJournalLock = null;
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    if (!globalThis.structuredClone)
      Object.defineProperty(globalThis, 'structuredClone', {
        configurable: true,
        value: (value) => deserialize(serialize(value)),
      });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (name, options, callback) => {
          if (
            name === 'bitcoin-tracker:forecast-journal:writer' &&
            journalLockMode === 'follower'
          ) {
            return await new Promise((resolve, reject) => {
              grantJournalLock = () => {
                journalLockMode = 'owner';
                resolve(callback({ name }));
              };
              options.signal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          return await callback(
            name === 'bitcoin-tracker-background-research' && !backgroundLockAvailable
              ? null
              : { name },
          );
        },
      },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob) => {
        const url = `blob:test-evidence-${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click');
    anchorClick.mockImplementation(() => {
      const anchor = anchorClick.mock.contexts.at(-1);
      downloads.push({ filename: anchor.download, blob: blobs.get(anchor.href) });
    });
  });
  afterEach(async () => {
    cleanup();
    stores.forEach((store) => {
      store.dispatch(kalshiApi.util.resetApiState());
      store.dispatch(researchApi.util.resetApiState());
      store.dispatch(coinbaseApi.util.resetApiState());
    });
    await stopEvidenceServer();
    jest.restoreAllMocks();
    localStorage.clear();
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
    if (originalCreateUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateUrl);
    else delete URL.createObjectURL;
    if (originalRevokeUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeUrl);
    else delete URL.revokeObjectURL;
  });
};

// Evidence has no standalone screen. These are the dashboard's real forecasting,
// recording, synchronization and research controls, fed external market snapshots.
const EvidenceWorkflow = ({ now, markets, feed, onJournalReady }) => {
  const journal = useForecastJournal();
  const selection = useForecastSelection();
  const selectedMarket =
    markets.find(
      (market) => market.ticker === selection.preferredTicker && market.expiresAt > now,
    ) ??
    markets.find((market) => market.startsAt <= now && market.expiresAt > now) ??
    markets.find((market) => market.expiresAt > now) ??
    null;
  const marketData = { ...feed, kalshiMarkets: markets, selectedMarket };
  const research = useForecastResearch({
    forecasts: selection.forecasts,
    journal,
    now,
    marketData,
  });
  const estimates = useEventEstimates({ now, marketData, selection, research });
  const checkpoints = useCheckpointForecasts({
    now,
    selection,
    marketData,
    kalshiMarket: estimates.kalshiMarket,
    isJournalReady: journal.isReady,
    research,
  });
  const settlement = useForecastOutcomes({
    forecasts: selection.forecasts,
    now,
    isReady: journal.isReady,
  });
  const evidenceWarning = useForecastEvidence({
    forecasts: selection.forecasts,
    ...feed,
    now,
    progress: checkpoints.fixedProgress,
    isReady: journal.isReady,
    models: research.models,
    kalshiOutcomes: settlement.outcomes,
  });
  const storageWarning = useSelector(selectStorageWarning);
  onJournalReady(journal);
  return (
    <>
      {storageWarning && <p role="alert">{storageWarning}</p>}
      {settlement.warning && <p role="alert">{settlement.warning}</p>}
      <Forecasting
        now={now}
        marketData={marketData}
        journal={journal}
        selection={selection}
        checkpoints={checkpoints}
        estimates={estimates}
      />
      <Methodology
        evidenceWarning={evidenceWarning ?? research.researchWarning}
        researchStatus={research.researchStatus}
      />
    </>
  );
};

export const renderEvidenceCollection = async ({
  now = eventStart,
  markets = [currentMarket, nextMarket],
  feedOverrides = {},
  forecasts,
  lock = 'owner',
} = {}) => {
  journalLockMode = lock;
  if (lock === 'unsupported')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  if (forecasts)
    localStorage.setItem(
      JOURNAL_STORAGE_KEY,
      JSON.stringify({ version: 7, forecasts, scheduledForecast: null }),
    );
  let props = {
    now,
    markets: markets.map((market) => ({ ...market, receivedAt: market.receivedAt ?? now })),
    feed: { ...createMarketFeed(now), ...feedOverrides },
  };
  let store;
  let view;
  let journal;
  const user = userEvent.setup();
  const renderWorkflow = () => (
    <Provider store={store}>
      <EvidenceWorkflow
        {...props}
        onJournalReady={(status) => {
          journal = status;
        }}
      />
    </Provider>
  );
  const mount = async () => {
    clock.mockReturnValue(props.now);
    store = makeStore();
    stores.push(store);
    view = render(renderWorkflow());
    await waitFor(() =>
      expect(journalLockMode === 'owner' ? journal.isReady : journal.isRestored).toBe(true),
    );
  };
  await mount();
  return {
    user,
    update: async (time, { price = 50_000, markets: updatedMarkets, ...feed } = {}) => {
      props = {
        now: time,
        markets: updatedMarkets
          ? updatedMarkets.map((market) => ({ ...market, receivedAt: market.receivedAt ?? time }))
          : props.markets.map((market) => ({ ...market, receivedAt: time })),
        feed: { ...createMarketFeed(time, price), ...feed },
      };
      clock.mockReturnValue(time);
      await act(async () => view.rerender(renderWorkflow()));
    },
    reload: async () => {
      view.unmount();
      await mount();
    },
    unmount: () => view.unmount(),
    acquireOwnership: async () => {
      await act(async () => {
        grantJournalLock();
      });
      await waitFor(() => expect(journal.isReady).toBe(true));
    },
  };
};

export const openResearch = async (user) => {
  if (!screen.queryByRole('dialog', { name: 'Forecast research and learning' }))
    await user.click(screen.getByRole('button', { name: 'Research data' }));
  return within(await screen.findByRole('dialog', { name: 'Forecast research and learning' }));
};
export const closeResearch = async (user) => {
  const dialog = await openResearch(user);
  await user.click(dialog.getByRole('button', { name: 'Close research data' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Forecast research and learning' }),
    ).not.toBeInTheDocument(),
  );
};
export const exportPendingEvidence = async (user) => {
  const dialog = await openResearch(user);
  const previousCount = downloads.length;
  await user.click(dialog.getByRole('button', { name: 'Export pending records' }));
  await waitFor(() => expect(downloads).toHaveLength(previousCount + 1));
  const { blob, filename } = downloads.at(-1);
  expect(filename).toMatch(/^bitcoin-pending-\d{4}-\d{2}-\d{2}\.jsonl$/);
  expect(blob.type).toBe('application/x-ndjson');
  const text = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  const rows = text
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(dialog.getByText(`Exported ${rows.length.toLocaleString()} records.`)).toBeVisible();
  return rows;
};
