import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { useGetCandlesQuery, useGetTickerQuery } from '@/services/coinbase/coinbase.api';
import { useGetKalshiMarketsQuery, useGetKalshiBenchmarkQuery } from '@/services/kalshi/kalshi.api';
import BitcoinTracker from '../index.web';
import trackerReducer from '../state/slices/trackerSlice';
import { formatPercent } from '../utils/format.utils';
import {
  FORECAST_PREFERENCES_STORAGE_KEY,
  writeForecastPreferences,
} from '../utils/forecastAutomation.utils';

jest.mock('@/services/coinbase/coinbase.api', () => ({
  useGetCandlesQuery: jest.fn(),
  useGetTickerQuery: jest.fn(),
}));

jest.mock('@/services/kalshi/kalshi.api', () => ({
  useGetKalshiMarketsQuery: jest.fn(),
  useGetKalshiBenchmarkQuery: jest.fn(),
}));

jest.mock('../components/PriceChart', () => () => null);
jest.mock('../hooks/useCoinbaseStream', () => () => mockStream);
jest.mock('../hooks/useResearchSync', () => () => ({ warning: null, lastSyncedAt: null }));
jest.mock('../hooks/useResearchLearning', () => {
  const models = { active: null, candidate: null };
  return () => ({ models, warning: null });
});
jest.mock('../hooks/useBackgroundResearch', () => () => ({ warning: null, status: null }));
const mockKalshiSettlement = { outcomes: [], warning: null };
jest.mock('../hooks/useKalshiSettlement', () => () => mockKalshiSettlement);
jest.mock('../hooks/useForecastEvidence', () => () => null);
jest.mock('../utils/kalshi/browserCleanup.utils', () => ({
  cleanupLegacyBrowserResearch: jest.fn(async () => {
    const { forecasts, scheduledForecast } = jest
      .requireActual('../utils/journal.utils')
      .loadJournal();
    return { forecasts, scheduledForecast };
  }),
}));
jest.mock('../utils/evidenceStorage.utils', () => ({
  ...jest.requireActual('../utils/evidenceStorage.utils'),
  appendEvidenceRows: jest.fn().mockResolvedValue(undefined),
}));

const mockStream = {
  status: 'live',
  ticker: null,
  quality: { available: true, reason: null, flowReadySeconds: 180 },
  flow: {
    available: true,
    windows: Object.fromEntries(
      [15, 60, 180].map((seconds) => [
        seconds,
        {
          available: true,
          tradeCount: 100,
          totalBtc: 10,
          buyBtc: 5,
          sellBtc: 5,
          signedBtc: 0,
          imbalance: 0,
        },
      ]),
    ),
  },
  liquidity: {
    available: true,
    bid: 49_999,
    ask: 50_001,
    midpoint: 50_000,
    depth: Object.fromEntries(
      [5, 10, 25].map((band) => [
        band,
        {
          bidBtc: 50,
          askBtc: 50,
          totalBtc: 100,
          imbalance: 0,
        },
      ]),
    ),
    depthChange60: { available: true, totalFraction: 0 },
  },
  getDeadlineOutcome: jest.fn(() => ({ status: 'waiting' })),
};

const NOW = Date.UTC(2026, 8, 7, 12, 0, 15);
const MINUTE = 60_000;

function createKalshiContract(overrides = {}) {
  const startsAt = Date.UTC(2026, 8, 7, 12);
  return {
    ticker: 'KXBTC15M-26SEP070815-15',
    eventTicker: 'KXBTC15M-26SEP070815',
    seriesTicker: 'KXBTC15M',
    exchangeIndex: 2,
    target: 49_750,
    startsAt,
    expiresAt: startsAt + 15 * MINUTE,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: 'kalshi-btc15m-brti-average-v1',
    status: 'active',
    result: null,
    receivedAt: NOW,
    yesBid: 0.6,
    yesAsk: 0.62,
    noBid: 0.38,
    noAsk: 0.4,
    url: 'https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/kxbtc15m-26sep070815',
    ...overrides,
  };
}

function createMarket(now = NOW, price = 50_000) {
  const currentMinute = Math.floor(now / MINUTE) * MINUTE;
  const moves = [-0.0012, 0.0007, 0.0015, -0.0008, 0.0002, -0.0004];
  let previousClose = price;
  const candles = Array.from({ length: 90 }, (_, index) => {
    const close = previousClose * Math.exp(moves[index % moves.length]);
    const candle = {
      time: currentMinute - (90 - index) * MINUTE,
      open: previousClose,
      high: Math.max(previousClose, close) * 1.0001,
      low: Math.min(previousClose, close) * 0.9999,
      close,
      volume: 20,
    };
    previousClose = close;
    return candle;
  });

  return {
    candles,
    ticker: {
      price,
      bid: price - 1,
      ask: price + 1,
      volume: 1000,
      time: Math.max(currentMinute, now - 1000),
      receivedAt: now,
    },
  };
}

function createQuery(data, overrides = {}) {
  if (Number.isFinite(data?.price)) {
    mockStream.liquidity.bid = data.bid;
    mockStream.liquidity.ask = data.ask;
    mockStream.liquidity.midpoint = data.bid / 2 + data.ask / 2;
  }
  return {
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

async function renderTracker() {
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  const renderView = () => (
    <Provider store={store}>
      <BitcoinTracker />
    </Provider>
  );
  const view = render(renderView());
  await act(async () => {});

  return { ...view, store, rerenderTracker: () => view.rerender(renderView()) };
}

function expectFixedPrediction(snapshot) {
  const checkpoints = within(
    screen.getByRole('region', { name: 'Saved and upcoming fixed checkpoints' }),
  );
  const row = within(
    checkpoints.getByRole('row', { name: new RegExp(`${snapshot.checkpointMinutes} min left`) }),
  );
  const label =
    snapshot.direction === 'neutral'
      ? 'Neutral · 50/50'
      : snapshot.direction === 'above'
        ? `Yes · ${formatPercent(snapshot.aboveProbability)}`
        : `No · ${formatPercent(snapshot.belowProbability)}`;
  expect(row.getByText(label)).toBeInTheDocument();
}

describe('BitcoinTracker interactions', () => {
  let user;
  let market;
  let quoteQuery;
  let candleQuery;
  let originalLocks;

  function advanceWithFreshMarket(rerenderTracker, duration, price = 50_000) {
    for (let elapsed = 0; elapsed < duration; elapsed += 5000) {
      act(() => jest.advanceTimersByTime(Math.min(5000, duration - elapsed)));
      market = createMarket(Date.now(), price);
      quoteQuery = createQuery(market.ticker);
      candleQuery = createQuery(market.candles);
      rerenderTracker();
    }
  }

  function arriveAtCheckpoint(rerenderTracker, captureAt, price = 50_000) {
    // Checkpoint publication uses the deadline and the fresh quote, without needing hundreds of
    // intermediate renders. A timer tick then refreshes the visible remaining time.
    jest.setSystemTime(captureAt);
    market = createMarket(captureAt, price);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();
    act(() => jest.advanceTimersByTime(1000));
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    window.localStorage.clear();
    writeForecastPreferences({ autoEnabled: false, checkpointMinutes: [9] });
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: jest.fn((name, options, callback) =>
          Promise.resolve().then(() => callback({ name })),
        ),
      },
    });
    mockStream.getDeadlineOutcome.mockReset().mockReturnValue({ status: 'waiting' });
    jest.spyOn(window.crypto, 'randomUUID').mockReturnValue('recorded-forecast-1');
    user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    market = createMarket();
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    useGetTickerQuery.mockImplementation(() => quoteQuery);
    useGetCandlesQuery.mockImplementation(() => candleQuery);
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [], receivedAt: NOW }));
    useGetKalshiBenchmarkQuery.mockReturnValue(
      createQuery({
        status: 'not-configured',
        current: null,
        samples: [],
        receivedAt: NOW,
      }),
    );
    mockKalshiSettlement.outcomes = [];
    mockKalshiSettlement.warning = null;
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
  });

  test('keeps the headline on BRTI when Coinbase prices change independently', async () => {
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const current = { time: NOW, price: 50_123.45 };
    useGetKalshiBenchmarkQuery.mockReturnValue(
      createQuery({
        available: true,
        status: 'live',
        current,
        samples: [{ time: NOW - 900_000, price: 50_000 }, current],
        receivedAt: NOW,
      }),
    );
    const { rerenderTracker } = await renderTracker();
    const headline = within(screen.getByRole('region', { name: 'Bitcoin index price' }));
    expect(headline.getByText('$50,123.45')).toBeInTheDocument();
    expect(screen.getByText('BRTI live')).toBeInTheDocument();
    quoteQuery = createQuery(createMarket(NOW, 51_000).ticker);
    rerenderTracker();
    expect(headline.getByText('$50,123.45')).toBeInTheDocument();
    expect(headline.queryByText('$51,000.00')).not.toBeInTheDocument();
  });

  test('defaults to the actual Kalshi target and close time instead of a new fifteen-minute window', async () => {
    localStorage.removeItem(FORECAST_PREFERENCES_STORAGE_KEY);
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const { store } = await renderTracker();
    expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(49_750);
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveAttribute(
      'readonly',
    );
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:45$/);
    expect(screen.queryByRole('button', { name: 'Use current' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Custom forecast' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Fixed checkpoints' })).toBeInTheDocument();
    expect(screen.getByText('9 min left')).toBeInTheDocument();
    expect(screen.getByText('6 min left')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
    expect(screen.getByText(/A tie counts as Yes/)).toBeInTheDocument();
    expect(screen.getByText(/Coinbase proxy · BRTI access needed/)).toBeInTheDocument();
    expect(useGetKalshiBenchmarkQuery).toHaveBeenLastCalledWith(
      contract.expiresAt,
      expect.any(Object),
    );
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test.each([
    { elapsedMinutes: 3, countdown: '12:00', checkpointMinutes: 9, observationSeconds: 180 },
    { elapsedMinutes: 13, countdown: '02:00', checkpointMinutes: 1, observationSeconds: 60 },
  ])(
    'joins Kalshi with $countdown remaining and captures a fixed call without moving its deadline',
    async ({ elapsedMinutes, countdown, checkpointMinutes, observationSeconds }) => {
      writeForecastPreferences({ autoEnabled: false, checkpointMinutes: [checkpointMinutes] });
      const contract = createKalshiContract();
      const joinedAt = contract.startsAt + elapsedMinutes * MINUTE;
      jest.setSystemTime(joinedAt);
      market = createMarket(joinedAt);
      quoteQuery = createQuery(market.ticker);
      candleQuery = createQuery(market.candles);
      useGetKalshiMarketsQuery.mockReturnValue(
        createQuery({ markets: [contract], receivedAt: joinedAt }),
      );
      const { store, rerenderTracker } = await renderTracker();
      expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(countdown);
      await user.click(screen.getByRole('button', { name: 'Start forecast' }));
      expect(store.getState().tracker.forecasts[0]).toMatchObject({
        target: contract.target,
        startsAt: contract.startsAt,
        expiresAt: contract.expiresAt,
        createdAt: joinedAt,
        status: 'analyzing',
        aboveProbability: null,
        checkpointMinutes,
        captureOrigin: 'manual',
        kalshiMarket: { ticker: contract.ticker },
        analysis: {
          earliestAt: contract.expiresAt - checkpointMinutes * MINUTE,
          policyVersion: 'kalshi-checkpoint-v5',
        },
      });
      advanceWithFreshMarket(rerenderTracker, observationSeconds * 1000 - 5000);
      expect(store.getState().tracker.forecasts[0].status).toBe('analyzing');
      advanceWithFreshMarket(rerenderTracker, 5000);
      const [fixed] = store.getState().tracker.forecasts;
      expect(fixed).toMatchObject({
        target: contract.target,
        startsAt: contract.startsAt,
        expiresAt: contract.expiresAt,
        createdAt: joinedAt + observationSeconds * 1000,
        status: 'pending',
        outcomeDefinition: 'kalshi-btc15m-brti-average-v1',
      });
      expect(fixed.aboveProbability).toBeGreaterThan(0.5);
      expectFixedPrediction(fixed);
      const liveBefore = within(screen.getByRole('region', { name: 'Live estimate' }))
        .getByRole('img')
        .getAttribute('aria-label');
      advanceWithFreshMarket(rerenderTracker, 5000, 49_500);
      expect(store.getState().tracker.forecasts).toEqual([fixed]);
      expectFixedPrediction(fixed);
      expect(
        within(screen.getByRole('region', { name: 'Live estimate' }))
          .getByRole('img')
          .getAttribute('aria-label'),
      ).not.toBe(liveBefore);
      expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(
        contract.target,
      );
      expect(JSON.parse(localStorage.getItem('bitcoin-tracker:journal:v1')).forecasts).toEqual([
        fixed,
      ]);
    },
  );

  test('waits for an upcoming Kalshi target instead of replacing it with the Coinbase price', async () => {
    const startsAt = Date.UTC(2026, 8, 7, 12, 15);
    const contract = createKalshiContract({
      startsAt,
      expiresAt: startsAt + 15 * MINUTE,
      target: null,
      status: 'initialized',
    });
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const { store } = await renderTracker();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
    expect(
      screen.getByText('The official target is published when this event starts.'),
    ).toBeInTheDocument();
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('Auto saves both selected checkpoints and moves to the next official event while the old result is pending', async () => {
    localStorage.removeItem(FORECAST_PREFERENCES_STORAGE_KEY);
    let recordedEvents = 0;
    window.crypto.randomUUID.mockImplementation(() => `automatic-event-${++recordedEvents}`);
    const current = createKalshiContract();
    const future = createKalshiContract({
      ticker: 'KXBTC15M-26SEP070830-30',
      eventTicker: 'KXBTC15M-26SEP070830',
      startsAt: current.expiresAt,
      expiresAt: current.expiresAt + 15 * MINUTE,
      target: null,
      status: 'initialized',
    });
    useGetKalshiMarketsQuery.mockReturnValue(
      createQuery({ markets: [current, future], receivedAt: NOW }),
    );
    const { store, rerenderTracker } = await renderTracker();
    await user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(store.getState().tracker.forecasts).toHaveLength(2);
    expect(store.getState().tracker.forecasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkpointMinutes: 9, captureOrigin: 'automatic' }),
        expect.objectContaining({ checkpointMinutes: 6, captureOrigin: 'automatic' }),
      ]),
    );
    arriveAtCheckpoint(rerenderTracker, current.expiresAt - 9 * MINUTE);
    const fixedNine = store
      .getState()
      .tracker.forecasts.find((entry) => entry.checkpointMinutes === 9);
    expect(fixedNine.status).toBe('pending');
    expectFixedPrediction(fixedNine);
    expect(
      store.getState().tracker.forecasts.find((entry) => entry.checkpointMinutes === 6).status,
    ).toBe('analyzing');
    arriveAtCheckpoint(rerenderTracker, current.expiresAt - 6 * MINUTE, 49_500);
    const fixedSix = store
      .getState()
      .tracker.forecasts.find((entry) => entry.checkpointMinutes === 6);
    expect(fixedSix.status).toBe('pending');
    expect(fixedSix.aboveProbability).not.toBe(fixedNine.aboveProbability);
    expectFixedPrediction(fixedSix);
    expect(store.getState().tracker.forecasts.find((entry) => entry.id === fixedNine.id)).toEqual(
      fixedNine,
    );

    const openedAt = future.startsAt + 1000;
    jest.setSystemTime(openedAt);
    market = createMarket(openedAt);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const opened = { ...future, target: 50_123.45, status: 'active', receivedAt: openedAt };
    useGetKalshiMarketsQuery.mockReturnValue(
      createQuery({ markets: [opened], receivedAt: openedAt }),
    );
    rerenderTracker();
    act(() => jest.advanceTimersByTime(1000));
    const saved = store.getState().tracker.forecasts;
    expect(saved).toHaveLength(4);
    const nextEvent = saved.filter((entry) => entry.kalshiMarket.ticker === future.ticker);
    expect(nextEvent).toHaveLength(2);
    expect(
      nextEvent.every(
        (entry) => entry.captureOrigin === 'automatic' && entry.status === 'analyzing',
      ),
    ).toBe(true);
    for (const original of [fixedNine, fixedSix]) {
      expect(saved.find((entry) => entry.id === original.id)).toEqual({
        ...original,
        status: 'awaiting-settlement',
      });
    }
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_123.45);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:58$/);
    expect(JSON.parse(localStorage.getItem('bitcoin-tracker:journal:v1')).forecasts).toEqual(saved);
    rerenderTracker();
    expect(store.getState().tracker.forecasts).toHaveLength(4);
    await user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
    expect(store.getState().tracker.forecasts).toEqual(saved);
  });

  test('arms the next real event and starts automatically with its published target', async () => {
    const current = createKalshiContract();
    const future = createKalshiContract({
      ticker: 'KXBTC15M-26SEP070830-30',
      eventTicker: 'KXBTC15M-26SEP070830',
      startsAt: current.expiresAt,
      expiresAt: current.expiresAt + 15 * MINUTE,
      target: null,
      status: 'initialized',
    });
    useGetKalshiMarketsQuery.mockReturnValue(
      createQuery({ markets: [current, future], receivedAt: NOW }),
    );
    const { store, rerenderTracker } = await renderTracker();
    await user.click(screen.getByRole('combobox', { name: 'Kalshi event' }));
    await user.click(screen.getByRole('option', { name: /target pending/ }));
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(store.getState().tracker.scheduledForecast).toMatchObject({
      target: null,
      startsAt: future.startsAt,
      expiresAt: future.expiresAt,
      marketTicker: future.ticker,
      status: 'scheduled',
      outcomeDefinition: 'kalshi-btc15m-brti-average-v1',
    });
    expect(store.getState().tracker.forecasts).toEqual([]);
    const openedAt = future.startsAt + 1_000;
    jest.setSystemTime(openedAt);
    market = createMarket(openedAt);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const opened = { ...future, target: 50_123.45, status: 'active', receivedAt: openedAt };
    useGetKalshiMarketsQuery.mockReturnValue(
      createQuery({ markets: [opened], receivedAt: openedAt }),
    );
    rerenderTracker();
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_123.45);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:58$/);
    expect(store.getState().tracker.scheduledForecast).toBeNull();
    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      target: 50_123.45,
      startsAt: future.startsAt,
      expiresAt: future.expiresAt,
      kalshiMarket: { ticker: future.ticker },
      status: 'analyzing',
    });
  });

  test('restores an armed event after reload and allows cancellation before opening', async () => {
    const startsAt = Date.UTC(2026, 8, 7, 12, 15);
    const future = createKalshiContract({
      ticker: 'KXBTC15M-26SEP070830-30',
      eventTicker: 'KXBTC15M-26SEP070830',
      startsAt,
      expiresAt: startsAt + 15 * MINUTE,
      target: null,
      status: 'initialized',
    });
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [future], receivedAt: NOW }));
    const original = await renderTracker();
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    const schedule = original.store.getState().tracker.scheduledForecast;
    expect(schedule).toMatchObject({
      marketTicker: future.ticker,
      target: null,
      status: 'scheduled',
    });
    original.unmount();
    const restored = await renderTracker();
    expect(restored.store.getState().tracker.scheduledForecast).toEqual(schedule);
    expect(restored.store.getState().tracker.forecasts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));
    expect(restored.store.getState().tracker.scheduledForecast).toBeNull();
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
  });

  test('disables capture when cached contract details cannot be refreshed', async () => {
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const { store, rerenderTracker } = await renderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    useGetKalshiMarketsQuery.mockReturnValue(
      createQuery({ markets: [contract], receivedAt: NOW }, { isError: true }),
    );
    rerenderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(
      contract.target,
    );
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('pauses when Kalshi discovery fails without offering a fabricated target or a custom event', async () => {
    useGetKalshiMarketsQuery.mockReturnValue(createQuery(undefined, { isError: true }));
    const { store } = await renderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
    expect(
      screen.getByText('Could not refresh Kalshi events. Retrying automatically.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Custom forecast' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Schedule by' })).not.toBeInTheDocument();
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test.each(['quote', 'candles'])(
    'pauses the Kalshi estimate when the %s feed fails and retries market inputs',
    async (failedQuery) => {
      useGetKalshiMarketsQuery.mockReturnValue(
        createQuery({ markets: [createKalshiContract()], receivedAt: NOW }),
      );
      const { store, rerenderTracker } = await renderTracker();
      expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
      if (failedQuery === 'quote') quoteQuery = { ...quoteQuery, isError: true };
      else candleQuery = { ...candleQuery, isError: true };
      rerenderTracker();
      expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
      expect(screen.getByRole('heading', { name: 'Estimate paused' })).toBeInTheDocument();
      expect(store.getState().tracker.forecasts).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(quoteQuery.refetch).toHaveBeenCalledTimes(1);
      expect(candleQuery.refetch).toHaveBeenCalledTimes(1);
    },
  );

  test('keeps the official target during quote updates and resumes after fresh market data', async () => {
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const { store, rerenderTracker } = await renderTracker();
    act(() => jest.advanceTimersByTime(21_000));
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(
      contract.target,
    );
    market = createMarket(Date.now(), 50_200);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(
      contract.target,
    );
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('rechecks the deadline at the click time rather than starting an expired event', async () => {
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const { store } = await renderTracker();
    jest.setSystemTime(contract.expiresAt + 1);
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('restores the same immutable Kalshi call and countdown after reload', async () => {
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const original = await renderTracker();
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    arriveAtCheckpoint(original.rerenderTracker, contract.expiresAt - 9 * MINUTE);
    const fixed = original.store.getState().tracker.forecasts[0];
    expect(fixed.status).toBe('pending');
    const remaining = screen.getByRole('timer', { name: 'Time remaining' }).textContent;
    original.unmount();
    const restored = await renderTracker();
    expect(restored.store.getState().tracker.forecasts).toEqual([fixed]);
    expectFixedPrediction(fixed);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(remaining);
    expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(
      contract.target,
    );
  });

  test('waits for official Kalshi settlement and scores an equal final average as Yes', async () => {
    const contract = createKalshiContract();
    useGetKalshiMarketsQuery.mockReturnValue(createQuery({ markets: [contract], receivedAt: NOW }));
    const { store, rerenderTracker } = await renderTracker();
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    arriveAtCheckpoint(rerenderTracker, contract.expiresAt - 9 * MINUTE);
    const fixed = store.getState().tracker.forecasts[0];
    act(() => jest.advanceTimersByTime(contract.expiresAt - Date.now() + 1000));
    market = createMarket(Date.now(), 49_000);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();
    expect(store.getState().tracker.forecasts[0].status).toBe('awaiting-settlement');
    expect(store.getState().tracker.forecasts[0].outcome).toBeUndefined();
    expect(mockStream.getDeadlineOutcome).not.toHaveBeenCalled();
    mockKalshiSettlement.outcomes = [
      {
        status: 'observed',
        outcomeDefinition: contract.outcomeDefinition,
        marketTicker: contract.ticker,
        target: contract.target,
        expiresAt: contract.expiresAt,
        observedPrice: contract.target,
        observedAt: contract.expiresAt,
        outcome: 'above',
        result: 'yes',
        confirmedThrough: Date.now(),
        settledAt: Date.now(),
        comparison: 'greater_or_equal',
        roundDigits: 2,
      },
    ];
    rerenderTracker();
    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      status: 'resolved',
      outcome: 'above',
      observedPrice: contract.target,
      correct: true,
      aboveProbability: fixed.aboveProbability,
      belowProbability: fixed.belowProbability,
    });
    expectFixedPrediction(fixed);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^00:00$/);
  });
});
