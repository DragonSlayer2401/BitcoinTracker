import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { useGetCandlesQuery, useGetTickerQuery } from '@/services/coinbase/coinbase.api';
import BitcoinTracker from '../index.web';
import trackerReducer from '../state/slices/trackerSlice';
import { formatDateTime, formatPercent } from '../utils/format.utils';
import { getForecast } from '../utils/forecast.utils';
import { formatLocalDateTime, parseScheduledStart } from '../utils/schedule.utils';

jest.mock('@/services/coinbase/coinbase.api', () => ({
  useGetCandlesQuery: jest.fn(),
  useGetTickerQuery: jest.fn(),
}));

jest.mock('../components/PriceChart', () => () => null);

async function chooseScheduleMode(user, mode) {
  const labels = { now: 'Start now', scheduled: 'Start time', 'scheduled-end': 'End time' };
  await user.click(screen.getByRole('combobox', { name: 'Schedule by' }));
  await user.click(screen.getByRole('option', { name: labels[mode] }));
}

const NOW = Date.UTC(2026, 8, 7, 12, 0, 15);
const MINUTE = 60_000;

function createMarket(now = NOW, price = 50_000) {
  const currentMinute = Math.floor(now / MINUTE) * MINUTE;
  const moves = [-0.0012, 0.0007, 0.0015, -0.0008, 0.0002, -0.0004];
  let previousClose = 50_000;
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
      time: now - 1000,
      receivedAt: now,
    },
  };
}

function createQuery(data, overrides = {}) {
  return {
    data,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

function renderTracker() {
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  const renderView = () => (
    <Provider store={store}>
      <BitcoinTracker />
    </Provider>
  );
  const view = render(renderView());

  return { ...view, store, rerenderTracker: () => view.rerender(renderView()) };
}

function getForecastPanel() {
  return within(screen.getByRole('region', { name: 'Forecast controls' }));
}

function expectFixedPrediction(snapshot) {
  const prediction = within(screen.getByRole('region', { name: 'Fixed prediction' }));
  const directionLabel =
    snapshot.direction === 'above'
      ? 'Likely above'
      : snapshot.direction === 'below'
        ? 'Likely below'
        : 'Too close to call';

  expect(prediction.getByRole('heading', { name: directionLabel })).toBeInTheDocument();
  expect(
    prediction.getByRole('img', {
      name: `Above target ${formatPercent(snapshot.aboveProbability)}, below target ${formatPercent(snapshot.belowProbability)}`,
    }),
  ).toBeInTheDocument();
}

describe('BitcoinTracker interactions', () => {
  let user;
  let market;
  let quoteQuery;
  let candleQuery;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    window.localStorage.clear();
    jest.spyOn(window.crypto, 'randomUUID').mockReturnValue('recorded-forecast-1');
    user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    market = createMarket();
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    useGetTickerQuery.mockImplementation(() => quoteQuery);
    useGetCandlesQuery.mockImplementation(() => candleQuery);
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('waits for market data before showing probabilities or enabling recording', () => {
    quoteQuery = createQuery(undefined, { isLoading: true, isFetching: true });
    candleQuery = createQuery(undefined, { isLoading: true, isFetching: true });

    renderTracker();

    expect(screen.getByRole('heading', { name: 'Connecting…' })).toBeInTheDocument();
    expect(screen.getByText('Connecting to market')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use current' })).toBeDisabled();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByText('Ready to start')).toBeInTheDocument();
    expect(
      getForecastPanel().getByRole('img', { name: 'Above target —, below target —' }),
    ).toBeInTheDocument();
  });

  test.each(['quote', 'candles'])(
    'hides a previously available estimate when the %s request fails and supports retry',
    async (failedQuery) => {
      const { rerenderTracker, store } = renderTracker();
      expect(screen.getByRole('heading', { name: 'Too close to call' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();

      if (failedQuery === 'quote') quoteQuery = { ...quoteQuery, isError: true };
      else candleQuery = { ...candleQuery, isError: true };
      rerenderTracker();

      expect(screen.getByRole('heading', { name: 'Estimate paused' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Estimates are paused');
      expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
      expect(
        getForecastPanel().getByRole('img', { name: 'Above target —, below target —' }),
      ).toBeInTheDocument();
      expect(store.getState().tracker.forecasts).toEqual([]);

      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(quoteQuery.refetch).toHaveBeenCalledTimes(1);
      expect(candleQuery.refetch).toHaveBeenCalledTimes(1);
    },
  );

  test('pauses an estimate as the last quote ages, then resumes after a fresh quote', () => {
    const { rerenderTracker, store } = renderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();

    act(() => jest.advanceTimersByTime(20_000));

    expect(screen.getByText('Market data delayed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Estimate paused' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use current' })).toBeDisabled();
    expect(store.getState().tracker.forecasts).toEqual([]);

    quoteQuery = createQuery({ ...market.ticker, time: Date.now(), receivedAt: Date.now() });
    rerenderTracker();

    expect(screen.getByText('Live market data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
  });

  test('rechecks quote freshness when recording, even before the next clock render', async () => {
    const { store } = renderTracker();
    const recordButton = screen.getByRole('button', { name: 'Start forecast' });
    expect(recordButton).toBeEnabled();

    // Move wall time without firing the interval: the visible state has not refreshed yet.
    jest.setSystemTime(NOW + 21_000);
    await user.click(recordButton);

    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('starts both countdown displays at fifteen minutes when recording between clock ticks', async () => {
    const { store } = renderTracker();
    const capturedAt = NOW + 750;
    jest.setSystemTime(capturedAt);

    await user.click(screen.getByRole('button', { name: 'Start forecast' }));

    const [snapshot] = store.getState().tracker.forecasts;
    expect(snapshot.createdAt).toBe(capturedAt);
    expect(snapshot.expiresAt).toBe(capturedAt + 15 * MINUTE);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    const journal = within(screen.getByRole('region', { name: 'Forecast history' }));
    expect(journal.getByText('15:00')).toBeInTheDocument();
    expect(screen.queryByText('15:01')).not.toBeInTheDocument();

    act(() => jest.advanceTimersByTime(1000));

    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:59$/);
    expect(journal.getByText('14:59')).toBeInTheDocument();
    expect(store.getState().tracker.forecasts).toEqual([snapshot]);
  });

  test('updates direction when the target changes and resets to an even estimate with Use current', async () => {
    renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    expect(targetInput).toHaveValue(50_000);

    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    expect(screen.getByRole('heading', { name: 'Likely above' })).toBeInTheDocument();

    await user.clear(targetInput);
    await user.type(targetInput, '50250');
    expect(screen.getByRole('heading', { name: 'Likely below' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use current' }));
    expect(targetInput).toHaveValue(50_000);
    expect(screen.getByRole('heading', { name: 'Too close to call' })).toBeInTheDocument();
    expect(
      getForecastPanel().getByRole('img', {
        name: 'Above target 50.0%, below target 50.0%',
      }),
    ).toBeInTheDocument();
  });

  test('preserves an edited target across quote updates and blocks empty or invalid targets', async () => {
    const { rerenderTracker } = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');

    quoteQuery = createQuery({ ...market.ticker, price: 50_100, bid: 50_099, ask: 50_101 });
    rerenderTracker();
    expect(targetInput).toHaveValue(49_750);

    await user.clear(targetInput);
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Estimate paused' })).toBeInTheDocument();

    await user.type(targetInput, '0');
    expect(targetInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
  });

  test('preserves forecast setup and fresh estimates while opening and closing model rules', async () => {
    const { store, rerenderTracker } = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    const selectedStart = screen.getByLabelText('Scheduled start (local time)').value;
    expect(screen.getByRole('heading', { name: 'Likely above' })).toBeInTheDocument();

    const rulesButton = screen.getByRole('button', { name: 'View model rules' });
    await user.click(rulesButton);
    const rules = within(screen.getByRole('dialog', { name: 'Model and data rules' }));
    expect(rules.getByRole('heading', { name: 'Probability model' })).toBeInTheDocument();

    market = createMarket(Date.now(), 49_500);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();
    await user.click(rules.getByRole('button', { name: 'Close rules' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Model and data rules' }),
      ).not.toBeInTheDocument(),
    );

    expect(rulesButton).toHaveFocus();
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toHaveValue(49_750);
    expect(
      screen.getByText('Start time', { selector: '.schedule-select-selection' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Scheduled start (local time)')).toHaveValue(selectedStart);
    expect(screen.getByRole('heading', { name: 'Likely below' })).toBeInTheDocument();
    expect(store.getState().tracker.forecasts).toEqual([]);
    expect(store.getState().tracker.scheduledForecast).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(store.getState().tracker.scheduledForecast).toMatchObject({
      target: 49_750,
      startsAt: NOW + MINUTE,
      expiresAt: NOW + 16 * MINUTE,
      status: 'scheduled',
    });
  });

  test('allows target edits for the live estimate while preserving the recorded prediction and deadline', async () => {
    const { store } = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));

    const [snapshot] = store.getState().tracker.forecasts;
    expect(snapshot).toMatchObject({
      id: 'recorded-forecast-1',
      createdAt: NOW,
      expiresAt: NOW + 15 * MINUTE,
      price: 50_000,
      target: 49_750,
      direction: 'above',
      status: 'pending',
    });
    expect(snapshot.aboveProbability).toBeGreaterThan(0.55);
    expect(snapshot.aboveProbability + snapshot.belowProbability).toBe(1);
    expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
    expect(targetInput).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use current' })).toBeEnabled();
    expectFixedPrediction(snapshot);

    await user.clear(targetInput);
    await user.type(targetInput, '50250');
    expect(targetInput).toHaveValue(50_250);
    expectFixedPrediction(snapshot);
    expect(screen.getByRole('region', { name: 'Fixed prediction' })).toHaveTextContent(
      'Recorded target $49,750.00',
    );
    const livePanel = within(screen.getByRole('region', { name: 'Live estimate' }));
    expect(livePanel.getByRole('heading', { name: 'Likely below' })).toBeInTheDocument();
    expect(livePanel.getByText('Preview target $50,250.00')).toBeInTheDocument();
    await user.clear(targetInput);
    expect(livePanel.getByRole('heading', { name: 'Estimate paused' })).toBeInTheDocument();
    expectFixedPrediction(snapshot);
    await user.click(screen.getByRole('button', { name: 'Use current' }));
    expect(targetInput).toHaveValue(50_000);
    expect(livePanel.getByRole('heading', { name: 'Too close to call' })).toBeInTheDocument();
    const journal = within(screen.getByRole('region', { name: 'Forecast history' }));
    expect(journal.getByRole('rowheader')).toHaveTextContent('$49,750.00');
    expect(journal.getByText('Likely above')).toBeInTheDocument();

    fireEvent.submit(targetInput.closest('form'));
    expect(store.getState().tracker.forecasts).toEqual([snapshot]);
    const saved = JSON.parse(window.localStorage.getItem('bitcoin-tracker:journal:v1'));
    expect(saved.forecasts).toEqual([snapshot]);
  });

  test('restores a persisted active forecast into a new store and prevents a second recording', async () => {
    const firstView = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    const recordedForecasts = firstView.store.getState().tracker.forecasts;
    firstView.unmount();

    jest.setSystemTime(NOW + MINUTE);
    market = createMarket(Date.now(), 49_000);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const restoredView = renderTracker();

    expect(restoredView.store.getState().tracker.forecasts).toEqual(recordedForecasts);
    expectFixedPrediction(recordedForecasts[0]);
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toHaveValue(49_750);
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
    expect(screen.getByText('Countdown running')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByRole('heading', {
        name: 'Likely below',
      }),
    ).toBeInTheDocument();
    const journal = within(screen.getByRole('region', { name: 'Forecast history' }));
    expect(journal.getByRole('rowheader')).toHaveTextContent('$49,750.00');
    expect(journal.getByText('14:00')).toBeInTheDocument();
  });

  test('keeps the original call while separately updating the live estimate for the same target and end', async () => {
    const { store, rerenderTracker } = renderTracker();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
      target: { value: '49750' },
    });
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    const [snapshot] = store.getState().tracker.forecasts;
    expectFixedPrediction(snapshot);

    act(() => jest.advanceTimersByTime(MINUTE));
    market = createMarket(Date.now(), 49_000);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();

    const liveEstimate = getForecast({
      ...market,
      target: snapshot.target,
      now: Date.now(),
      horizonMinutes: 14,
    });
    expect(liveEstimate.direction).toBe('below');
    expect(liveEstimate.aboveProbability).not.toBe(snapshot.aboveProbability);
    expectFixedPrediction(snapshot);
    const livePanel = within(screen.getByRole('region', { name: 'Live estimate' }));
    expect(livePanel.getByRole('heading', { name: 'Likely below' })).toBeInTheDocument();
    expect(
      livePanel.getByRole('img', {
        name: `Above target ${formatPercent(liveEstimate.aboveProbability)}, below target ${formatPercent(liveEstimate.belowProbability)}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:00$/);
    expect(store.getState().tracker.forecasts).toEqual([snapshot]);
  });

  test.each(['quote', 'candles'])(
    'retains the fixed prediction while a failed %s request pauses only the live estimate',
    async (failedQuery) => {
      const { store, rerenderTracker } = renderTracker();
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
        target: { value: '49750' },
      });
      await user.click(screen.getByRole('button', { name: 'Start forecast' }));
      const [snapshot] = store.getState().tracker.forecasts;

      if (failedQuery === 'quote') quoteQuery = { ...quoteQuery, isError: true };
      else candleQuery = { ...candleQuery, isError: true };
      rerenderTracker();

      expectFixedPrediction(snapshot);
      const livePanel = within(screen.getByRole('region', { name: 'Live estimate' }));
      expect(livePanel.getByRole('heading', { name: 'Estimate paused' })).toBeInTheDocument();
      expect(
        livePanel.getByRole('img', { name: 'Above target —, below target —' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
      expect(store.getState().tracker.forecasts).toEqual([snapshot]);
    },
  );

  test('preserves the original prediction through stale data, its deadline, and an unobserved result', async () => {
    const { store, rerenderTracker } = renderTracker();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
      target: { value: '49750' },
    });
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    const [snapshot] = store.getState().tracker.forecasts;

    act(() => jest.advanceTimersByTime(21_000));

    expectFixedPrediction(snapshot);
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByRole('heading', {
        name: 'Estimate paused',
      }),
    ).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(15 * MINUTE - 21_000));

    expectFixedPrediction(snapshot);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^00:00$/);
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByText('Window ended'),
    ).toBeInTheDocument();
    expect(store.getState().tracker.forecasts).toEqual([snapshot]);

    act(() => jest.advanceTimersByTime(36_000));

    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      ...snapshot,
      status: 'unobserved',
    });
    expectFixedPrediction(snapshot);
    expect(
      within(screen.getByRole('region', { name: 'Forecast timing' })).getByRole('status'),
    ).toHaveTextContent('No eligible price was observed at the deadline.');
    expect(screen.getByRole('button', { name: 'New forecast' })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'New forecast' }));

    expect(screen.queryByRole('region', { name: 'Fixed prediction' })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    market = createMarket(Date.now());
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(store.getState().tracker.forecasts[0].status).toBe('unobserved');
  });

  test('keeps the original prediction after an opposite result and starts a separate new draft on request', async () => {
    const { store, rerenderTracker } = renderTracker();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
      target: { value: '49750' },
    });
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 12 * MINUTE) },
    });
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    const [snapshot] = store.getState().tracker.forecasts;
    act(() => jest.advanceTimersByTime(12 * MINUTE));
    market = createMarket(Date.now(), 49_000);
    quoteQuery = createQuery({ ...market.ticker, time: Date.now() });
    candleQuery = createQuery(market.candles);
    rerenderTracker();

    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      ...snapshot,
      status: 'resolved',
      observedPrice: 49_000,
      outcome: 'below',
      correct: false,
    });
    const resolvedForecast = store.getState().tracker.forecasts[0];
    expectFixedPrediction(snapshot);
    expect(
      within(screen.getByRole('region', { name: 'Forecast timing' })).getByRole('status'),
    ).toHaveTextContent('Observed below target: $49,000.00');
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^00:00$/);
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use current' })).toBeEnabled();
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByText('Window ended'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
      target: { value: '50250' },
    });
    await user.click(screen.getByRole('button', { name: 'New forecast' }));

    expect(screen.queryByRole('region', { name: 'Fixed prediction' })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toHaveValue(50_250);
    expect(screen.getByRole('spinbutton', { name: 'Target price' })).toBeEnabled();
    expect(screen.getByText('Start now', { selector: '.schedule-select-selection' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByRole('button', { name: 'Use current' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Use current' }));
    expect(screen.getByRole('heading', { name: 'Too close to call' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(store.getState().tracker.forecasts).toEqual([resolvedForecast]);
  });

  test('schedules a fixed target and window while counting down to the start without recording early', async () => {
    const { store } = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByText('$49,750.00')).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + MINUTE))).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + 16 * MINUTE))).toBeInTheDocument();
    expect(timing.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('01:00');
    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(timing.queryByText('Above / below')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start scheduled' })).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: 'Schedule by' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeInTheDocument();
    expect(store.getState().tracker.forecasts).toEqual([]);
    expect(targetInput).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use current' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Fixed prediction' })).not.toBeInTheDocument();

    await user.clear(targetInput);
    await user.type(targetInput, '50250');
    act(() => jest.advanceTimersByTime(30_000));

    expect(targetInput).toHaveValue(50_250);
    expect(timing.getByText('$49,750.00')).toBeInTheDocument();
    expect(timing.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('00:30');
    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(store.getState().tracker.scheduledForecast).toMatchObject({
      target: 49_750,
      startsAt: NOW + MINUTE,
      expiresAt: NOW + 16 * MINUTE,
    });
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('schedules by end time with a fixed fifteen-minute window and a separate wait until start', async () => {
    const { store } = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 16 * MINUTE) },
    });

    expect(parseScheduledStart(screen.getByLabelText('Scheduled end (local time)').value)).toBe(
      NOW + 16 * MINUTE,
    );
    expect(store.getState().tracker.scheduledForecast).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    const schedule = store.getState().tracker.scheduledForecast;
    expect(schedule).toMatchObject({
      target: 49_750,
      startsAt: NOW + MINUTE,
      expiresAt: NOW + 16 * MINUTE,
      status: 'scheduled',
    });
    expect(store.getState().tracker.forecasts).toEqual([]);
    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByText(formatDateTime(NOW + MINUTE))).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + 16 * MINUTE))).toBeInTheDocument();
    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(timing.getByRole('timer', { name: 'Time until start' })).toHaveTextContent(/^01:00$/);

    act(() => jest.advanceTimersByTime(30_000));

    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(timing.getByRole('timer', { name: 'Time until start' })).toHaveTextContent(/^00:30$/);
    expect(store.getState().tracker.scheduledForecast).toEqual(schedule);
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('joins a selected end twelve minutes away immediately with the remaining model horizon', async () => {
    const { store } = renderTracker();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
      target: { value: '49750' },
    });
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 12 * MINUTE) },
    });
    const expected = getForecast({ ...market, target: 49_750, now: NOW, horizonMinutes: 12 });

    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^12:00$/);
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(store.getState().tracker.forecasts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));

    expect(store.getState().tracker.scheduledForecast).toBeNull();
    expect(store.getState().tracker.forecasts).toHaveLength(1);
    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      createdAt: NOW,
      startsAt: NOW - 3 * MINUTE,
      expiresAt: NOW + 12 * MINUTE,
      timingMode: 'end',
      target: 49_750,
      aboveProbability: expected.aboveProbability,
      belowProbability: expected.belowProbability,
      status: 'pending',
    });
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^12:00$/);
    expect(screen.queryByRole('timer', { name: 'Time until start' })).not.toBeInTheDocument();
    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByText(formatDateTime(NOW + 12 * MINUTE))).toBeInTheDocument();
  });

  test('updates an end-time preview as time passes and captures only the time still remaining', async () => {
    const { store, rerenderTracker } = renderTracker();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Target price' }), {
      target: { value: '49750' },
    });
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 12 * MINUTE) },
    });
    const initialEstimate = getForecast({
      ...market,
      target: 49_750,
      now: NOW,
      horizonMinutes: 12,
    });
    expect(
      getForecastPanel().getByRole('img', {
        name: `Above target ${formatPercent(initialEstimate.aboveProbability)}, below target ${formatPercent(initialEstimate.belowProbability)}`,
      }),
    ).toBeInTheDocument();

    act(() => jest.advanceTimersByTime(MINUTE));
    market = createMarket(Date.now());
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();
    const updatedEstimate = getForecast({
      ...market,
      target: 49_750,
      now: Date.now(),
      horizonMinutes: 11,
    });

    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^11:00$/);
    expect(
      getForecastPanel().getByRole('img', {
        name: `Above target ${formatPercent(updatedEstimate.aboveProbability)}, below target ${formatPercent(updatedEstimate.belowProbability)}`,
      }),
    ).toBeInTheDocument();
    expect(updatedEstimate.aboveProbability).not.toBe(initialEstimate.aboveProbability);
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));

    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      createdAt: NOW + MINUTE,
      startsAt: NOW - 3 * MINUTE,
      expiresAt: NOW + 12 * MINUTE,
      timingMode: 'end',
      aboveProbability: updatedEstimate.aboveProbability,
    });
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^11:00$/);
  });

  test('restores a joined end-time forecast without adding time to its deadline', async () => {
    const firstView = renderTracker();
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 12 * MINUTE) },
    });
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    const snapshot = firstView.store.getState().tracker.forecasts[0];
    firstView.unmount();

    jest.setSystemTime(NOW + MINUTE);
    market = createMarket(Date.now());
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const restored = renderTracker();

    expect(restored.store.getState().tracker.forecasts).toEqual([snapshot]);
    expect(restored.store.getState().tracker.forecasts[0]).toMatchObject({
      createdAt: NOW,
      startsAt: NOW - 3 * MINUTE,
      expiresAt: NOW + 12 * MINUTE,
      timingMode: 'end',
    });
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^11:00$/);
    expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
  });

  test('blocks joining an end-time window during an outage but allows a future window to be saved', async () => {
    quoteQuery = { ...quoteQuery, isError: true };
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled-end');
    const endInput = screen.getByLabelText('Scheduled end (local time)');
    fireEvent.change(endInput, { target: { value: formatLocalDateTime(NOW + 12 * MINUTE) } });

    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    fireEvent.submit(endInput.closest('form'));
    expect(store.getState().tracker.forecasts).toEqual([]);
    expect(store.getState().tracker.scheduledForecast).toBeNull();

    fireEvent.change(endInput, { target: { value: formatLocalDateTime(NOW + 16 * MINUTE) } });
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(store.getState().tracker.scheduledForecast).toMatchObject({
      startsAt: NOW + MINUTE,
      expiresAt: NOW + 16 * MINUTE,
    });
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('preserves a near end while switching modes without moving the original window', async () => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 12 * MINUTE) },
    });
    await chooseScheduleMode(user, 'scheduled');
    const startInput = screen.getByLabelText('Scheduled start (local time)');
    expect(parseScheduledStart(startInput.value)).toBe(NOW - 3 * MINUTE);
    expect(startInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeDisabled();

    await chooseScheduleMode(user, 'now');
    await chooseScheduleMode(user, 'scheduled-end');
    expect(parseScheduledStart(screen.getByLabelText('Scheduled end (local time)').value)).toBe(
      NOW + 12 * MINUTE,
    );
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^12:00$/);
    await user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(store.getState().tracker.forecasts[0]).toMatchObject({
      startsAt: NOW - 3 * MINUTE,
      expiresAt: NOW + 12 * MINUTE,
      timingMode: 'end',
    });
  });

  test.each([
    ['missing', '', 'Choose a valid local end date and time.'],
    ['in the past', formatLocalDateTime(NOW - MINUTE), 'End time must be in the future.'],
    ['the current time', formatLocalDateTime(NOW), 'End time must be in the future.'],
    [
      'beyond the maximum window',
      formatLocalDateTime(NOW + (24 * 60 + 16) * MINUTE),
      'Choose an end within the next 24 hours and 15 minutes.',
    ],
  ])(
    'rejects an end time that is %s without creating a schedule',
    async (_label, value, message) => {
      const { store } = renderTracker();
      await chooseScheduleMode(user, 'scheduled-end');
      const endInput = screen.getByLabelText('Scheduled end (local time)');
      fireEvent.change(endInput, { target: { value } });

      expect(endInput).toHaveAttribute('aria-invalid', 'true');
      expect(endInput).toHaveAccessibleDescription(expect.stringContaining(message));
      expect(screen.getByRole('button', { name: /^(Start|Schedule) forecast$/ })).toBeDisabled();
      fireEvent.submit(endInput.closest('form'));
      expect(store.getState().tracker.scheduledForecast).toBeNull();
      expect(store.getState().tracker.forecasts).toEqual([]);
    },
  );

  test('preserves the selected window when converting between start and end scheduling', async () => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled');
    fireEvent.change(screen.getByLabelText('Scheduled start (local time)'), {
      target: { value: formatLocalDateTime(NOW + 3 * MINUTE) },
    });

    await chooseScheduleMode(user, 'scheduled-end');
    const endInput = screen.getByLabelText('Scheduled end (local time)');
    expect(parseScheduledStart(endInput.value)).toBe(NOW + 18 * MINUTE);
    fireEvent.change(endInput, { target: { value: formatLocalDateTime(NOW + 20 * MINUTE) } });

    await chooseScheduleMode(user, 'scheduled');
    expect(parseScheduledStart(screen.getByLabelText('Scheduled start (local time)').value)).toBe(
      NOW + 5 * MINUTE,
    );
    await chooseScheduleMode(user, 'now');
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    await chooseScheduleMode(user, 'scheduled-end');
    expect(parseScheduledStart(screen.getByLabelText('Scheduled end (local time)').value)).toBe(
      NOW + 20 * MINUTE,
    );
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    expect(store.getState().tracker.scheduledForecast).toMatchObject({
      startsAt: NOW + 5 * MINUTE,
      expiresAt: NOW + 20 * MINUTE,
      status: 'scheduled',
    });
  });

  test('rejects an expired end time at submission before the next clock render', async () => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled-end');
    const endInput = screen.getByLabelText('Scheduled end (local time)');
    fireEvent.change(endInput, { target: { value: formatLocalDateTime(NOW + 10_000) } });
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();

    jest.setSystemTime(NOW + 10_000);
    fireEvent.submit(endInput.closest('form'));

    expect(store.getState().tracker.scheduledForecast).toBeNull();
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('restores a schedule chosen by end time without shifting either boundary', async () => {
    const firstView = renderTracker();
    await chooseScheduleMode(user, 'scheduled-end');
    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value: formatLocalDateTime(NOW + 16 * MINUTE) },
    });
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    const savedSchedule = firstView.store.getState().tracker.scheduledForecast;
    firstView.unmount();

    jest.setSystemTime(NOW + 30_000);
    market = createMarket(Date.now());
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const restoredView = renderTracker();

    expect(restoredView.store.getState().tracker.scheduledForecast).toEqual(savedSchedule);
    expect(restoredView.store.getState().tracker.scheduledForecast).toMatchObject({
      startsAt: NOW + MINUTE,
      expiresAt: NOW + 16 * MINUTE,
    });
    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByText(formatDateTime(NOW + MINUTE))).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + 16 * MINUTE))).toBeInTheDocument();
    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(timing.getByRole('timer', { name: 'Time until start' })).toHaveTextContent(/^00:30$/);
    expect(restoredView.store.getState().tracker.forecasts).toEqual([]);
  });

  test('cancels a scheduled start and allows a different local start time', async () => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    await user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));

    expect(screen.getByText('Ready to start')).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(store.getState().tracker.scheduledForecast).toBeNull();
    const startInput = screen.getByLabelText('Scheduled start (local time)');
    fireEvent.change(startInput, { target: { value: formatLocalDateTime(NOW + 2 * MINUTE) } });
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('02:00');
    expect(store.getState().tracker.scheduledForecast.startsAt).toBe(NOW + 2 * MINUTE);
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test.each([
    ['an empty date', '', 'Choose a valid local start date and time.'],
    ['a past date', formatLocalDateTime(NOW - MINUTE), 'Start time must be in the future.'],
    [
      'a date over 24 hours away',
      formatLocalDateTime(NOW + 24 * 60 * MINUTE + MINUTE),
      'Choose a start within the next 24 hours.',
    ],
  ])('rejects %s without creating a schedule', async (_label, value, message) => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled');
    const startInput = screen.getByLabelText('Scheduled start (local time)');
    fireEvent.change(startInput, { target: { value } });

    expect(startInput).toHaveAttribute('aria-invalid', 'true');
    expect(startInput).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeDisabled();
    fireEvent.submit(startInput.closest('form'));
    expect(store.getState().tracker.scheduledForecast).toBeNull();
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('disables a selected future date once its start passes without being scheduled', async () => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();

    act(() => jest.advanceTimersByTime(MINUTE));

    expect(screen.getByText('Start time must be in the future.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeDisabled();
    expect(store.getState().tracker.scheduledForecast).toBeNull();
  });

  test('rechecks the chosen start when submitting before the next clock render', async () => {
    const { store } = renderTracker();
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    const startInput = screen.getByLabelText('Scheduled start (local time)');

    jest.setSystemTime(NOW + MINUTE);
    fireEvent.submit(startInput.closest('form'));

    expect(store.getState().tracker.scheduledForecast).toBeNull();
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('allows a future schedule while the current feed is unavailable without recording an estimate', async () => {
    quoteQuery = { ...quoteQuery, isError: true };
    const { store } = renderTracker();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    expect(screen.getByText('Scheduled forecast')).toBeInTheDocument();
    expect(
      getForecastPanel().getByRole('img', { name: 'Above target —, below target —' }),
    ).toBeInTheDocument();
    expect(store.getState().tracker.scheduledForecast).toMatchObject({ status: 'scheduled' });
    expect(store.getState().tracker.forecasts).toEqual([]);
  });

  test('captures new data after the chosen start using the saved target and original deadline', async () => {
    const { store, rerenderTracker } = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    expect(screen.getByRole('heading', { name: 'Likely above' })).toBeInTheDocument();
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(targetInput).toBeEnabled();
    await user.clear(targetInput);
    await user.type(targetInput, '50250');

    act(() => jest.advanceTimersByTime(MINUTE));
    expect(screen.getByText('Waiting for start data')).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Start window remaining' })).toHaveTextContent(
      '00:15',
    );
    expect(quoteQuery.refetch).toHaveBeenCalledTimes(1);
    expect(candleQuery.refetch).toHaveBeenCalledTimes(1);
    expect(store.getState().tracker.forecasts).toEqual([]);

    act(() => jest.advanceTimersByTime(5000));
    market = createMarket(Date.now(), 49_700);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    rerenderTracker();

    const [snapshot] = store.getState().tracker.forecasts;
    expect(snapshot).toMatchObject({
      id: 'recorded-forecast-1',
      startsAt: NOW + MINUTE,
      createdAt: NOW + MINUTE + 5000,
      expiresAt: NOW + 16 * MINUTE,
      target: 49_750,
      price: 49_700,
      direction: 'below',
      status: 'pending',
    });
    expect(snapshot.aboveProbability).toBeGreaterThan(0.3);
    expect(snapshot.aboveProbability).toBeLessThan(0.5);
    expect(store.getState().tracker.scheduledForecast).toBeNull();
    expect(targetInput).toHaveValue(50_250);
    expectFixedPrediction(snapshot);
    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByText('Countdown running')).toBeInTheDocument();
    expect(timing.getByText('$49,750.00')).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + 16 * MINUTE))).toBeInTheDocument();
    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('14:55');
    const journal = within(screen.getByRole('region', { name: 'Forecast history' }));
    expect(journal.getByRole('rowheader')).toHaveTextContent('$49,750.00');
    expect(journal.getByText('Likely below')).toBeInTheDocument();
  });

  test('restores a future schedule after reload without moving its target or deadline', async () => {
    const firstView = renderTracker();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    await user.clear(targetInput);
    await user.type(targetInput, '49750');
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    const savedSchedule = firstView.store.getState().tracker.scheduledForecast;
    firstView.unmount();

    jest.setSystemTime(NOW + 30_000);
    market = createMarket(Date.now(), 50_100);
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const restoredView = renderTracker();

    expect(restoredView.store.getState().tracker.scheduledForecast).toEqual(savedSchedule);
    expect(restoredView.store.getState().tracker.forecasts).toEqual([]);
    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByText('$49,750.00')).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + MINUTE))).toBeInTheDocument();
    expect(timing.getByText(formatDateTime(NOW + 16 * MINUTE))).toBeInTheDocument();
    expect(timing.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('00:30');
    expect(screen.getByRole('button', { name: 'Start scheduled' })).toBeDisabled();
  });

  test('shows a missed start after reopening too late and lets the user dismiss it', async () => {
    const firstView = renderTracker();
    await chooseScheduleMode(user, 'scheduled');
    await user.click(screen.getByRole('button', { name: 'In 1 minute' }));
    await user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    firstView.unmount();

    jest.setSystemTime(NOW + MINUTE + 16_000);
    market = createMarket(Date.now());
    quoteQuery = createQuery(market.ticker);
    candleQuery = createQuery(market.candles);
    const restoredView = renderTracker();

    expect(screen.getByText('Scheduled start missed')).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('—');
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeInTheDocument();
    expect(restoredView.store.getState().tracker.forecasts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Dismiss missed start' }));

    expect(screen.getByText('Ready to start')).toBeInTheDocument();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(restoredView.store.getState().tracker.scheduledForecast).toBeNull();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
  });
});
