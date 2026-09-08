import { configureStore } from '@reduxjs/toolkit';
import { act, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import useFixedPrediction from '../hooks/useFixedPrediction';
import trackerReducer, { forecastRecorded } from '../state/slices/trackerSlice';
import { selectActiveForecast } from '../state/selectors/trackerSelectors';
import { getForecast } from '../utils/forecast.utils';
import {
  getFixedForecastAnalysis,
  getFixedPredictionProgress,
  updateConfirmationSamples,
} from '../utils/fixedPrediction.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 8, 12, 0);

function createMarket(now, price = 50_000) {
  const currentMinute = Math.floor(now / MINUTE) * MINUTE;
  return {
    candles: Array.from({ length: 120 }, (_, index) => ({
      time: currentMinute - (120 - index) * MINUTE,
      open: 50_000,
      close: index % 2 ? 50_020 : 49_980,
      low: 49_970,
      high: 50_030,
      volume: 10,
    })),
    ticker: { price, bid: price - 1, ask: price + 1, volume: 100, time: now, receivedAt: now },
  };
}

function renderObservation({
  target = 49_750,
  expiresAt = NOW + 15 * MINUTE,
  modelVersion = 'zero-drift-log-return-v1',
} = {}) {
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  const initial = {
    id: 'analysis-1',
    createdAt: NOW,
    startsAt: expiresAt - 15 * MINUTE,
    expiresAt,
    timingMode: 'end',
    target,
    price: 50_000,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion,
    status: 'analyzing',
    analysis: getFixedForecastAnalysis({ startedAt: NOW, expiresAt }),
  };
  store.dispatch(forecastRecorded(initial));
  const renderView = () =>
    renderHook(
      (props) => {
        const forecast = useSelector(selectActiveForecast);
        return useFixedPrediction({ ...props, forecast });
      },
      {
        initialProps: { ...createMarket(Date.now()), now: Date.now(), hasRequestError: false },
        wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
      },
    );
  let view = renderView();
  return {
    store,
    initial,
    result: () => view.result.current,
    update(elapsed, price = 50_000, overrides = {}) {
      act(() => {
        jest.setSystemTime(NOW + elapsed);
        view.rerender({
          ...createMarket(Date.now(), price),
          now: Date.now(),
          hasRequestError: false,
          ...overrides,
        });
      });
    },
    reload() {
      view.unmount();
      view = renderView();
    },
  };
}

describe('fixed prediction observation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  test('hides probabilities for three minutes, then publishes the remaining-horizon model once', () => {
    const view = renderObservation();
    for (let elapsed = 5000; elapsed < 3 * MINUTE; elapsed += 5000) view.update(elapsed);
    expect(view.store.getState().tracker.forecasts[0]).toEqual(view.initial);
    expect(view.result().phase).toBe('observing');
    view.update(3 * MINUTE);
    const published = view.store.getState().tracker.forecasts[0];
    const expected = getForecast({
      ...createMarket(NOW + 3 * MINUTE),
      target: view.initial.target,
      now: NOW + 3 * MINUTE,
      horizonMinutes: 12,
    });
    expect(published).toMatchObject({
      status: 'pending',
      createdAt: NOW + 3 * MINUTE,
      startsAt: NOW,
      expiresAt: NOW + 15 * MINUTE,
      target: 49_750,
      direction: 'above',
      aboveProbability: expected.aboveProbability,
      analysis: view.initial.analysis,
    });
    view.update(4 * MINUTE, 49_000);
    expect(view.store.getState().tracker.forecasts[0]).toEqual(published);
  });

  test('a direction reversal restarts confirmation without moving the deadline', () => {
    const view = renderObservation();
    for (let elapsed = 5000; elapsed <= 170_000; elapsed += 5000) view.update(elapsed);
    for (let elapsed = 175_000; elapsed < 235_000; elapsed += 5000) view.update(elapsed, 49_400);
    expect(view.store.getState().tracker.forecasts[0].status).toBe('analyzing');
    expect(view.result().phase).toBe('confirming');
    view.update(235_000, 49_400);
    expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
      direction: 'below',
      createdAt: NOW + 235_000,
      expiresAt: view.initial.expiresAt,
    });
  });

  test.each(['duplicate', 'feed-error', 'stale-history', 'gap'])(
    '%s observations cannot manufacture a sustained signal',
    (condition) => {
      const view = renderObservation();
      for (let elapsed = 5000; elapsed <= 150_000; elapsed += 5000) view.update(elapsed);
      if (condition === 'feed-error') view.update(155_000, 50_000, { hasRequestError: true });
      if (condition === 'stale-history')
        view.update(155_000, 50_000, { candles: createMarket(NOW).candles });
      if (condition === 'duplicate') {
        const unchanged = createMarket(NOW + 150_000).ticker;
        for (let elapsed = 155_000; elapsed <= 180_000; elapsed += 5000)
          view.update(elapsed, 50_000, { ticker: unchanged });
      }
      view.update(180_000);
      expect(view.store.getState().tracker.forecasts[0].status).toBe('analyzing');
      for (let elapsed = 185_000; elapsed <= 240_000; elapsed += 5000) view.update(elapsed);
      expect(view.store.getState().tracker.forecasts[0].status).toBe('pending');
    },
  );

  test('a reload requires a newly observed minute, even when the minimum wait has elapsed', () => {
    const view = renderObservation();
    for (let elapsed = 5000; elapsed <= 175_000; elapsed += 5000) view.update(elapsed);
    view.reload();
    view.update(180_000);
    expect(view.store.getState().tracker.forecasts[0].status).toBe('analyzing');
    for (let elapsed = 185_000; elapsed <= 235_000; elapsed += 5000) view.update(elapsed);
    expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
      status: 'pending',
      createdAt: NOW + 235_000,
      analysis: view.initial.analysis,
    });
  });

  test('does not publish an older quote against a previously established confirmation run', () => {
    const view = renderObservation();
    for (let elapsed = 5000; elapsed <= 175_000; elapsed += 5000) view.update(elapsed);
    const olderTicker = createMarket(NOW + 170_000, 50_100).ticker;
    view.update(180_000, 50_100, { ticker: olderTicker });
    expect(view.store.getState().tracker.forecasts[0].status).toBe('analyzing');
    expect(view.result().sampleCount).toBe(0);
  });

  test('never publishes current-model probabilities under a different saved model version', () => {
    const view = renderObservation({ modelVersion: 'previous-model-v0' });
    for (let elapsed = 5000; elapsed <= 300_000; elapsed += 5000) view.update(elapsed);
    expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
      status: 'withheld',
      aboveProbability: null,
      modelVersion: 'previous-model-v0',
      withholdingReason: 'model-unavailable',
    });
  });

  test('withholds a weak signal at five minutes and never revises it later', () => {
    const view = renderObservation({ target: 50_000 });
    for (let elapsed = 5000; elapsed <= 300_000; elapsed += 5000) view.update(elapsed);
    const withheld = view.store.getState().tracker.forecasts[0];
    expect(withheld).toMatchObject({ status: 'withheld', aboveProbability: null });
    view.update(330_000, 51_000);
    expect(view.store.getState().tracker.forecasts[0]).toEqual(withheld);
  });

  test('withholds on a stale resumed tab instead of creating a retrospective prediction', () => {
    const view = renderObservation();
    view.update(16 * MINUTE);
    expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
      status: 'withheld',
      withholdingReason: 'market-data-unavailable',
      createdAt: NOW,
    });
  });

  test('shortens the observation deadline for a late join while preserving a minute of lead', () => {
    const view = renderObservation({ expiresAt: NOW + 4 * MINUTE });
    expect(view.initial.analysis.deadline).toBe(NOW + 3 * MINUTE);
    for (let elapsed = 5000; elapsed <= 180_000; elapsed += 5000) view.update(elapsed);
    expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
      status: 'pending',
      startsAt: NOW - 11 * MINUTE,
      expiresAt: NOW + 4 * MINUTE,
    });
  });

  test.each([30_000, 180_000, 239_999])(
    'declines immediately with only %sms remaining, without changing the endpoint',
    (remaining) => {
      const view = renderObservation({ expiresAt: NOW + remaining });
      expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
        status: 'withheld',
        withholdingReason: 'insufficient-time',
        expiresAt: NOW + remaining,
      });
    },
  );
});

test('repeated trades and densely repeated clock ticks do not count as new evidence', () => {
  const first = { time: NOW, quoteTime: NOW, direction: 'above' };
  let samples = [first];
  for (let elapsed = 1000; elapsed <= 60_000; elapsed += 1000)
    samples = updateConfirmationSamples(samples, { ...first, time: NOW + elapsed });
  expect(samples).toEqual([first]);
  const progress = getFixedPredictionProgress({
    analysis: getFixedForecastAnalysis({ startedAt: NOW - 180_000, expiresAt: NOW + 60_000 }),
    samples,
    estimate: { available: true, aboveProbability: 0.9, belowProbability: 0.1 },
    now: NOW,
  });
  expect(progress.phase).toBe('withheld');
});
