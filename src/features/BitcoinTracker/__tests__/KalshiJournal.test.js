import { createElement } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import reducer, {
  forecastRecorded,
  fixedForecastPublished,
  forecastsObserved,
  historyCleared,
  historyRestored,
} from '../state/slices/trackerSlice';
import { selectActiveForecast } from '../state/selectors/trackerSelectors';
import useFixedPrediction from '../hooks/useFixedPrediction';
import {
  getFixedForecastAnalysis,
  getFixedPredictionProgress,
  KALSHI_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import { getKalshiForecast, KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import {
  getKalshiContract,
  getKalshiOutcome,
  isKalshiContract,
  KALSHI_OUTCOME_DEFINITION,
} from '../utils/kalshi/contract.utils';
import { getValidatedForecast, loadJournal, saveJournal } from '../utils/journal.utils';
import { KALSHI_OUTCOME_MODEL_VERSION, CALIBRATION_VERSION } from '../utils/learning/model.utils';
import { LEARNING_FEATURE_NAMES, LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';

const START = Date.UTC(2026, 8, 10, 12);
const END = START + 900_000;
const CAPTURE = START + 180_000;
const contract = () => ({
  ticker: 'KXBTC15M-26SEP101215-15',
  eventTicker: 'KXBTC15M-26SEP101215',
  seriesTicker: 'KXBTC15M',
  target: 50_000,
  startsAt: START,
  expiresAt: END,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
});

function market(now) {
  const minute = Math.floor(now / 60_000) * 60_000;
  let price = 50_000;
  return {
    now,
    target: 50_000,
    expiresAt: END,
    horizonMinutes: (END - now) / 60_000,
    kalshiMarket: contract(),
    benchmark: { status: 'not-configured', samples: [], current: null },
    candles: Array.from({ length: 120 }, (_, index) => {
      const open = price;
      price *= Math.exp(index % 2 ? 0.001 : -0.001);
      return {
        time: minute - (120 - index) * 60_000,
        open,
        close: price,
        high: Math.max(open, price) * 1.0001,
        low: Math.min(open, price) / 1.0001,
        volume: 10,
      };
    }),
    ticker: { price: 50_000, bid: 49_999, ask: 50_001, time: now, receivedAt: now, volume: 100 },
  };
}

function analyzing(startedAt = START) {
  return {
    id: 'kalshi-fixed',
    createdAt: startedAt,
    startsAt: START,
    expiresAt: END,
    timingMode: 'end',
    price: 50_000,
    target: 50_000,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    status: 'analyzing',
    modelVersion: KALSHI_MODEL_VERSION,
    calculationMode: null,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshiMarket: contract(),
    kalshi: null,
    analysis: getFixedForecastAnalysis({
      startedAt,
      expiresAt: END,
      policyVersion: KALSHI_POLICY_VERSION,
    }),
  };
}

function published(forecast = analyzing()) {
  const now = forecast.analysis.earliestAt;
  const estimate = getKalshiForecast(market(now));
  return {
    ...forecast,
    createdAt: now,
    aboveProbability: estimate.aboveProbability,
    belowProbability: estimate.belowProbability,
    direction: estimate.direction,
    kalshi: estimate.kalshi,
    status: 'pending',
    calculationMode: 'baseline-fallback',
  };
}

function settled(result = 'yes', now = END + 180_000) {
  return getKalshiOutcome(
    {
      ...contract(),
      status: 'settled',
      result,
      settlementPrice: result === 'yes' ? 50_000 : 49_999.99,
      receivedAt: now,
      settledAt: now,
    },
    now,
  );
}

function artifact() {
  const length = LEARNING_FEATURE_NAMES.length;
  const trainedAt = START - 60_000;
  const id = `${KALSHI_OUTCOME_MODEL_VERSION}-journal`;
  return {
    id,
    version: KALSHI_OUTCOME_MODEL_VERSION,
    status: 'shadow',
    trainedAt,
    shadowStartsAt: trainedAt,
    featureVersion: LEARNING_FEATURE_VERSION,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    trainingCutoffAt: trainedAt - 3000,
    calibrationCutoffAt: trainedAt - 2000,
    evaluationCutoffAt: trainedAt - 1000,
    model: {
      indexes: LEARNING_FEATURE_NAMES.map((_, index) => index),
      means: Array(length).fill(0),
      scales: Array(length).fill(1),
      coefficients: [Math.log(0.6 / 0.4), ...Array(length).fill(0)],
    },
    calibration: {
      version: CALIBRATION_VERSION,
      model: { indexes: [0], means: [0], scales: [1], coefficients: [0, 1] },
    },
    applicability: {
      baselineModelVersion: KALSHI_MODEL_VERSION,
      featureInputSources: ['coinbase-candles'],
      minimumHorizonMinutes: 1,
      maximumHorizonMinutes: 15,
      minimumTargetDistance: -8,
      maximumTargetDistance: 8,
      availabilityPatterns: ['0000011'],
      referenceSources: ['coinbase-proxy'],
    },
    activation: {
      modelId: id,
      activatedAt: START - 1000,
      shadowEvaluation: { eligibleForPromotion: true },
    },
  };
}

describe('Kalshi fixed forecast lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test('a weak valid proxy snapshot publishes after observation, stays fixed, and reloads with its exact contract', () => {
    const store = configureStore({ reducer: { tracker: reducer } });
    store.dispatch(forecastRecorded(analyzing()));
    const wrapper = ({ children }) => createElement(Provider, { store }, children);
    const view = renderHook(
      (props) => {
        const forecast = useSelector(selectActiveForecast);
        return useFixedPrediction({ ...props, forecast });
      },
      { initialProps: market(START), wrapper },
    );
    expect(store.getState().tracker.forecasts[0].status).toBe('analyzing');
    jest.setSystemTime(CAPTURE - 1);
    view.rerender(market(CAPTURE - 1));
    expect(store.getState().tracker.forecasts[0].status).toBe('analyzing');
    jest.setSystemTime(CAPTURE);
    view.rerender(market(CAPTURE));
    const fixed = store.getState().tracker.forecasts[0];
    expect(fixed).toMatchObject({
      status: 'pending',
      modelVersion: KALSHI_MODEL_VERSION,
      kalshiMarket: contract(),
      kalshi: { referenceSource: 'coinbase-proxy' },
    });
    expect(Math.max(fixed.aboveProbability, fixed.belowProbability)).toBeLessThan(0.65);
    jest.setSystemTime(CAPTURE + 1000);
    const changed = market(CAPTURE + 1000);
    changed.ticker = { ...changed.ticker, price: 51_000, bid: 50_999, ask: 51_001 };
    view.rerender(changed);
    expect(store.getState().tracker.forecasts[0]).toEqual(fixed);
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    expect(saveJournal([fixed])).toBeNull();
    expect(loadJournal().forecasts).toEqual([fixed]);
    expect(JSON.parse(window.localStorage.getItem('bitcoin-tracker:journal:v1')).version).toBe(7);
  });

  test('a validated learned Kalshi model can publish and survive journal validation', () => {
    const store = configureStore({ reducer: { tracker: reducer } });
    store.dispatch(forecastRecorded(analyzing()));
    jest.setSystemTime(CAPTURE);
    const wrapper = ({ children }) => createElement(Provider, { store }, children);
    renderHook(
      () =>
        useFixedPrediction({
          ...market(CAPTURE),
          forecast: useSelector(selectActiveForecast),
          models: { active: artifact() },
        }),
      { wrapper },
    );
    const fixed = store.getState().tracker.forecasts[0];
    expect(fixed).toMatchObject({
      status: 'pending',
      modelVersion: KALSHI_OUTCOME_MODEL_VERSION,
      calculationMode: 'outcome-trained',
      learning: { applied: true, modelId: artifact().id },
    });
    expect(fixed.aboveProbability).toBeCloseTo(0.6);
    expect(saveJournal([fixed])).toBeNull();
    expect(loadJournal().forecasts).toEqual([fixed]);
  });

  test('waits across reload and long settlement delays, ignoring Coinbase ticks, then scores official YES on equality', () => {
    const fixed = published();
    let state = reducer(undefined, forecastRecorded(fixed));
    state = reducer(
      state,
      forecastsObserved({
        now: END + 1000,
        ticker: { price: 49_000, time: END, receivedAt: END + 1000 },
        deadlineOutcome: { status: 'observed', observedPrice: 49_000 },
      }),
    );
    expect(state.forecasts[0].status).toBe('awaiting-settlement');
    expect(state.forecasts[0].correct).toBeUndefined();
    state = reducer(state, forecastsObserved({ now: END + 3_600_000 }));
    expect(state.forecasts[0].status).toBe('awaiting-settlement');
    expect(saveJournal(state.forecasts)).toBeNull();
    const restored = reducer(
      undefined,
      historyRestored({ forecasts: loadJournal().forecasts, scheduledForecast: null }),
    );
    expect(reducer(restored, historyCleared()).forecasts).toEqual(restored.forecasts);
    const resolved = reducer(
      restored,
      forecastsObserved({ now: END + 3_600_000, kalshiOutcomes: [settled('yes')] }),
    ).forecasts[0];
    expect(resolved).toMatchObject({
      ...fixed,
      status: 'resolved',
      observedPrice: 50_000,
      outcome: 'above',
      correct: fixed.direction === 'above',
    });
    expect(getValidatedForecast(resolved)).toEqual(resolved);
    expect(saveJournal([resolved])).toBeNull();
    expect(loadJournal().forecasts).toEqual([resolved]);
  });

  test('rejects another market, deadline, target, or future confirmation as settlement proof', () => {
    const fixed = published();
    const state = reducer(undefined, forecastRecorded(fixed));
    const result = settled();
    for (const patch of [
      { marketTicker: `${contract().ticker}-OTHER` },
      { expiresAt: END + 1 },
      { target: 49_999 },
      { confirmedThrough: END + 3_600_000 },
      { outcomeDefinition: 'coinbase-last-trade-at-deadline-v1' },
    ]) {
      const observed = reducer(
        state,
        forecastsObserved({ now: END + 180_000, kalshiOutcomes: [{ ...result, ...patch }] }),
      );
      expect(observed.forecasts[0].status).toBe('awaiting-settlement');
      expect(observed.forecasts[0].correct).toBeUndefined();
    }
  });

  test('cannot mutate a contract during publication or rewrite an already captured probability', () => {
    const analysis = analyzing();
    const original = reducer(undefined, forecastRecorded(analysis));
    const fixed = published(analysis);
    const changedMarket = { ...fixed.kalshiMarket, ticker: `${fixed.kalshiMarket.ticker}-OTHER` };
    const changed = {
      ...fixed,
      kalshiMarket: changedMarket,
      kalshi: { ...fixed.kalshi, marketTicker: changedMarket.ticker },
    };
    expect(
      reducer(original, fixedForecastPublished({ id: fixed.id, now: CAPTURE, forecast: changed })),
    ).toBe(original);
    const captured = reducer(
      original,
      fixedForecastPublished({ id: fixed.id, now: CAPTURE, forecast: fixed }),
    );
    expect(captured.forecasts[0]).toEqual(fixed);
    const retry = { ...fixed, aboveProbability: 0.9, belowProbability: 0.1, direction: 'above' };
    expect(
      reducer(captured, fixedForecastPublished({ id: fixed.id, now: CAPTURE, forecast: retry })),
    ).toBe(captured);
  });

  test.each([
    { kalshi: {} },
    { kalshi: { referenceSource: 'cf-brti' } },
    { kalshi: null },
    { outcomeDefinition: 'coinbase-last-trade-at-deadline-v1' },
    { modelVersion: 'outcome-logistic-v1' },
  ])('rejects malformed or cross-contract persisted metadata: %j', (patch) => {
    expect(getValidatedForecast({ ...published(), ...patch })).toBeNull();
  });

  test('preserves the old journal while rejecting a Kalshi record disguised as an older journal', () => {
    const storage = {
      getItem: () =>
        JSON.stringify({ version: 6, forecasts: [published()], scheduledForecast: null }),
    };
    expect(loadJournal(storage).warning).toMatch(/invalid/i);
    expect(loadJournal(storage).forecasts).toEqual([]);
  });

  test.each([
    [120_000, 30_000],
    [60_000, 15_000],
    [20_000, 15_000],
  ])(
    'a late join with %i ms left uses %i ms observation and can still publish',
    (remaining, observation) => {
      const analysis = getFixedForecastAnalysis({
        startedAt: END - remaining,
        expiresAt: END,
        policyVersion: KALSHI_POLICY_VERSION,
      });
      expect(analysis.earliestAt - analysis.startedAt).toBe(observation);
      expect(
        getFixedPredictionProgress({
          analysis,
          samples: [],
          estimate: { available: true, aboveProbability: 0.51, belowProbability: 0.49 },
          now: analysis.earliestAt,
        }).phase,
      ).toBe('ready');
      const forecast = published(analyzing(END - remaining));
      expect(getValidatedForecast(forecast)).toEqual(forecast);
    },
  );

  test('the Kalshi late-join policy does not change the old three-minute observation policy', () => {
    const analysis = getFixedForecastAnalysis({
      startedAt: END - 60_000,
      expiresAt: END,
      policyVersion: PRESSURE_POLICY_VERSION,
    });
    expect(analysis.earliestAt - analysis.startedAt).toBe(180_000);
    expect(analysis.earliestAt).toBeGreaterThan(analysis.deadline);
    const late = getFixedForecastAnalysis({
      startedAt: END - 19_000,
      expiresAt: END,
      policyVersion: KALSHI_POLICY_VERSION,
    });
    expect(late.earliestAt).toBeGreaterThan(late.deadline);
  });

  test('market quotes and a closed status do not create official results; contract identity discards mutable price fields', () => {
    const current = {
      ...contract(),
      receivedAt: END + 1000,
      status: 'closed',
      result: 'yes',
      settlementPrice: 50_000,
      yesAsk: 0.99,
    };
    expect(getKalshiOutcome(current, END + 1000)).toBeNull();
    expect(getKalshiContract(current)).toEqual(contract());
    expect(isKalshiContract({ ...contract(), startsAt: START + 1, expiresAt: END + 1 })).toBe(
      false,
    );
  });
});
