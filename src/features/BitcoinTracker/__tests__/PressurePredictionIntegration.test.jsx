import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import useFixedPrediction from '../hooks/useFixedPrediction';
import trackerReducer, { forecastRecorded } from '../state/slices/trackerSlice';
import { selectActiveForecast } from '../state/selectors/trackerSelectors';
import { getForecast } from '../utils/forecast.utils';
import { getPressureForecast, PRESSURE_MODEL_VERSION } from '../utils/pressureForecast.utils';
import {
  getFixedForecastAnalysis,
  MARKET_AWARE_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import { DEADLINE_OUTCOME_DEFINITION } from '../utils/outcome.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 8, 12, 0);

function createMarket(now, condition) {
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const moves = Array.from(
    { length: 120 },
    (_, index) =>
      (index % 2 ? 1 : -1) *
      (condition === 'volatility-expansion' && index >= 115 ? 0.005 : 0.0002),
  );
  let price = 50_000 / Math.exp(moves.reduce((sum, value) => sum + value, 0));
  const candles = moves.map((move, index) => {
    const open = price;
    price *= Math.exp(move);
    return {
      time: minute - (120 - index) * MINUTE,
      open,
      close: price,
      high: Math.max(open, price) * 1.000001,
      low: Math.min(open, price) * 0.999999,
      volume: 10,
    };
  });
  if (condition === 'current-jump') price *= 1.02;
  const ticker = { price, bid: price - 1, ask: price + 1, volume: 100, time: now, receivedAt: now };
  if (condition === 'wide-spread') {
    ticker.bid = price * 0.99;
    ticker.ask = price * 1.01;
  }
  if (condition === 'stale-quote') ticker.time -= 30_000;
  if (condition === 'missing-history') candles.splice(40, 1);
  return { ticker, candles };
}

function createStream(now, signedRate = 0, condition) {
  const completeSince = now - 240_000;
  const lastBucketEnd = Math.floor(now / 15_000) * 15_000;
  const samples = Array.from({ length: 12 }, (_, index) => {
    const signedBtc = index % 2 ? 2 : -2;
    return {
      startAt: lastBucketEnd - (12 - index) * 15_000,
      endAt: lastBucketEnd - (11 - index) * 15_000,
      startPrice: 50_000,
      endPrice: 50_000 * Math.exp(signedBtc * 0.00005),
      buyBtc: 2 + signedBtc / 2,
      sellBtc: 2 - signedBtc / 2,
      tradeCount: 20,
    };
  });
  const stream = {
    status: 'live',
    quality: { available: true, heartbeatAt: now, completeSince, confirmedThrough: now },
    flow: {
      available: true,
      impact: {
        available: true,
        asOf: now,
        completeSince,
        confirmedThrough: now,
        bucketSeconds: 15,
        samples,
      },
      windows: Object.fromEntries(
        [15, 60, 180].map((seconds) => {
          const totalBtc = (20 * seconds) / 60;
          const signedBtc = (signedRate * seconds) / 60;
          return [
            seconds,
            {
              available: true,
              tradeCount: 100,
              totalBtc,
              signedBtc,
              buyBtc: (totalBtc + signedBtc) / 2,
              sellBtc: (totalBtc - signedBtc) / 2,
              imbalance: signedBtc / totalBtc,
            },
          ];
        }),
      ),
    },
    liquidity: {
      available: true,
      bid: 49_999,
      ask: 50_001,
      midpoint: 50_000,
      depth: { 10: { bidBtc: 50, askBtc: 50, totalBtc: 100, imbalance: 0 } },
      depthChange60: { available: true, totalFraction: 0 },
    },
  };
  if (condition === 'missing-book') stream.liquidity = { available: false };
  if (condition === 'depth-collapse') stream.liquidity.depthChange60.totalFraction = -0.9;
  if (condition === 'missing-flow') stream.flow = { available: false };
  if (condition === 'disconnected-stream') {
    stream.status = 'disconnected';
    stream.quality.available = false;
  }
  return stream;
}

function createProps(now, { condition, signedRate = 0 } = {}) {
  return {
    ...createMarket(now, condition),
    stream: createStream(now, signedRate, condition),
    now,
    hasRequestError: false,
  };
}

function renderObservation({
  target = createMarket(NOW).ticker.price * 0.99999,
  expiresAt = NOW + 15 * MINUTE,
  policyVersion = PRESSURE_POLICY_VERSION,
  elapsed = 0,
  market = {},
} = {}) {
  jest.setSystemTime(NOW + elapsed);
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  const initial = {
    id: 'pressure-observation',
    createdAt: NOW,
    startsAt: expiresAt - 15 * MINUTE,
    expiresAt,
    timingMode: 'end',
    target,
    price: createMarket(NOW).ticker.price,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion:
      policyVersion === PRESSURE_POLICY_VERSION
        ? PRESSURE_MODEL_VERSION
        : 'zero-drift-log-return-v1',
    ...(policyVersion === PRESSURE_POLICY_VERSION ? { calculationMode: null } : {}),
    status: 'analyzing',
    analysis: getFixedForecastAnalysis({ startedAt: NOW, expiresAt, policyVersion }),
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  };
  store.dispatch(forecastRecorded(initial));
  expect(store.getState().tracker.forecasts[0]).toEqual(initial);
  const view = renderHook(
    (props) => {
      const forecast = useSelector(selectActiveForecast);
      return useFixedPrediction({ ...props, forecast });
    },
    {
      initialProps: createProps(Date.now(), market),
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    },
  );
  return {
    initial,
    store,
    result: view.result,
    recorded: () => store.getState().tracker.forecasts[0],
    update(nextElapsed, nextMarket = market, overrides = {}) {
      act(() => {
        jest.setSystemTime(NOW + nextElapsed);
        view.rerender({ ...createProps(Date.now(), nextMarket), ...overrides });
      });
    },
  };
}

describe('pressure snapshot publication with the real model and Redux journal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test('publishes a slight lean at three minutes without requiring a consensus minute', () => {
    const view = renderObservation({ market: { condition: 'missing-flow' } });
    view.update(3 * MINUTE - 1);
    expect(view.recorded()).toEqual(view.initial);
    view.update(3 * MINUTE);
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      createdAt: NOW + 3 * MINUTE,
      expiresAt: view.initial.expiresAt,
      direction: 'above',
      calculationMode: 'baseline-fallback',
      modelVersion: PRESSURE_MODEL_VERSION,
    });
    expect(view.recorded().aboveProbability).toBeGreaterThan(0.5);
    expect(view.recorded().aboveProbability).toBeLessThan(0.55);
    expect(view.recorded().analysis.policyVersion).toBe('pressure-snapshot-v3');
  });

  test('publishes a balanced 50/50 snapshot instead of withholding for weak direction', () => {
    const view = renderObservation({
      target: createMarket(NOW).ticker.price,
      market: { condition: 'missing-flow' },
    });
    view.update(3 * MINUTE);
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      direction: 'neutral',
      aboveProbability: 0.5,
      belowProbability: 0.5,
      calculationMode: 'baseline-fallback',
    });
  });

  test('fixes the current pressure-adjusted probability even after pressure reverses just before capture', () => {
    const target = createMarket(NOW).ticker.price;
    const view = renderObservation({ target, market: { signedRate: 18 } });
    view.update(175_000, { signedRate: 18 });
    const buying = getPressureForecast({
      ...createProps(Date.now(), { signedRate: 18 }),
      target,
      horizonMinutes: (view.initial.expiresAt - Date.now()) / MINUTE,
    });
    expect(buying.direction).toBe('above');
    view.update(3 * MINUTE, { signedRate: -18 });
    const selling = getPressureForecast({
      ...createProps(Date.now(), { signedRate: -18 }),
      target,
      horizonMinutes: 12,
    });
    expect(selling.pressure.applied).toBe(true);
    expect(selling.direction).toBe('below');
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      createdAt: NOW + 3 * MINUTE,
      direction: 'below',
      aboveProbability: selling.aboveProbability,
      belowProbability: selling.belowProbability,
      calculationMode: 'pressure-adjusted',
    });
  });

  test.each([
    'volatility-expansion',
    'current-jump',
    'wide-spread',
    'missing-book',
    'depth-collapse',
    'disconnected-stream',
  ])('%s does not independently veto a valid new estimate', (condition) => {
    const view = renderObservation({ market: { condition, signedRate: -18 } });
    view.update(3 * MINUTE);
    const expected = getPressureForecast({
      ...createProps(Date.now(), { condition, signedRate: -18 }),
      target: view.initial.target,
      horizonMinutes: 12,
    });
    expect(expected.available).toBe(true);
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      aboveProbability: expected.aboveProbability,
      belowProbability: expected.belowProbability,
      expiresAt: view.initial.expiresAt,
    });
  });

  test('stale essential data delays capture only until fresh data returns before the cutoff', () => {
    const view = renderObservation({ market: { condition: 'stale-quote' } });
    view.update(3 * MINUTE);
    expect(view.recorded().status).toBe('analyzing');
    view.update(3 * MINUTE + 5000, {});
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      createdAt: NOW + 185_000,
      expiresAt: view.initial.expiresAt,
    });
  });

  test.each(['missing-flow', 'unusable-fit'])(
    '%s retains responsive uncertainty when recent volatility expands',
    (condition) => {
      const view = renderObservation({
        target: 49_900,
        market: { condition: 'volatility-expansion' },
      });
      const captureTime = NOW + 3 * MINUTE;
      const props = createProps(captureTime, { condition: 'volatility-expansion' });
      if (condition === 'missing-flow') props.stream.flow = { available: false };
      else
        props.stream.flow.impact.samples.forEach((sample) => {
          sample.endPrice = sample.startPrice;
        });
      view.update(3 * MINUTE, {}, props);
      const inputs = { ...props, target: view.initial.target, horizonMinutes: 12 };
      const legacyBaseline = getForecast(inputs);
      const estimate = getPressureForecast(inputs);
      expect(estimate.available).toBe(true);
      expect(estimate.pressure.applied).toBe(false);
      expect(estimate.aboveProbability).toBeGreaterThan(0.5);
      expect(estimate.aboveProbability).toBeLessThan(legacyBaseline.aboveProbability);
      expect(estimate.upperBound - estimate.lowerBound).toBeGreaterThan(
        legacyBaseline.upperBound - legacyBaseline.lowerBound,
      );
      expect(view.recorded()).toMatchObject({
        status: 'pending',
        calculationMode: 'baseline-fallback',
        aboveProbability: estimate.aboveProbability,
        belowProbability: estimate.belowProbability,
      });
    },
  );

  test.each(['stale-quote', 'missing-history'])(
    '%s through the cutoff creates a permanent unscored no-call',
    (condition) => {
      const view = renderObservation({ market: { condition } });
      view.update(3 * MINUTE);
      expect(view.recorded().status).toBe('analyzing');
      view.update(5 * MINUTE);
      const withheld = view.recorded();
      expect(withheld).toMatchObject({
        status: 'withheld',
        aboveProbability: null,
        belowProbability: null,
        calculationMode: null,
        withholdingReason: 'market-data-unavailable',
      });
      view.update(5 * MINUTE + 5000, {});
      expect(view.recorded()).toEqual(withheld);
    },
  );

  test('the saved snapshot stays unchanged through later opposite pressure and data failure', () => {
    const view = renderObservation({ market: { signedRate: 18 } });
    view.update(3 * MINUTE);
    const saved = view.recorded();
    expect(saved.status).toBe('pending');
    view.update(4 * MINUTE, { signedRate: -18 });
    view.update(5 * MINUTE, { condition: 'stale-quote' }, { hasRequestError: true });
    expect(view.recorded()).toEqual(saved);
  });

  test('a restored observing window uses its saved earliest time and fresh inputs without an extra consensus delay', () => {
    const view = renderObservation({ elapsed: 200_000, market: { condition: 'missing-flow' } });
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      createdAt: NOW + 200_000,
      expiresAt: NOW + 15 * MINUTE,
    });
    expect(view.recorded().analysis).toEqual(view.initial.analysis);
  });

  test('a joined window can publish at its original cutoff with exactly one minute left', () => {
    const view = renderObservation({ expiresAt: NOW + 4 * MINUTE });
    view.update(3 * MINUTE);
    expect(view.recorded()).toMatchObject({
      status: 'pending',
      createdAt: NOW + 3 * MINUTE,
      expiresAt: NOW + 4 * MINUTE,
    });
    expect(view.recorded().analysis.deadline).toBe(NOW + 3 * MINUTE);
  });

  test('legacy v2 still withholds a weak baseline under its original consensus rule', () => {
    const view = renderObservation({ policyVersion: MARKET_AWARE_POLICY_VERSION });
    for (let elapsed = 5000; elapsed <= 3 * MINUTE; elapsed += 5000) view.update(elapsed);
    expect(view.recorded().status).toBe('analyzing');
    view.update(5 * MINUTE);
    expect(view.recorded()).toMatchObject({
      status: 'withheld',
      modelVersion: 'zero-drift-log-return-v1',
      aboveProbability: null,
    });
    expect(view.recorded()).not.toHaveProperty('calculationMode');
  });

  test('legacy v2 still vetoes adverse flow despite a strong baseline probability', () => {
    const view = renderObservation({
      policyVersion: MARKET_AWARE_POLICY_VERSION,
      target: 49_750,
      market: { signedRate: -18 },
    });
    view.update(3 * MINUTE);
    const baseline = getForecast({
      ...createProps(Date.now()),
      target: 49_750,
      horizonMinutes: 12,
    });
    expect(baseline.aboveProbability).toBeGreaterThan(0.65);
    expect(view.recorded().status).toBe('analyzing');
    view.update(5 * MINUTE);
    expect(view.recorded()).toMatchObject({
      status: 'withheld',
      withholdingReason: 'market-conditions',
      aboveProbability: null,
    });
  });
});
