import { setupPurchaseValueServer } from './purchaseValueServer';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { Provider, useSelector } from 'react-redux';
import { makeStore } from '@/state/store';
import { kalshiApi } from '@/services/kalshi/kalshi.api';
import { researchApi } from '@/services/research/research.api';
import { coinbaseApi } from '@/services/coinbase/coinbase.api';
import { selectStorageWarning } from '@/features/Forecasting/state/selectors/forecastSelectors';
import useResearchEstimates from '@/features/ForecastResearch/hooks/useResearchEstimates';
import CheckpointForecasts from '../../../CheckpointForecasts/CheckpointForecasts';
import useForecastSelection from '../../../CheckpointForecasts/hooks/useForecastSelection';
import useCheckpointForecasts from '../../../CheckpointForecasts/hooks/useCheckpointForecasts';
import useForecastJournal from '../../../ForecastJournal/hooks/useForecastJournal';
import useForecastOutcomes from '../../../ForecastJournal/hooks/useForecastOutcomes';
import { JOURNAL_STORAGE_KEY } from '../../../ForecastJournal/utils/journal.utils';
import LiveEstimates from '../../LiveEstimates';
import useEventEstimates from '../../hooks/useEventEstimates';
import Methodology from '@/app/_dashboard/Methodology';
import { currentMarket, eventStart, nextMarket, createMarketFeed } from './liveEstimateFixtures';
import { formatTime } from '@/utils/format.utils';

const emptyModels = {};
let clock;
let stores;

export const setupLiveEstimateTests = () => {
  setupPurchaseValueServer();
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  beforeEach(() => {
    localStorage.clear();
    clock = jest.spyOn(Date, 'now').mockReturnValue(eventStart);
    stores = [];
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name, _options, callback) => await callback() },
    });
  });
  afterEach(() => {
    cleanup();
    stores.forEach((store) => {
      store.dispatch(kalshiApi.util.resetApiState());
      store.dispatch(researchApi.util.resetApiState());
      store.dispatch(coinbaseApi.util.resetApiState());
    });
    jest.restoreAllMocks();
    localStorage.clear();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
    if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
    else delete globalThis.indexedDB;
  });
};

// Compose the dashboard's real controls and estimation lifecycle. Only upstream
// market/model snapshots, browser coordination, time, and HTTP responses are controlled.
const EstimateWorkflow = ({ now, markets, feed, models, includeMethodology, onJournalReady }) => {
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
  const research = { ...useResearchEstimates({ marketData, models }), models };
  const estimates = useEventEstimates({ now, marketData, selection, research });
  const checkpoints = useCheckpointForecasts({
    now,
    selection,
    marketData,
    kalshiMarket: estimates.kalshiMarket,
    isJournalReady: journal.isReady,
    research,
  });
  useForecastOutcomes({ forecasts: selection.forecasts, now, isReady: journal.isReady });
  const storageWarning = useSelector(selectStorageWarning);
  onJournalReady(journal);
  return (
    <>
      {storageWarning && <p role="alert">{storageWarning}</p>}
      <CheckpointForecasts
        now={now}
        marketData={marketData}
        selection={selection}
        journal={journal}
        estimates={estimates}
        checkpoints={checkpoints}
      >
        <LiveEstimates
          now={now}
          marketData={marketData}
          recordedForecast={selection.recordedForecast}
          estimates={estimates}
        />
      </CheckpointForecasts>
      {includeMethodology && <Methodology />}
    </>
  );
};

export const renderLiveEstimates = async ({
  now = eventStart,
  markets = [currentMarket, nextMarket],
  feedOverrides = {},
  forecasts = [],
  models = emptyModels,
  includeMethodology = false,
} = {}) => {
  if (forecasts.length)
    localStorage.setItem(
      JOURNAL_STORAGE_KEY,
      JSON.stringify({ version: 7, forecasts, scheduledForecast: null }),
    );
  let props = {
    now,
    markets,
    feed: { ...createMarketFeed(now), ...feedOverrides },
    models,
    includeMethodology,
  };
  let store;
  let view;
  let journal;
  const user = userEvent.setup();
  const renderWorkflow = () => (
    <Provider store={store}>
      <EstimateWorkflow {...props} onJournalReady={(status) => (journal = status)} />
    </Provider>
  );
  const mount = async () => {
    clock.mockReturnValue(props.now);
    store = makeStore();
    stores.push(store);
    view = render(renderWorkflow());
    await waitFor(() => expect(journal.isReady).toBe(true));
  };
  await mount();
  return {
    user,
    update: async (
      time,
      {
        price = 50_000,
        markets: updatedMarkets = props.markets,
        models: updatedModels = props.models,
        ...feed
      } = {},
    ) => {
      props = {
        ...props,
        now: time,
        markets: updatedMarkets,
        models: updatedModels,
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
  };
};

export const selectEvent = async (user, market) => {
  await user.click(screen.getByRole('combobox', { name: 'Kalshi event' }));
  await user.click(
    screen.getByRole('option', {
      name: `${formatTime(market.startsAt)} – ${formatTime(market.expiresAt)}${market.target === null ? ' · target pending' : ''}`,
    }),
  );
};
