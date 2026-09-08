import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import useScheduledForecast from '../hooks/useScheduledForecast';
import trackerReducer, { scheduleCancelled, scheduleCreated } from '../state/slices/trackerSlice';
import { getForecast } from '../utils/forecast.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 15);
const STARTS_AT = NOW + MINUTE;

function createMarket(now) {
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
      price: 50_000,
      bid: 49_999,
      ask: 50_001,
      volume: 1000,
      time: now,
      receivedAt: now,
    },
  };
}

function renderScheduledForecast(overrides = {}) {
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  const schedule = {
    id: 'scheduled-forecast-1',
    createdAt: NOW,
    startsAt: STARTS_AT,
    expiresAt: STARTS_AT + 15 * MINUTE,
    target: 50_100,
    status: 'scheduled',
  };
  store.dispatch(scheduleCreated(schedule));
  let props = {
    ...createMarket(NOW),
    now: NOW,
    isReady: true,
    hasRequestError: false,
    refetchTicker: jest.fn(),
    refetchCandles: jest.fn(),
    ...overrides,
  };
  const view = renderHook((hookProps) => useScheduledForecast(hookProps), {
    initialProps: props,
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });

  return {
    ...view,
    store,
    schedule,
    refetchTicker: props.refetchTicker,
    refetchCandles: props.refetchCandles,
    update(nextProps) {
      props = { ...props, ...nextProps };
      if (nextProps.now !== undefined) jest.setSystemTime(nextProps.now);
      view.rerender(props);
    },
  };
}

describe('scheduled forecast capture', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('waits until the selected start, refreshes once, and captures a new market quote', () => {
    const view = renderScheduledForecast();
    view.update({ now: STARTS_AT - 1 });

    expect(view.store.getState().tracker.scheduledForecast).toEqual(view.schedule);
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.refetchTicker).not.toHaveBeenCalled();
    expect(view.refetchCandles).not.toHaveBeenCalled();

    view.update({ now: STARTS_AT });
    expect(view.refetchTicker).toHaveBeenCalledTimes(1);
    expect(view.refetchCandles).toHaveBeenCalledTimes(1);
    expect(view.store.getState().tracker.forecasts).toEqual([]);

    view.update({ now: STARTS_AT + 1000 });
    view.update({ ...createMarket(STARTS_AT + 1000) });

    const [forecast] = view.store.getState().tracker.forecasts;
    expect(view.store.getState().tracker.scheduledForecast).toBeNull();
    expect(forecast).toMatchObject({
      id: view.schedule.id,
      createdAt: STARTS_AT + 1000,
      startsAt: STARTS_AT,
      expiresAt: STARTS_AT + 15 * MINUTE,
      price: 50_000,
      target: view.schedule.target,
      status: 'pending',
    });
    view.update({ ...createMarket(STARTS_AT + 2000), now: STARTS_AT + 2000 });
    expect(view.store.getState().tracker.forecasts).toEqual([forecast]);
    expect(view.refetchTicker).toHaveBeenCalledTimes(1);
    expect(view.refetchCandles).toHaveBeenCalledTimes(1);
  });

  test.each(['time', 'receivedAt'])(
    'requires quote %s at or after the start even when the quote is otherwise fresh',
    (field) => {
      const view = renderScheduledForecast();
      const market = createMarket(STARTS_AT);
      view.update({
        ...market,
        ticker: { ...market.ticker, [field]: STARTS_AT - 1 },
        now: STARTS_AT,
      });

      expect(view.store.getState().tracker.forecasts).toEqual([]);
      expect(view.store.getState().tracker.scheduledForecast.status).toBe('scheduled');

      view.update(market);
      expect(view.store.getState().tracker.forecasts).toHaveLength(1);
      expect(view.store.getState().tracker.forecasts[0].createdAt).toBe(STARTS_AT);
    },
  );

  test.each(['invalid', 'stale', 'missing'])(
    'waits for valid completed history when the initial history is %s',
    (condition) => {
      const view = renderScheduledForecast();
      const market = createMarket(STARTS_AT);
      let candles = market.candles;
      if (condition === 'invalid') {
        candles = candles.map((candle, index) =>
          index === 40 ? { ...candle, close: NaN } : candle,
        );
      } else if (condition === 'stale') {
        candles = candles.map((candle) => ({ ...candle, time: candle.time - 3 * MINUTE }));
      } else {
        candles = undefined;
      }
      view.update({ ...market, candles, now: STARTS_AT });

      expect(view.store.getState().tracker.forecasts).toEqual([]);
      expect(view.store.getState().tracker.scheduledForecast.status).toBe('scheduled');

      view.update({ candles: market.candles });
      expect(view.store.getState().tracker.forecasts).toHaveLength(1);
      expect(view.store.getState().tracker.scheduledForecast).toBeNull();
    },
  );

  test('waits for a failed market request to recover before using cached values', () => {
    const view = renderScheduledForecast();
    view.update({ ...createMarket(STARTS_AT), now: STARTS_AT, hasRequestError: true });

    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.refetchTicker).toHaveBeenCalledTimes(1);
    expect(view.refetchCandles).toHaveBeenCalledTimes(1);

    view.update({ hasRequestError: false });
    expect(view.store.getState().tracker.forecasts).toHaveLength(1);
  });

  test.each([12_000, 15_000])(
    'captures %s milliseconds late with the remaining horizon and the original deadline',
    (delay) => {
      const view = renderScheduledForecast();
      const capturedAt = STARTS_AT + delay;
      const market = createMarket(capturedAt);
      const expectedForecast = getForecast({
        ...market,
        target: view.schedule.target,
        now: capturedAt,
        horizonMinutes: (view.schedule.expiresAt - capturedAt) / MINUTE,
      });
      const fullForecast = getForecast({
        ...market,
        target: view.schedule.target,
        now: capturedAt,
      });
      view.update({ ...market, now: capturedAt });

      const [forecast] = view.store.getState().tracker.forecasts;
      expect(expectedForecast.available).toBe(true);
      expect(forecast).toMatchObject({
        createdAt: capturedAt,
        startsAt: STARTS_AT,
        expiresAt: view.schedule.expiresAt,
        aboveProbability: expectedForecast.aboveProbability,
        belowProbability: expectedForecast.belowProbability,
        direction: expectedForecast.direction,
      });
      expect(forecast.expiresAt - forecast.startsAt).toBe(15 * MINUTE);
      expect(forecast.expiresAt - forecast.createdAt).toBe(15 * MINUTE - delay);
      expect(forecast.aboveProbability).toBeLessThan(fullForecast.aboveProbability);
    },
  );

  test.each([15_001, 20 * MINUTE])(
    'marks a start missed after a %s millisecond delay without recording a late forecast',
    (delay) => {
      const view = renderScheduledForecast();
      view.update({ ...createMarket(STARTS_AT + delay), now: STARTS_AT + delay });

      expect(view.store.getState().tracker.scheduledForecast).toEqual({
        ...view.schedule,
        status: 'missed',
      });
      expect(view.store.getState().tracker.forecasts).toEqual([]);
      expect(view.refetchTicker).not.toHaveBeenCalled();
      expect(view.refetchCandles).not.toHaveBeenCalled();
    },
  );

  test('marks a start missed if usable data never arrives during the grace period', () => {
    const view = renderScheduledForecast();
    view.update({ now: STARTS_AT });
    view.update({ now: STARTS_AT + 15_000 });
    expect(view.store.getState().tracker.scheduledForecast.status).toBe('scheduled');

    view.update({ ...createMarket(STARTS_AT + 15_001), now: STARTS_AT + 15_001 });
    expect(view.store.getState().tracker.scheduledForecast.status).toBe('missed');
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.refetchTicker).toHaveBeenCalledTimes(1);
    expect(view.refetchCandles).toHaveBeenCalledTimes(1);
  });

  test('uses the actual capture time when a rendered clock is behind a resumed tab', () => {
    const view = renderScheduledForecast();
    jest.setSystemTime(STARTS_AT + 15_001);
    view.update(createMarket(STARTS_AT));

    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.store.getState().tracker.scheduledForecast.status).toBe('missed');
  });

  test('cancelling a waiting schedule prevents capture when the selected start arrives', () => {
    const view = renderScheduledForecast();
    act(() => view.store.dispatch(scheduleCancelled()));
    view.update({ ...createMarket(STARTS_AT), now: STARTS_AT });

    expect(view.store.getState().tracker.scheduledForecast).toBeNull();
    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.refetchTicker).not.toHaveBeenCalled();
    expect(view.refetchCandles).not.toHaveBeenCalled();
  });

  test('cancelling while waiting for start data prevents an in-flight response from capturing', () => {
    const view = renderScheduledForecast();
    view.update({ now: STARTS_AT });
    act(() => view.store.dispatch(scheduleCancelled()));
    view.update({ ...createMarket(STARTS_AT + 1000), now: STARTS_AT + 1000 });

    expect(view.store.getState().tracker.scheduledForecast).toBeNull();
    expect(view.store.getState().tracker.forecasts).toEqual([]);
  });

  test('waits for journal initialization before refreshing or capturing', () => {
    const view = renderScheduledForecast({ isReady: false });
    view.update({ ...createMarket(STARTS_AT), now: STARTS_AT });

    expect(view.store.getState().tracker.forecasts).toEqual([]);
    expect(view.refetchTicker).not.toHaveBeenCalled();
    expect(view.refetchCandles).not.toHaveBeenCalled();

    view.update({ isReady: true });
    expect(view.store.getState().tracker.forecasts).toHaveLength(1);
    expect(view.refetchTicker).toHaveBeenCalledTimes(1);
    expect(view.refetchCandles).toHaveBeenCalledTimes(1);
  });
});
