import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import useFixedPrediction from '../hooks/useFixedPrediction';
import trackerReducer, { forecastRecorded } from '../state/slices/trackerSlice';
import { selectActiveForecast } from '../state/selectors/trackerSelectors';
import { getForecast } from '../utils/forecast.utils';
import {
  getFixedForecastAnalysis,
  MARKET_AWARE_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import { DEADLINE_OUTCOME_DEFINITION } from '../utils/outcome.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 8, 12, 0);

function createMarket(now, moves = [-0.0002, 0.0002]) {
  const currentMinute = Math.floor(now / MINUTE) * MINUTE;
  const returns = Array.from({ length: 120 }, (_, index) => moves[index % moves.length]);
  let previousClose = 50_000 / Math.exp(returns.reduce((total, value) => total + value, 0));
  const candles = returns.map((move, index) => {
    const close = previousClose * Math.exp(move);
    const candle = {
      time: currentMinute - (120 - index) * MINUTE,
      open: previousClose,
      high: Math.max(previousClose, close) * 1.000001,
      low: Math.min(previousClose, close) * 0.999999,
      close,
      volume: 10,
    };
    previousClose = close;
    return candle;
  });
  return {
    candles,
    ticker: {
      price: previousClose,
      bid: previousClose - 1,
      ask: previousClose + 1,
      volume: 100,
      time: now,
      receivedAt: now,
    },
  };
}

function createStream() {
  return {
    status: 'live',
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
  };
}

function createProps(now, risk = null) {
  const market = createMarket(now, risk === 'steady-selloff' ? [-0.00052, -0.00048] : undefined);
  const stream = createStream();
  if (risk === 'current-jump') {
    market.ticker = { ...market.ticker, price: 51_000, bid: 50_999, ask: 51_001 };
  }
  if (risk === 'target-inside-spread') {
    market.ticker = { ...market.ticker, bid: 49_000, ask: 51_000 };
  }
  if (risk === 'target-inside-book-spread') {
    stream.liquidity = { ...stream.liquidity, bid: 49_700, ask: 49_800, midpoint: 49_750 };
  }
  if (risk === 'opposing-book-midpoint') {
    stream.liquidity = { ...stream.liquidity, bid: 49_699, ask: 49_701, midpoint: 49_700 };
  }
  if (risk === 'invalid-book-spread') stream.liquidity.bid = NaN;
  if (risk === 'incomplete-flow') {
    stream.flow.windows[180].available = false;
  }
  if (risk === 'adverse-flow') {
    Object.values(stream.flow.windows).forEach((window) => {
      window.imbalance = -0.9;
      window.buyBtc = 0.5;
      window.sellBtc = 9.5;
      window.signedBtc = -9;
    });
  }
  if (risk === 'depth-loss') stream.liquidity.depthChange60.totalFraction = -0.75;
  if (risk === 'unavailable-book') stream.liquidity.available = false;
  return { ...market, stream, now, hasRequestError: false };
}

function renderObservation({ risk = null, expiresAt = NOW + 15 * MINUTE } = {}) {
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  const initial = {
    id: 'market-aware-observation',
    createdAt: NOW,
    startsAt: expiresAt - 15 * MINUTE,
    expiresAt,
    timingMode: 'end',
    target: 49_750,
    price: 50_000,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion: 'zero-drift-log-return-v1',
    status: 'analyzing',
    analysis: getFixedForecastAnalysis({
      startedAt: NOW,
      expiresAt,
      policyVersion: MARKET_AWARE_POLICY_VERSION,
    }),
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  };
  store.dispatch(forecastRecorded(initial));
  const view = renderHook(
    (props) => {
      const forecast = useSelector(selectActiveForecast);
      return useFixedPrediction({ ...props, forecast });
    },
    {
      initialProps: createProps(NOW, risk),
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    },
  );
  return {
    initial,
    store,
    result: view.result,
    update(elapsed, nextRisk = risk, overrides = {}) {
      act(() => {
        jest.setSystemTime(NOW + elapsed);
        view.rerender({ ...createProps(Date.now(), nextRisk), ...overrides });
      });
    },
  };
}

describe('market-aware fixed publication', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test('publishes the unchanged baseline only after observation with complete, balanced market evidence', () => {
    const view = renderObservation();
    for (let elapsed = 5000; elapsed < 3 * MINUTE; elapsed += 5000) view.update(elapsed);
    expect(view.store.getState().tracker.forecasts[0]).toEqual(view.initial);
    view.update(3 * MINUTE);
    const snapshot = view.store.getState().tracker.forecasts[0];
    const expected = getForecast({
      ...createMarket(Date.now()),
      target: view.initial.target,
      now: Date.now(),
      horizonMinutes: 12,
    });
    expect(snapshot).toMatchObject({
      status: 'pending',
      createdAt: NOW + 3 * MINUTE,
      expiresAt: view.initial.expiresAt,
      direction: 'above',
      aboveProbability: expected.aboveProbability,
      belowProbability: expected.belowProbability,
      analysis: view.initial.analysis,
      outcomeDefinition: 'coinbase-last-trade-at-deadline-v1',
    });
    expect(snapshot.analysis.policyVersion).toBe('market-aware-consensus-v2');
  });

  test.each([
    ['current-jump', 'market-conditions'],
    ['steady-selloff', 'market-conditions'],
    ['target-inside-spread', 'market-conditions'],
    ['target-inside-book-spread', 'market-conditions'],
    ['opposing-book-midpoint', 'market-conditions'],
    ['invalid-book-spread', 'market-data-unavailable'],
    ['incomplete-flow', 'market-data-unavailable'],
    ['adverse-flow', 'market-conditions'],
    ['depth-loss', 'market-conditions'],
    ['unavailable-book', 'market-data-unavailable'],
  ])(
    'a strong probability cannot bypass %s and becomes an unscored no-call at the fixed cutoff',
    (risk, reason) => {
      const view = renderObservation({ risk });
      for (let elapsed = 5000; elapsed <= 3 * MINUTE; elapsed += 5000) view.update(elapsed);
      const props = createProps(Date.now(), risk);
      const estimate = getForecast({ ...props, target: view.initial.target, horizonMinutes: 12 });
      expect(estimate.available).toBe(true);
      expect(estimate.aboveProbability).toBeGreaterThanOrEqual(0.65);
      expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
        status: 'analyzing',
        aboveProbability: null,
        belowProbability: null,
      });
      expect(view.result.current.sampleCount).toBe(0);

      for (let elapsed = 185_000; elapsed <= 5 * MINUTE; elapsed += 5000) view.update(elapsed);
      const withheld = view.store.getState().tracker.forecasts[0];
      expect(withheld).toMatchObject({
        status: 'withheld',
        withholdingReason: reason,
        aboveProbability: null,
        belowProbability: null,
        target: view.initial.target,
        expiresAt: view.initial.expiresAt,
        outcomeDefinition: 'coinbase-last-trade-at-deadline-v1',
      });
      expect(withheld.correct).toBeUndefined();
      view.update(6 * MINUTE, null);
      expect(view.store.getState().tracker.forecasts[0]).toEqual(withheld);
    },
  );

  test.each(['current-jump', 'target-inside-book-spread'])(
    '%s clears the old confirmation and requires a complete fresh minute without extending the deadline',
    (risk) => {
      const view = renderObservation();
      for (let elapsed = 5000; elapsed <= 170_000; elapsed += 5000) view.update(elapsed);
      view.update(175_000, risk);
      expect(view.result.current.sampleCount).toBe(0);
      for (let elapsed = 180_000; elapsed < 240_000; elapsed += 5000) view.update(elapsed, null);
      expect(view.store.getState().tracker.forecasts[0].status).toBe('analyzing');
      view.update(240_000, null);
      expect(view.store.getState().tracker.forecasts[0]).toMatchObject({
        status: 'pending',
        createdAt: NOW + 240_000,
        startsAt: view.initial.startsAt,
        expiresAt: view.initial.expiresAt,
        analysis: view.initial.analysis,
        outcomeDefinition: view.initial.outcomeDefinition,
      });
    },
  );

  test('risk that clears too late cannot extend a joined window to accumulate confirmation', () => {
    const view = renderObservation({ risk: 'adverse-flow', expiresAt: NOW + 4 * MINUTE });
    for (let elapsed = 5000; elapsed <= 150_000; elapsed += 5000) view.update(elapsed);
    for (let elapsed = 155_000; elapsed <= 3 * MINUTE; elapsed += 5000) view.update(elapsed, null);
    const withheld = view.store.getState().tracker.forecasts[0];
    expect(withheld).toMatchObject({
      status: 'withheld',
      aboveProbability: null,
      expiresAt: NOW + 4 * MINUTE,
    });
    expect(withheld.analysis.deadline).toBe(NOW + 3 * MINUTE);
    view.update(210_000, null);
    expect(view.store.getState().tracker.forecasts[0]).toEqual(withheld);
  });

  test('a disconnected stream interrupts confirmation even while REST data remains fresh', () => {
    const view = renderObservation();
    for (let elapsed = 5000; elapsed <= 170_000; elapsed += 5000) view.update(elapsed);
    const disconnected = createStream();
    disconnected.quality = { available: false, reason: 'Trade stream sequence is incomplete.' };
    view.update(175_000, null, { stream: disconnected });
    expect(view.result.current.reason).toBe('Trade stream sequence is incomplete.');
    expect(view.result.current.sampleCount).toBe(0);
    for (let elapsed = 180_000; elapsed < 240_000; elapsed += 5000) view.update(elapsed);
    expect(view.store.getState().tracker.forecasts[0].status).toBe('analyzing');
    view.update(240_000);
    expect(view.store.getState().tracker.forecasts[0].status).toBe('pending');
  });
});
