import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import trackerReducer, {
  fixedForecastPublished,
  forecastBatchRecorded,
  forecastsObserved,
  scheduleCreated,
  scheduledForecastBatchStarted,
} from '../state/slices/trackerSlice';
import { selectActiveForecast, selectForecasts } from '../state/selectors/trackerSelectors';
import useFixedPrediction from '../hooks/useFixedPrediction';
import useKalshiSchedule from '../hooks/useKalshiSchedule';
import useForecastEvidence from '../hooks/useForecastEvidence';
import { createKalshiForecastBatch } from '../utils/kalshi/forecastBatch.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { appendEvidenceRows } from '../utils/evidenceStorage.utils';
import { KALSHI_CHECKPOINT_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('../utils/researchForecast.utils', () => ({
  ...jest.requireActual('../utils/researchForecast.utils'),
  getResearchForecast: jest.fn(),
}));
jest.mock('../utils/evidenceStorage.utils', () => ({
  ...jest.requireActual('../utils/evidenceStorage.utils'),
  appendEvidenceRows: jest.fn(),
}));

const START = Date.UTC(2026, 8, 10, 12);
const END = START + 900_000;
const NINE_MINUTES = END - 9 * 60_000;
const SIX_MINUTES = END - 6 * 60_000;
const outcomes = [];
const contract = {
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
};
const nextContract = {
  ...contract,
  ticker: 'KXBTC15M-26SEP101230-30',
  eventTicker: 'KXBTC15M-26SEP101230',
  startsAt: END,
  expiresAt: END + 900_000,
};

const createStore = () => configureStore({ reducer: { tracker: trackerReducer } });
const records = (store) => store.getState().tracker.forecasts;
const capture = (store, minutes) =>
  records(store).find((record) => record.checkpointMinutes === minutes);
const batch = (overrides = {}) =>
  createKalshiForecastBatch({
    id: 'event-checkpoints',
    contract,
    createdAt: START,
    checkpointMinutes: [9, 6],
    captureOrigin: 'manual',
    price: 50_000,
    ...overrides,
  });
const schedule = (overrides = {}) => ({
  id: 'scheduled-checkpoints',
  createdAt: START - 30_000,
  startsAt: START,
  expiresAt: END,
  target: null,
  status: 'scheduled',
  marketTicker: contract.ticker,
  eventTicker: contract.eventTicker,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION,
  checkpointMinutes: [9, 6],
  captureOrigin: 'automatic',
  ...overrides,
});

function marketInputs(now, price = 50_000) {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: Math.floor(now / 1000) * 1000 - (1200 - index) * 1000,
    price: price * Math.exp(Math.sin(index / 30) * 0.0001),
    receivedAt: now,
  }));
  return {
    now,
    candles: [],
    ticker: { price, bid: price - 1, ask: price + 1, time: now, receivedAt: now },
    benchmark: { available: true, receivedAt: now, current: samples.at(-1), samples },
    stream: {},
    models: {},
    hasRequestError: false,
    isReady: true,
    markets: [{ ...contract, status: 'active' }],
  };
}

function renderLifecycle({ store = createStore(), now = START, overrides = {} } = {}) {
  let props = { ...marketInputs(now), ...overrides };
  jest.setSystemTime(now);
  const view = renderHook(
    (inputs) => {
      useKalshiSchedule(inputs);
      const forecast = useSelector(selectActiveForecast);
      const forecasts = useSelector(selectForecasts);
      const progress = useFixedPrediction({ ...inputs, forecast });
      const evidenceWarning = useForecastEvidence({
        ...inputs,
        forecasts,
        progress,
        kalshiOutcomes: outcomes,
      });
      return { forecast, progress, evidenceWarning };
    },
    {
      initialProps: props,
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    },
  );
  return {
    ...view,
    store,
    async record(forecasts) {
      await act(async () => {
        store.dispatch(forecastBatchRecorded(forecasts));
      });
    },
    async update(time, price = 50_000, changes = {}) {
      props = { ...props, ...marketInputs(time, price), ...changes };
      jest.setSystemTime(time);
      await act(async () => {
        view.rerender(props);
      });
    },
  };
}

let estimatesAvailable;
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(START);
  estimatesAvailable = true;
  appendEvidenceRows.mockReset().mockResolvedValue(null);
  getResearchForecast.mockReset().mockImplementation((...args) => {
    const prediction = jest
      .requireActual('../utils/researchForecast.utils')
      .getResearchForecast(...args);
    return { ...prediction, available: estimatesAvailable && prediction.available };
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test('captures each selected deadline once, retaining distinct immutable inputs and decision evidence', async () => {
  const view = renderLifecycle();
  await view.record(batch());
  expect(view.result.current.forecast.checkpointMinutes).toBe(9);
  await view.update(START + 180_000);
  expect(records(view.store).every((record) => record.status === 'analyzing')).toBe(true);
  await view.update(NINE_MINUTES, 50_100);
  const first = JSON.parse(JSON.stringify(capture(view.store, 9)));
  expect(first).toMatchObject({ status: 'pending', createdAt: NINE_MINUTES, direction: 'above' });
  expect(view.result.current.forecast.checkpointMinutes).toBe(6);
  await view.update(SIX_MINUTES, 49_900);
  const second = capture(view.store, 6);
  expect(second).toMatchObject({ status: 'pending', createdAt: SIX_MINUTES, direction: 'below' });
  expect(capture(view.store, 9)).toEqual(first);
  expect(view.result.current.forecast.id).toBe(second.id);
  await view.update(SIX_MINUTES + 1000, 50_200);
  expect(capture(view.store, 9)).toEqual(first);
  expect(capture(view.store, 6)).toEqual(second);
  const decisions = appendEvidenceRows.mock.calls
    .flatMap(([rows]) => rows)
    .filter((row) => row.event === 'decision');
  expect(decisions).toHaveLength(2);
  expect(decisions.map((row) => row.forecastId).sort()).toEqual([first.id, second.id].sort());
  for (const row of decisions) {
    expect(row.inputStatus).toBe('captured');
    expect(row.researchInputSnapshot.capturedAt).toBe(row.featureCutoffAt);
    expect(row.researchInputSnapshot.input.now).toBe(row.featureCutoffAt);
  }
});

test('joining just before a checkpoint adds no extra three-minute observation wait', async () => {
  const joinedAt = NINE_MINUTES - 1000;
  const view = renderLifecycle({ now: joinedAt });
  await view.record(batch({ createdAt: joinedAt }));
  expect(capture(view.store, 9).status).toBe('analyzing');
  await view.update(NINE_MINUTES, 50_100);
  expect(capture(view.store, 9)).toMatchObject({ status: 'pending', createdAt: NINE_MINUTES });
  expect(capture(view.store, 6).status).toBe('analyzing');
});

test('a missed nine-minute checkpoint does not block or backfill the six-minute prediction', async () => {
  const view = renderLifecycle();
  await view.record(batch());
  estimatesAvailable = false;
  await view.update(NINE_MINUTES);
  expect(capture(view.store, 9).status).toBe('analyzing');
  await view.update(NINE_MINUTES + 5001);
  expect(capture(view.store, 9)).toMatchObject({ status: 'withheld', aboveProbability: null });
  expect(view.result.current.forecast.checkpointMinutes).toBe(6);
  estimatesAvailable = true;
  await view.update(SIX_MINUTES, 50_100);
  expect(capture(view.store, 6)).toMatchObject({ status: 'pending', createdAt: SIX_MINUTES });
  expect(capture(view.store, 9)).toMatchObject({ status: 'withheld', aboveProbability: null });
});

test('finished predictions await official settlement while the next event starts a fresh batch', async () => {
  const view = renderLifecycle();
  await view.record(batch());
  await view.update(NINE_MINUTES, 50_100);
  await view.update(SIX_MINUTES, 49_900);
  await view.update(END);
  await act(async () => {
    view.store.dispatch(forecastsObserved({ now: END, kalshiOutcomes: [] }));
  });
  expect(records(view.store).every((record) => record.status === 'awaiting-settlement')).toBe(true);
  expect(view.result.current.forecast).toBeNull();
  await view.record(batch({ id: 'next-event', contract: nextContract, createdAt: END }));
  expect(records(view.store)).toHaveLength(4);
  expect(
    records(view.store).filter((record) => record.status === 'awaiting-settlement'),
  ).toHaveLength(2);
  expect(view.result.current.forecast.kalshiMarket.ticker).toBe(nextContract.ticker);
  expect(view.result.current.forecast.analysis.earliestAt).toBe(
    nextContract.expiresAt - 9 * 60_000,
  );
});

test('opening a scheduled event expands matching checkpoint IDs, origin, target, and policy exactly once', async () => {
  const store = createStore();
  const selected = schedule();
  store.dispatch(scheduleCreated(selected));
  const view = renderLifecycle({
    store,
    now: START - 30_000,
    overrides: { markets: [{ ...contract, target: null, status: 'initialized' }] },
  });
  expect(records(store)).toEqual([]);
  await view.update(START, 50_100);
  expect(store.getState().tracker.scheduledForecast).toBeNull();
  expect(
    records(store)
      .map((record) => record.id)
      .sort(),
  ).toEqual(['scheduled-checkpoints:6', 'scheduled-checkpoints:9']);
  for (const record of records(store)) {
    expect(record).toMatchObject({
      createdAt: START,
      target: contract.target,
      checkpointMinutes: expect.any(Number),
      captureOrigin: 'automatic',
      kalshiMarket: contract,
      analysis: { policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION, startedAt: START },
    });
  }
  await view.update(START + 1000);
  expect(records(store)).toHaveLength(2);
  await view.update(NINE_MINUTES, 50_100);
  expect(capture(store, 9).status).toBe('pending');
});

test('a delayed scheduled opening marks the past checkpoint missed while preserving the next one', async () => {
  const store = createStore();
  store.dispatch(scheduleCreated(schedule()));
  const view = renderLifecycle({
    store,
    now: START - 30_000,
    overrides: { markets: [] },
  });
  await view.update(NINE_MINUTES + 5001);
  expect(store.getState().tracker.scheduledForecast).toBeNull();
  expect(capture(store, 9)).toMatchObject({
    status: 'withheld',
    withholdingReason: 'insufficient-time',
    aboveProbability: null,
  });
  expect(capture(store, 6).status).toBe('analyzing');
  await view.update(SIX_MINUTES, 50_100);
  expect(capture(store, 6)).toMatchObject({ status: 'pending', createdAt: SIX_MINUTES });
  expect(capture(store, 9).status).toBe('withheld');
});

test('invalid manual batches are atomic and cannot bypass existing active forecasts or schedules', () => {
  for (const invalid of [
    [batch()[0], batch({ id: 'other-event', contract: nextContract, createdAt: END })[1]],
    [batch()[0], { ...batch()[0], id: 'duplicate-checkpoint' }],
    [batch()[0], { ...batch()[1], checkpointMinutes: 3 }],
  ]) {
    const store = createStore();
    store.dispatch(forecastBatchRecorded(invalid));
    expect(records(store)).toEqual([]);
  }
  const store = createStore();
  store.dispatch(forecastBatchRecorded(batch()));
  const original = store.getState();
  store.dispatch(forecastBatchRecorded(batch({ id: 'second-batch' })));
  expect(store.getState()).toEqual(original);
  const scheduledStore = createStore();
  scheduledStore.dispatch(scheduleCreated(schedule()));
  scheduledStore.dispatch(forecastBatchRecorded(batch()));
  expect(records(scheduledStore)).toEqual([]);
  expect(scheduledStore.getState().tracker.scheduledForecast).not.toBeNull();
});

test.each(['id', 'origin', 'checkpoint', 'contract', 'clock'])(
  'scheduled batches reject mismatched %s without partially starting',
  (field) => {
    const store = createStore();
    const selected = schedule();
    store.dispatch(scheduleCreated(selected));
    const forecasts = batch({ id: selected.id, captureOrigin: selected.captureOrigin });
    if (field === 'id') forecasts[0].id = 'different-id';
    if (field === 'origin') forecasts[0].captureOrigin = 'manual';
    if (field === 'checkpoint') forecasts.pop();
    if (field === 'contract')
      forecasts[0].kalshiMarket = { ...contract, ticker: 'KXBTC15M-26SEP101215-99' };
    if (field === 'clock') forecasts[0].createdAt += 1;
    store.dispatch(scheduledForecastBatchStarted({ forecasts, now: START }));
    expect(records(store)).toEqual([]);
    expect(store.getState().tracker.scheduledForecast).toEqual(selected);
  },
);

test('a publication cannot change an armed checkpoint origin or replace existing fixed values', async () => {
  const view = renderLifecycle();
  await view.record(batch());
  await view.update(NINE_MINUTES, 50_100);
  const original = JSON.parse(JSON.stringify(capture(view.store, 9)));
  await act(async () => {
    view.store.dispatch(
      fixedForecastPublished({
        id: original.id,
        now: NINE_MINUTES,
        forecast: { ...original, aboveProbability: 0.1, belowProbability: 0.9, direction: 'below' },
      }),
    );
  });
  expect(capture(view.store, 9)).toEqual(original);
  const armed = capture(view.store, 6);
  jest.setSystemTime(SIX_MINUTES);
  const prediction = getResearchForecast({
    ...marketInputs(SIX_MINUTES, 49_900),
    kalshiMarket: contract,
    expiresAt: END,
    target: contract.target,
  });
  const pending = {
    ...armed,
    createdAt: SIX_MINUTES,
    status: 'pending',
    aboveProbability: prediction.aboveProbability,
    belowProbability: prediction.belowProbability,
    direction: prediction.direction,
    calculationMode: 'baseline-fallback',
    kalshi: prediction.kalshi,
    captureOrigin: 'automatic',
  };
  await act(async () => {
    view.store.dispatch(
      fixedForecastPublished({ id: armed.id, now: SIX_MINUTES, forecast: pending }),
    );
  });
  expect(capture(view.store, 6)).toEqual(armed);
  await view.update(SIX_MINUTES, 49_900);
  expect(capture(view.store, 6)).toMatchObject({ status: 'pending', captureOrigin: 'manual' });
});
