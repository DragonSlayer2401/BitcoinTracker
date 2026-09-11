import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import useKalshiSchedule from '../hooks/useKalshiSchedule';
import trackerReducer, {
  forecastRecorded,
  scheduleCreated,
  scheduleCancelled,
  scheduledForecastStarted,
  scheduleStartMissed,
} from '../state/slices/trackerSlice';
import { getValidatedScheduledForecast, loadJournal, saveJournal } from '../utils/journal.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import { getKalshiContract, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('../utils/researchForecast.utils', () => ({ getResearchForecast: jest.fn() }));

const START = Date.UTC(2026, 8, 10, 12, 15);
const NOW = START - 60_000;
const END = START + 900_000;
const contract = {
  ticker: 'KXBTC15M-26SEP100830-30',
  eventTicker: 'KXBTC15M-26SEP100830',
  seriesTicker: 'KXBTC15M',
  target: 77_125.62,
  startsAt: START,
  expiresAt: END,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
};
const schedule = {
  id: 'kalshi-scheduled',
  createdAt: NOW,
  startsAt: START,
  expiresAt: END,
  target: null,
  status: 'scheduled',
  marketTicker: contract.ticker,
  eventTicker: contract.eventTicker,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  policyVersion: KALSHI_POLICY_VERSION,
};
const quote = (now) => ({
  price: 77_200,
  bid: 77_199,
  ask: 77_201,
  volume: 100,
  time: now,
  receivedAt: now,
});
const snapshot = (now = START, overrides = {}) => ({
  id: schedule.id,
  createdAt: now,
  startsAt: START,
  timingMode: 'end',
  expiresAt: END,
  price: 77_200,
  target: contract.target,
  aboveProbability: null,
  belowProbability: null,
  direction: 'neutral',
  modelVersion: KALSHI_MODEL_VERSION,
  status: 'analyzing',
  calculationMode: null,
  analysis: getFixedForecastAnalysis({
    startedAt: now,
    expiresAt: END,
    policyVersion: KALSHI_POLICY_VERSION,
  }),
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshiMarket: getKalshiContract(contract),
  kalshi: null,
  ...overrides,
});

function renderSchedule(overrides = {}) {
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  store.dispatch(scheduleCreated(schedule));
  let props = {
    markets: [{ ...contract, target: null, status: 'initialized' }],
    ticker: quote(NOW),
    candles: [],
    stream: {},
    models: { active: null, candidate: null },
    benchmark: null,
    now: NOW,
    isReady: true,
    hasRequestError: false,
    ...overrides,
  };
  const view = renderHook((input) => useKalshiSchedule(input), {
    initialProps: props,
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
  return {
    ...view,
    store,
    update(next) {
      props = { ...props, ...next };
      if (next.now !== undefined) jest.setSystemTime(next.now);
      view.rerender(props);
    },
  };
}

describe('arming actual future Kalshi events', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    localStorage.clear();
    getResearchForecast
      .mockReset()
      .mockReturnValue({ available: true, modelVersion: KALSHI_MODEL_VERSION });
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test('persists the event identity with no invented target and restores it after reload', () => {
    expect(getValidatedScheduledForecast(schedule)).toEqual(schedule);
    expect(saveJournal([], localStorage, schedule)).toBeNull();
    expect(loadJournal(localStorage)).toMatchObject({
      forecasts: [],
      scheduledForecast: schedule,
      warning: null,
    });
  });

  test.each([
    { target: 77_200 },
    { policyVersion: 'pressure-snapshot-v3' },
    { marketTicker: '../portfolio/orders' },
    { eventTicker: 'KXBTC15M-26SEP100845' },
    { startsAt: START + 1000, expiresAt: END + 1000 },
    { expiresAt: END + 1000 },
  ])('rejects a changed or invented scheduled contract: %j', (changes) => {
    expect(getValidatedScheduledForecast({ ...schedule, ...changes })).toBeNull();
  });

  test('waits for opening, the official target and fresh inputs then starts exactly once', () => {
    const view = renderSchedule();
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(getResearchForecast).not.toHaveBeenCalled();
    view.update({ now: START, ticker: quote(START) });
    expect(view.store.getState().tracker.scheduledForecast).toEqual(schedule);
    view.update({ now: START + 1000, markets: [contract], ticker: quote(START + 1000) });
    expect(view.store.getState().tracker.scheduledForecast).toBeNull();
    expect(view.store.getState().tracker.forecasts).toEqual([snapshot(START + 1000)]);
    expect(getResearchForecast).toHaveBeenCalledWith(
      expect.objectContaining({
        target: contract.target,
        expiresAt: END,
        kalshiMarket: getKalshiContract(contract),
      }),
      expect.any(Object),
      START,
    );
    view.update({ now: START + 2000, ticker: quote(START + 2000) });
    expect(view.store.getState().tracker.forecasts).toHaveLength(1);
  });

  test('waits through an opening outage and starts later without extending the event', () => {
    const view = renderSchedule();
    view.update({
      now: START + 90_000,
      markets: [contract],
      ticker: quote(START + 90_000),
      hasRequestError: true,
    });
    expect(view.store.getState().tracker.scheduledForecast.status).toBe('scheduled');
    view.update({ now: START + 180_000, ticker: quote(START + 180_000), hasRequestError: false });
    expect(view.store.getState().tracker.forecasts).toEqual([snapshot(START + 180_000)]);
  });

  test('rejects stale pre-opening quotes and unsupported or mismatched market metadata', () => {
    const view = renderSchedule();
    view.update({ now: START + 1000, markets: [contract], ticker: quote(START - 1) });
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    view.update({ ticker: quote(START + 1000), markets: [{ ...contract, rulesVerified: false }] });
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    view.update({
      markets: [{ ...contract, startsAt: START + 900_000, expiresAt: END + 900_000 }],
    });
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(getResearchForecast).not.toHaveBeenCalled();
  });

  test('allows a late reconnect with twenty seconds left but marks a later start missed', () => {
    const view = renderSchedule();
    view.update({ now: END - 20_000, markets: [contract], ticker: quote(END - 20_000) });
    expect(view.store.getState().tracker.forecasts).toEqual([snapshot(END - 20_000)]);
    view.unmount();
    jest.setSystemTime(NOW);
    const late = renderSchedule();
    late.update({ now: END - 19_999, markets: [contract], ticker: quote(END - 19_999) });
    expect(late.store.getState().tracker.forecasts).toEqual([]);
    expect(late.store.getState().tracker.scheduledForecast.status).toBe('missed');
  });

  test('keeps the schedule while the model is unavailable and respects cancellation', () => {
    const view = renderSchedule();
    getResearchForecast.mockReturnValue({ available: false });
    view.update({ now: START + 1000, markets: [contract], ticker: quote(START + 1000) });
    expect(view.store.getState().tracker.scheduledForecast).toEqual(schedule);
    act(() => view.store.dispatch(scheduleCancelled()));
    getResearchForecast.mockReturnValue({ available: true });
    view.update({ now: START + 2000, ticker: quote(START + 2000) });
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.store.getState().tracker.scheduledForecast).toBeNull();
  });

  test('the reducer independently rejects a different event and never starts over an active forecast', () => {
    const view = renderSchedule();
    const wrong = snapshot(START, {
      kalshiMarket: { ...getKalshiContract(contract), ticker: 'KXBTC15M-26SEP100830-99' },
    });
    act(() => view.store.dispatch(scheduledForecastStarted({ now: START, forecast: wrong })));
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    act(() => view.store.dispatch(scheduleStartMissed({ now: START + 16_000 })));
    expect(view.store.getState().tracker.scheduledForecast.status).toBe('scheduled');
    const freshStore = configureStore({ reducer: { tracker: trackerReducer } });
    freshStore.dispatch(forecastRecorded(snapshot(START)));
    freshStore.dispatch(scheduleCreated({ ...schedule, id: 'another-schedule' }));
    expect(freshStore.getState().tracker.scheduledForecast).toBeNull();
  });
});
