import { configureStore } from '@reduxjs/toolkit';
import { cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import useFixedPrediction from '../hooks/useFixedPrediction';
import useKalshiSchedule from '../hooks/useKalshiSchedule';
import reducer, { forecastRecorded, scheduleCreated } from '../state/slices/trackerSlice';
import { selectActiveForecast } from '../state/selectors/trackerSelectors';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getKalshiMarketConditions } from '../utils/kalshi/marketConditions.utils';
import {
  KALSHI_MODEL_VERSION,
  KALSHI_DERIVATIVES_MODEL_VERSION,
} from '../utils/kalshi/forecast.utils';
import { getValidatedForecast, saveJournal, loadJournal } from '../utils/journal.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { createResearchRecorder } from '../utils/researchRecorder.utils';
import { getEvidenceRow } from '../utils/evidenceStorage.utils';
import { getReversalRisk } from '../utils/reversalRisk.utils';

const START = Date.UTC(2026, 8, 10, 12);
const CAPTURE = START + 180_000;
const END = START + 900_000;
const contract = {
  ticker: 'KXBTC15M-26SEP101215-15',
  eventTicker: 'KXBTC15M-26SEP101215',
  seriesTicker: 'KXBTC15M',
  startsAt: START,
  expiresAt: END,
  target: 49_990,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};

function inputs(now = CAPTURE) {
  const samples = Array.from({ length: 3600 }, (_, index) => ({
    time: now - (3599 - index) * 1000,
    price: 50_000 * Math.exp(0.0003 * Math.sin(index / 60)),
  }));
  return {
    now,
    candles: [],
    ticker: null,
    stream: null,
    kalshiMarket: contract,
    target: contract.target,
    expiresAt: END,
    horizonMinutes: (END - now) / 60_000,
    benchmark: {
      available: true,
      status: 'live',
      receivedAt: now,
      samples,
      current: samples.at(-1),
    },
  };
}

function analyzing() {
  return {
    id: 'native-fixed',
    startsAt: START,
    createdAt: START,
    expiresAt: END,
    timingMode: 'end',
    price: 50_000,
    target: contract.target,
    modelVersion: KALSHI_MODEL_VERSION,
    status: 'analyzing',
    direction: 'neutral',
    aboveProbability: null,
    belowProbability: null,
    calculationMode: null,
    kalshiMarket: contract,
    kalshi: null,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    analysis: getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: END,
      policyVersion: KALSHI_POLICY_VERSION,
    }),
  };
}

function futuresAt(now) {
  const completeSince = now - 240_000;
  return {
    version: 'bybit-linear-flow-v1',
    source: 'bybit-linear',
    symbol: 'BTCUSDT',
    status: 'live',
    asOf: now,
    quality: { completeSince, lastTradeAt: now, lastMessageAt: now, subscribed: true },
    windows: Object.fromEntries(
      [15, 60, 180].map((seconds) => [
        seconds,
        {
          available: true,
          buyBtc: seconds * 2,
          sellBtc: seconds,
          totalBtc: seconds * 3,
          signedBtc: seconds,
          imbalance: 1 / 3,
          tradeCount: seconds * 3,
          logReturn: (0.0002 * seconds) / 60,
          largeTradesAvailable: false,
        },
      ]),
    ),
    impact: {
      available: true,
      bucketSeconds: 15,
      completeSince,
      asOf: now,
      samples: Array.from({ length: 8 }, (_, index) => ({
        startAt: now - (8 - index) * 15000,
        endAt: now - (7 - index) * 15000,
        startPrice: 50_000,
        endPrice: 50_000 * Math.exp(0.00005),
        buyBtc: 30,
        sellBtc: 15,
        tradeCount: 45,
      })),
    },
    liquidations: { available: false },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(CAPTURE);
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test('native index history provides learnable price-only estimates during a Coinbase outage', () => {
  const input = inputs();
  const forecast = getResearchForecast(input);
  expect(forecast).toMatchObject({ available: true, modelVersion: KALSHI_MODEL_VERSION });
  expect(forecast.kalshi).toMatchObject({
    referenceSource: 'cf-brti',
    volatilitySource: 'cf-brti',
  });
  expect(forecast.learningFeatures).toMatchObject({
    available: true,
    featureInputSource: 'cf-brti-history',
    baselineModelVersion: KALSHI_MODEL_VERSION,
  });
  expect(forecast.learningFeatures.missingFeeds).toEqual(
    expect.arrayContaining(['volume', 'spread']),
  );
  const conditions = getKalshiMarketConditions({ ...input, forecast });
  expect(conditions.priceSource).toBe('cf-brti-history');
  expect(conditions.features.relativeVolume5To30Minutes).toBeUndefined();
  expect(forecast.learningFeatures.targetDistance).toBeCloseTo(
    Math.log(forecast.kalshi.referencePrice / contract.target) /
      (forecast.kalshi.minuteVolatility * Math.sqrt(input.horizonMinutes)),
    8,
  );
});

test('fixed publication uses BRTI freshness and price even when Coinbase requests fail', () => {
  const store = configureStore({ reducer: { tracker: reducer } });
  store.dispatch(forecastRecorded(analyzing()));
  renderHook(
    () => {
      const forecast = useSelector(selectActiveForecast);
      return useFixedPrediction({ ...inputs(), forecast, hasRequestError: true });
    },
    { wrapper: ({ children }) => <Provider store={store}>{children}</Provider> },
  );
  const fixed = store.getState().tracker.forecasts[0];
  expect(fixed.status).toBe('pending');
  expect(fixed.price).toBe(inputs().benchmark.current.price);
  expect(fixed.kalshi.volatilitySource).toBe('cf-brti');
  expect(fixed.aboveProbability).toBeGreaterThan(0);
  expect(fixed.belowProbability).toBeGreaterThan(0);
});

test.each([true, false])(
  'new fixed calls capture futures math or its optional fallback and remain immutable: live feed %s',
  (hasFutures) => {
    window.localStorage.clear();
    const store = configureStore({ reducer: { tracker: reducer } });
    store.dispatch(
      forecastRecorded({ ...analyzing(), modelVersion: KALSHI_DERIVATIVES_MODEL_VERSION }),
    );
    const derivatives = hasFutures ? futuresAt(CAPTURE) : null;
    const expected = getResearchForecast({ ...inputs(), derivatives });
    const baseline = getResearchForecast(inputs());
    const view = renderHook(
      (props) =>
        useFixedPrediction({
          ...inputs(),
          ...props,
          forecast: useSelector(selectActiveForecast),
          hasRequestError: true,
        }),
      {
        initialProps: { derivatives },
        wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
      },
    );
    const fixed = store.getState().tracker.forecasts[0];
    expect(fixed.status).toBe('pending');
    expect(fixed.modelVersion).toBe(KALSHI_DERIVATIVES_MODEL_VERSION);
    expect(fixed.aboveProbability).toBe(expected.aboveProbability);
    expect(fixed.derivatives).toEqual(expected.derivatives);
    expect(fixed.derivatives.applied).toBe(hasFutures);
    if (hasFutures) expect(fixed.aboveProbability).toBeGreaterThan(baseline.aboveProbability);
    else expect(fixed.aboveProbability).toBe(baseline.aboveProbability);
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    expect(saveJournal([fixed])).toBeNull();
    expect(loadJournal().forecasts).toEqual([fixed]);
    view.rerender({ derivatives: null });
    expect(store.getState().tracker.forecasts[0]).toEqual(fixed);
  },
);

test('a fresh benchmark price alone cannot replace missing history during a Coinbase outage', () => {
  const input = inputs();
  input.benchmark.samples = input.benchmark.samples.slice(-60);
  expect(getResearchForecast(input).available).toBe(false);
});

test.each([false, true])(
  'scheduled native calls respect contract errors: %s',
  (hasContractError) => {
    const store = configureStore({ reducer: { tracker: reducer } });
    store.dispatch(
      scheduleCreated({
        id: 'native-scheduled',
        createdAt: START - 60_000,
        startsAt: START,
        expiresAt: END,
        target: null,
        status: 'scheduled',
        marketTicker: contract.ticker,
        eventTicker: contract.eventTicker,
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        policyVersion: KALSHI_POLICY_VERSION,
      }),
    );
    renderHook(
      () =>
        useKalshiSchedule({
          ...inputs(),
          markets: [{ ...contract, status: 'active', receivedAt: CAPTURE }],
          isReady: true,
          hasRequestError: true,
          hasContractError,
        }),
      { wrapper: ({ children }) => <Provider store={store}>{children}</Provider> },
    );
    expect(store.getState().tracker.forecasts).toHaveLength(hasContractError ? 0 : 1);
    if (!hasContractError) {
      expect(store.getState().tracker.forecasts[0]).toMatchObject({
        price: inputs().benchmark.current.price,
        expiresAt: END,
        status: 'analyzing',
      });
    }
  },
);

test('archive current-side comparisons use the BRTI reference instead of a different venue price', () => {
  const forecast = getResearchForecast(inputs());
  const row = getEvidenceRow({
    entry: analyzing(),
    event: 'observation',
    now: CAPTURE,
    inputObservedAt: CAPTURE,
    ticker: { price: 49_000, time: CAPTURE, receivedAt: CAPTURE },
    estimate: forecast,
  });
  expect(row.spot).toBe(forecast.kalshi.referencePrice);
  expect(row.currentSide).toBe('above');
  expect(row.referenceSource).toBe('cf-brti');
  expect(row.quoteTime).toBe(inputs().benchmark.current.time);
});

test('live reversal risk stays available with a fresh BRTI reference during a Coinbase outage', () => {
  const forecast = getResearchForecast(inputs());
  const risk = getReversalRisk({
    forecast,
    fixedForecast: { ...analyzing(), status: 'pending', direction: 'above' },
    ticker: null,
    now: CAPTURE,
  });
  expect(risk).toMatchObject({
    available: true,
    referenceSource: 'cf-brti',
    fixedFailureProbability: forecast.belowProbability,
  });
});

test.each([false, true])(
  'automatic checkpoints capture native BRTI without Coinbase; learned=%s',
  (learned) => {
    const input = inputs();
    const recorder = createResearchRecorder({ recorderId: 'native-recorder' });
    const result = recorder.advance({
      ...input,
      markets: [{ ...contract, status: 'active', receivedAt: CAPTURE }],
      getEstimate: () => ({
        ...getResearchForecast(input),
        ...(learned ? { learning: { applied: true } } : {}),
      }),
      getConditions: ({ forecast }) => getKalshiMarketConditions({ ...input, forecast }),
    });
    const decision = result.rows.find((row) => row.event === 'decision');
    expect(decision).toMatchObject({
      decision: 'pending',
      calculationMode: learned ? 'outcome-trained' : 'baseline-fallback',
      referenceSource: 'cf-brti',
      spot: input.benchmark.current.price,
      learningFeatures: { available: true, featureInputSource: 'cf-brti-history' },
    });
  },
);
