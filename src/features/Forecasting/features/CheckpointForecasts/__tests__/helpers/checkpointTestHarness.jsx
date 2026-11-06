import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { Provider, useSelector } from 'react-redux';
import CheckpointForecasts from '../../CheckpointForecasts';
import useForecastSelection from '../../hooks/useForecastSelection';
import useCheckpointForecasts from '../../hooks/useCheckpointForecasts';
import useEventEstimates from '../../../LiveEstimates/hooks/useEventEstimates';
import useForecastJournal from '../../../ForecastJournal/hooks/useForecastJournal';
import useForecastOutcomes from '../../../ForecastJournal/hooks/useForecastOutcomes';
import useResearchEstimates from '@/features/ForecastResearch/hooks/useResearchEstimates';
import forecastReducer from '@/features/Forecasting/state/slices/forecastSlice';
import { selectStorageWarning } from '@/features/Forecasting/state/selectors/forecastSelectors';
import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';
import { fetchKalshiMarketClient } from '@/services/kalshi/kalshi.client.service';
import { formatTime } from '@/utils/format.utils';

// Settlement is the only HTTP request made by this feature composition.
jest.mock('@/services/kalshi/kalshi.client.service', () => ({
  fetchKalshiMarketClient: jest.fn(),
}));

export const eventStart = Date.UTC(2026, 10, 6, 12);
export const eventEnd = eventStart + 900_000;
export const currentMarket = {
  ticker: 'KXBTC15M-26NOV061215-15',
  eventTicker: 'KXBTC15M-26NOV061215',
  seriesTicker: 'KXBTC15M',
  startsAt: eventStart,
  expiresAt: eventEnd,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
  url: 'https://kalshi.com/markets/kxbtc15m',
};
export const nextMarket = {
  ...currentMarket,
  ticker: 'KXBTC15M-26NOV061230-30',
  eventTicker: 'KXBTC15M-26NOV061230',
  startsAt: eventEnd,
  expiresAt: eventEnd + 900_000,
  target: null,
  status: 'initialized',
};
const models = {};
let clock;
let settlementResponses;

export const setSettlementResponse = (market) => {
  settlementResponses.set(market.ticker, market);
};

export const setupCheckpointTests = () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  beforeEach(() => {
    localStorage.clear();
    clock = jest.spyOn(Date, 'now').mockReturnValue(eventStart);
    // Each test receives a new browser database; no working research storage is opened.
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: new IDBFactory(),
    });
    settlementResponses = new Map();
    fetchKalshiMarketClient.mockReset().mockImplementation(async (ticker) => {
      const market = settlementResponses.get(ticker);
      if (!market) throw new Error('Official result is not available yet.');
      return market;
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
  });
};

export const createMarketFeed = (now, price = 50_000) => {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: Math.floor(now / 1000) * 1000 - (1200 - index) * 1000,
    price: price * Math.exp(Math.sin(index / 30) * 0.0001),
    receivedAt: now,
  }));
  return {
    candles: [],
    ticker: { price, bid: price - 1, ask: price + 1, time: now, receivedAt: now },
    benchmark: { available: true, receivedAt: now, current: samples.at(-1), samples },
    stream: {},
    derivatives: {},
    hasRequestError: false,
    hasContractError: false,
  };
};

// TradingDashboard owns these hooks above the research dialog. Compose that same
// feature entry point here, supplying its MarketData/ModelLearning input boundaries.
const CheckpointWorkflow = ({ now, markets, feed, onJournalReady }) => {
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
  const settlement = useForecastOutcomes({
    forecasts: selection.forecasts,
    now,
    isReady: journal.isReady,
  });
  const storageWarning = useSelector(selectStorageWarning);
  onJournalReady(journal);
  return (
    <>
      {storageWarning && <p role="alert">{storageWarning}</p>}
      {settlement.warning && <p role="alert">{settlement.warning}</p>}
      <CheckpointForecasts
        now={now}
        marketData={marketData}
        selection={selection}
        journal={journal}
        estimates={estimates}
        checkpoints={checkpoints}
      />
    </>
  );
};

export const renderCheckpointForecasts = async ({
  now = eventStart,
  markets = [currentMarket, nextMarket],
  feedOverrides = {},
  lockAvailable = true,
} = {}) => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: jest.fn(async (_name, { signal }, callback) => {
        if (lockAvailable) return await callback();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }),
    },
  });
  let props = { now, markets, feed: { ...createMarketFeed(now), ...feedOverrides } };
  let store;
  let view;
  let journal;
  const user = userEvent.setup();
  const renderWorkflow = () => (
    <Provider store={store}>
      <CheckpointWorkflow {...props} onJournalReady={(status) => (journal = status)} />
    </Provider>
  );
  const mount = async () => {
    clock.mockReturnValue(props.now);
    store = configureStore({ reducer: { tracker: forecastReducer } });
    view = render(renderWorkflow());
    await waitFor(() => expect(journal.isRestored).toBe(true));
    if (lockAvailable) await waitFor(() => expect(journal.isOwner).toBe(true));
  };
  await mount();
  return {
    user,
    get store() {
      return store;
    },
    update: async (
      time,
      { price = 50_000, markets: updatedMarkets = props.markets, ...feed } = {},
    ) => {
      props = {
        now: time,
        markets: updatedMarkets,
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
