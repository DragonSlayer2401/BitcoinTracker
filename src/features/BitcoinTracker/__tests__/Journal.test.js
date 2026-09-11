import reducer, {
  forecastRecorded,
  forecastsObserved,
  historyCleared,
  historyRestored,
  scheduleCancelled,
  scheduleCreated,
  scheduledForecastStarted,
  scheduleStartMissed,
  storageWarningChanged,
} from '../state/slices/trackerSlice';
import {
  selectActiveForecast,
  selectForecasts,
  selectJournalSummary,
  selectHasForecastInProgress,
  selectScheduledForecast,
} from '../state/selectors/trackerSelectors';
import { getValidatedForecast, loadJournal, saveJournal } from '../utils/journal.utils';

const createdAt = 1_800_000_000_000;
const expiresAt = createdAt + 15 * 60 * 1000;
const makeForecast = (overrides = {}) => ({
  id: 'forecast-1',
  createdAt,
  expiresAt,
  price: 70_000,
  target: 71_000,
  aboveProbability: 0.7,
  belowProbability: 0.3,
  direction: 'above',
  modelVersion: 'test-model-v1',
  status: 'pending',
  ...overrides,
});
const makeTicker = (overrides = {}) => ({
  price: 72_000,
  time: expiresAt,
  receivedAt: expiresAt,
  ...overrides,
});
const makeResolved = (overrides = {}) =>
  makeForecast({
    status: 'resolved',
    observedPrice: 72_000,
    observedAt: expiresAt,
    outcome: 'above',
    correct: true,
    ...overrides,
  });
const makeStorage = (saved = null) => ({
  getItem: jest.fn(() => saved),
  setItem: jest.fn(),
});
const savedEnvelope = (forecasts) => JSON.stringify({ version: 1, forecasts });
const recordForecast = (overrides) => reducer(undefined, forecastRecorded(makeForecast(overrides)));
const startsAt = createdAt + 60_000;
const makeSchedule = (overrides = {}) => ({
  id: 'scheduled-1',
  createdAt,
  startsAt,
  expiresAt: startsAt + 15 * 60 * 1000,
  target: 71_000,
  status: 'scheduled',
  ...overrides,
});
const makeScheduledSnapshot = (overrides = {}) =>
  makeForecast({
    id: 'scheduled-1',
    createdAt: startsAt,
    startsAt,
    expiresAt: startsAt + 15 * 60 * 1000,
    ...overrides,
  });
const createSchedule = (overrides) => reducer(undefined, scheduleCreated(makeSchedule(overrides)));
const makeDeadlineForecast = (overrides = {}) =>
  makeForecast({
    timingMode: 'end',
    startsAt: createdAt - 3 * 60_000,
    expiresAt: createdAt + 12 * 60_000,
    ...overrides,
  });

describe('forecast journal observation', () => {
  test('records a locked snapshot and permits only one pending forecast', () => {
    const original = makeForecast();
    let state = reducer(undefined, forecastRecorded(original));
    state = reducer(state, forecastRecorded(makeForecast({ id: 'forecast-2', target: 75_000 })));

    expect(selectActiveForecast({ tracker: state })).toEqual(original);
    expect(selectForecasts({ tracker: state })).toHaveLength(1);
    expect(state.forecasts[0].target).toBe(71_000);
  });

  test('settles the first valid quote at expiry and never overwrites completed results', () => {
    let state = recordForecast();
    state = reducer(state, forecastsObserved({ ticker: makeTicker(), now: expiresAt }));
    expect(state.forecasts[0]).toEqual(makeResolved());

    state = reducer(
      state,
      forecastsObserved({ ticker: makeTicker({ price: 50_000 }), now: expiresAt + 10_000 }),
    );
    expect(state.forecasts[0]).toEqual(makeResolved());
    expect(selectActiveForecast({ tracker: state })).toBeNull();
  });

  test.each([
    ['a quote before expiry', { time: expiresAt - 1 }, expiresAt],
    ['a quote past the settlement window', { time: expiresAt + 15_001 }, expiresAt + 15_001],
    ['a stale exchange quote', {}, expiresAt + 20_001],
    ['a stale receive time', { receivedAt: expiresAt - 20_001 }, expiresAt],
    ['a receive timestamp too far in the future', { receivedAt: expiresAt + 5_001 }, expiresAt],
    ['an exchange timestamp too far in the future', { time: expiresAt + 5_001 }, expiresAt],
    ['a forecast that has not expired', {}, expiresAt - 1],
    ['a zero price', { price: 0 }, expiresAt],
    ['a numeric string price', { price: '72000' }, expiresAt],
    ['an infinite price', { price: Infinity }, expiresAt],
    ['a missing receive timestamp', { receivedAt: undefined }, expiresAt],
    ['a malformed exchange timestamp', { time: NaN }, expiresAt],
  ])('does not resolve with %s', (_label, tickerOverrides, now) => {
    const state = reducer(
      recordForecast(),
      forecastsObserved({ ticker: makeTicker(tickerOverrides), now }),
    );
    expect(state.forecasts[0].status).not.toBe('resolved');
    expect(state.forecasts[0]).not.toHaveProperty('observedPrice');
  });

  test('accepts a timely quote at the final millisecond of the observation window', () => {
    const state = reducer(
      recordForecast(),
      forecastsObserved({
        ticker: makeTicker({ time: expiresAt + 15_000, receivedAt: expiresAt + 15_000 }),
        now: expiresAt + 15_000,
      }),
    );
    expect(state.forecasts[0].status).toBe('resolved');
    expect(state.forecasts[0].observedAt).toBe(expiresAt + 15_000);
  });

  test('keeps the observation grace period, then marks missed observations without backfilling', () => {
    let state = reducer(
      recordForecast(),
      forecastsObserved({ ticker: null, now: expiresAt + 35_000 }),
    );
    expect(state.forecasts[0].status).toBe('pending');

    state = reducer(state, forecastsObserved({ ticker: null, now: expiresAt + 35_001 }));
    expect(state.forecasts[0].status).toBe('unobserved');

    state = reducer(state, forecastsObserved({ ticker: makeTicker(), now: expiresAt }));
    expect(state.forecasts[0].status).toBe('unobserved');
  });

  test('keeps waiting for a delayed valid quote and resolves its original exchange time', () => {
    let state = reducer(
      recordForecast(),
      forecastsObserved({ ticker: null, now: expiresAt + 21_000 }),
    );
    expect(state.forecasts[0].status).toBe('pending');

    state = reducer(
      state,
      forecastsObserved({
        ticker: makeTicker({ time: expiresAt + 14_000, receivedAt: expiresAt + 22_000 }),
        now: expiresAt + 22_000,
      }),
    );
    expect(state.forecasts[0]).toMatchObject({
      status: 'resolved',
      observedAt: expiresAt + 14_000,
      observedPrice: 72_000,
    });
  });

  test('accepts a quote at the maximum quote-age and observation-window boundaries', () => {
    const state = reducer(
      recordForecast(),
      forecastsObserved({
        ticker: makeTicker({ time: expiresAt + 15_000, receivedAt: expiresAt + 35_000 }),
        now: expiresAt + 35_000,
      }),
    );
    expect(state.forecasts[0].status).toBe('resolved');
  });

  test.each([
    ['equal', 71_000, 'above'],
    ['above', 72_000, 'neutral'],
    ['below', 70_000, 'neutral'],
  ])(
    'leaves correctness unscored for outcome %s with direction %s',
    (outcome, price, direction) => {
      const state = reducer(
        recordForecast({ direction }),
        forecastsObserved({ ticker: makeTicker({ price }), now: expiresAt }),
      );
      expect(state.forecasts[0]).toMatchObject({ status: 'resolved', outcome, correct: null });
    },
  );

  test('scores a wrong direction as incorrect', () => {
    const state = reducer(
      recordForecast(),
      forecastsObserved({ ticker: makeTicker({ price: 70_000 }), now: expiresAt }),
    );
    expect(state.forecasts[0]).toMatchObject({ outcome: 'below', correct: false });
  });

  test('ignores invalid clocks and malformed snapshots', () => {
    const state = recordForecast();
    expect(reducer(state, forecastsObserved({ ticker: makeTicker(), now: NaN }))).toBe(state);
    expect(reducer(undefined, forecastRecorded(makeForecast({ target: '71000' })))).toEqual({
      forecasts: [],
      scheduledForecast: null,
      storageWarning: null,
    });
  });

  test('retains the new pending forecast and the 99 newest completed forecasts', () => {
    const forecasts = Array.from({ length: 100 }, (_, index) =>
      makeResolved({
        id: `completed-${index}`,
        createdAt: createdAt - index * 1000,
        expiresAt: expiresAt - index * 1000,
        observedAt: expiresAt - index * 1000,
      }),
    );
    let state = reducer(undefined, historyRestored(forecasts));
    state = reducer(state, forecastRecorded(makeForecast({ id: 'active', createdAt, expiresAt })));
    expect(state.forecasts).toHaveLength(100);
    expect(state.forecasts[0].id).toBe('active');
    expect(state.forecasts.at(-1).id).toBe('completed-98');

    state = reducer(state, historyCleared());
    expect(state.forecasts).toEqual([makeForecast({ id: 'active' })]);
  });

  test('rejects duplicate forecast ids even after a forecast completes', () => {
    const state = reducer(undefined, historyRestored([makeResolved()]));
    expect(reducer(state, forecastRecorded(makeForecast()))).toBe(state);
  });

  test('a late history restore cannot discard an active forecast', () => {
    const state = recordForecast();
    expect(reducer(state, historyRestored([]))).toBe(state);
  });

  test('clears completed history when there is no pending forecast', () => {
    const state = reducer(undefined, historyRestored([makeResolved()]));
    expect(reducer(state, historyCleared()).forecasts).toEqual([]);
  });
});

describe('scheduled forecast starts', () => {
  test('stores a future target without recording a probability or a pending forecast', () => {
    const state = createSchedule();
    expect(selectScheduledForecast({ tracker: state })).toEqual(makeSchedule());
    expect(selectActiveForecast({ tracker: state })).toBeNull();
    expect(selectHasForecastInProgress({ tracker: state })).toBe(true);
    expect(state.forecasts).toEqual([]);
  });

  test('allows only one scheduled or pending forecast at a time', () => {
    const scheduled = createSchedule();
    expect(reducer(scheduled, scheduleCreated(makeSchedule({ id: 'second' })))).toBe(scheduled);
    expect(reducer(scheduled, forecastRecorded(makeForecast()))).toBe(scheduled);

    const pending = recordForecast();
    expect(reducer(pending, scheduleCreated(makeSchedule()))).toBe(pending);
    expect(selectHasForecastInProgress({ tracker: pending })).toBe(true);
  });

  test.each([
    ['a nonfuture start', { startsAt: createdAt, expiresAt }],
    [
      'a start beyond 24 hours',
      {
        startsAt: createdAt + 86_400_001,
        expiresAt: createdAt + 86_400_001 + 900_000,
      },
    ],
    ['a fractional start timestamp', { startsAt: startsAt + 0.5 }],
    ['a nonfinite timestamp', { createdAt: Infinity }],
    ['a negative timestamp', { createdAt: -1 }],
    ['a wrong expiry', { expiresAt: startsAt + 900_001 }],
    ['a zero target', { target: 0 }],
    ['a negative target', { target: -1 }],
    ['a target above the input limit', { target: 1_000_000_001 }],
    ['a nonfinite target', { target: NaN }],
    ['a string target', { target: '71000' }],
    ['a missing id', { id: '' }],
    ['an unsupported status', { status: 'pending' }],
    ['a preemptively missed status', { status: 'missed' }],
    ['an unexpected field', { aboveProbability: 0.9 }],
  ])('rejects schedules with %s', (_label, overrides) => {
    expect(createSchedule(overrides).scheduledForecast).toBeNull();
  });

  test('allows the 24-hour schedule and target limits', () => {
    const schedule = makeSchedule({
      startsAt: createdAt + 86_400_000,
      expiresAt: createdAt + 86_400_000 + 900_000,
      target: 1_000_000_000,
    });
    expect(reducer(undefined, scheduleCreated(schedule)).scheduledForecast).toEqual(schedule);
  });

  test('cancelling releases the schedule and does not create a journal entry', () => {
    const state = reducer(createSchedule(), scheduleCancelled());
    expect(state.scheduledForecast).toBeNull();
    expect(state.forecasts).toEqual([]);
    expect(selectHasForecastInProgress({ tracker: state })).toBe(false);
    expect(reducer(state, forecastRecorded(makeForecast())).forecasts).toHaveLength(1);
  });

  test.each([0, 7_000, 15_000])(
    'captures a scheduled forecast %i milliseconds after its start with a fixed expiry',
    (delay) => {
      const snapshot = makeScheduledSnapshot({ createdAt: startsAt + delay });
      const state = reducer(
        createSchedule(),
        scheduledForecastStarted({ forecast: snapshot, now: startsAt + delay }),
      );
      expect(state.scheduledForecast).toBeNull();
      expect(state.forecasts).toEqual([snapshot]);
      expect(state.forecasts[0].expiresAt).toBe(startsAt + 900_000);
      expect(selectActiveForecast({ tracker: state })).toEqual(snapshot);
    },
  );

  test.each([
    ['before the scheduled start', { createdAt: startsAt - 1 }, startsAt - 1],
    ['past the start grace period', { createdAt: startsAt + 15_001 }, startsAt + 15_001],
    ['with another id', { id: 'other' }, startsAt],
    ['with another target', { target: 72_000 }, startsAt],
    [
      'with a shifted observation window',
      { startsAt: startsAt - 1, expiresAt: startsAt - 1 + 900_000 },
      startsAt,
    ],
    ['with a shifted expiry', { expiresAt: startsAt + 900_001 }, startsAt],
    ['without an explicit planned start', { startsAt: undefined }, startsAt],
    ['with a different capture time', { createdAt: startsAt + 1 }, startsAt],
    ['with an already completed snapshot', { status: 'unobserved' }, startsAt],
    ['with an invalid current time', {}, NaN],
  ])('refuses a scheduled capture %s', (_label, overrides, now) => {
    const state = createSchedule();
    expect(
      reducer(state, scheduledForecastStarted({ forecast: makeScheduledSnapshot(overrides), now })),
    ).toBe(state);
  });

  test('requires an existing scheduled start and accepts a capture only once', () => {
    const action = scheduledForecastStarted({ forecast: makeScheduledSnapshot(), now: startsAt });
    expect(reducer(undefined, action).forecasts).toEqual([]);
    const started = reducer(createSchedule(), action);
    expect(reducer(started, action)).toBe(started);
  });

  test('a delayed capture resolves at its originally planned expiry and remains restorable', () => {
    const forecast = makeScheduledSnapshot({ createdAt: startsAt + 15_000 });
    let state = reducer(
      createSchedule(),
      scheduledForecastStarted({ forecast, now: startsAt + 15_000 }),
    );
    state = reducer(
      state,
      forecastsObserved({
        ticker: makeTicker({ time: forecast.expiresAt, receivedAt: forecast.expiresAt }),
        now: forecast.expiresAt,
      }),
    );
    expect(state.forecasts[0]).toMatchObject({
      status: 'resolved',
      startsAt,
      createdAt: startsAt + 15_000,
      expiresAt: startsAt + 900_000,
      observedAt: startsAt + 900_000,
    });
    const storage = makeStorage();
    expect(saveJournal(state.forecasts, storage)).toBeNull();
    storage.getItem.mockReturnValue(storage.setItem.mock.calls[0][1]);
    expect(loadJournal(storage).forecasts).toEqual(state.forecasts);
  });

  test('marks a missed start after the grace period without inventing a forecast', () => {
    const scheduled = createSchedule();
    expect(reducer(scheduled, scheduleStartMissed({ now: startsAt + 15_000 }))).toBe(scheduled);
    expect(reducer(scheduled, scheduleStartMissed({ now: NaN }))).toBe(scheduled);
    const missed = reducer(scheduled, scheduleStartMissed({ now: startsAt + 15_001 }));
    expect(missed.scheduledForecast).toEqual(makeSchedule({ status: 'missed' }));
    expect(missed.forecasts).toEqual([]);
    expect(selectHasForecastInProgress({ tracker: missed })).toBe(false);
    expect(
      reducer(
        missed,
        scheduledForecastStarted({ forecast: makeScheduledSnapshot(), now: startsAt }),
      ),
    ).toBe(missed);
  });

  test('a missed start can be cancelled or replaced by a new immediate or scheduled forecast', () => {
    const missed = reducer(createSchedule(), scheduleStartMissed({ now: startsAt + 15_001 }));
    expect(reducer(missed, scheduleCancelled()).scheduledForecast).toBeNull();
    const rescheduled = reducer(missed, scheduleCreated(makeSchedule({ id: 'replacement' })));
    expect(rescheduled.scheduledForecast.id).toBe('replacement');
    expect(rescheduled.scheduledForecast.status).toBe('scheduled');
    const immediate = reducer(missed, forecastRecorded(makeForecast()));
    expect(immediate.scheduledForecast).toBeNull();
    expect(immediate.forecasts).toEqual([makeForecast()]);
  });

  test('history clearing and late restoration preserve a schedule', () => {
    const state = reducer(
      undefined,
      historyRestored({ forecasts: [makeResolved()], scheduledForecast: makeSchedule() }),
    );
    const cleared = reducer(state, historyCleared());
    expect(cleared.forecasts).toEqual([]);
    expect(cleared.scheduledForecast).toEqual(makeSchedule());
    expect(reducer(cleared, historyRestored([]))).toBe(cleared);
  });

  test('a schedule cannot reuse an existing journal id', () => {
    const state = reducer(undefined, historyRestored([makeResolved({ id: 'scheduled-1' })]));
    expect(reducer(state, scheduleCreated(makeSchedule()))).toBe(state);
  });
});

describe('forecasts joining a selected end-time window', () => {
  test('records a forecast immediately with twelve minutes left until the chosen deadline', () => {
    const forecast = makeDeadlineForecast();
    const state = reducer(undefined, forecastRecorded(forecast));

    expect(selectActiveForecast({ tracker: state })).toEqual(forecast);
    expect(state.scheduledForecast).toBeNull();
    expect(state.forecasts[0].expiresAt - state.forecasts[0].createdAt).toBe(12 * 60_000);
    expect(state.forecasts[0].expiresAt - state.forecasts[0].startsAt).toBe(15 * 60_000);
  });

  test.each([0, 180_000, 899_999])(
    'permits a capture %i milliseconds into the selected 15-minute window',
    (elapsed) => {
      const forecast = makeDeadlineForecast({
        startsAt: createdAt,
        createdAt: createdAt + elapsed,
        expiresAt,
      });
      expect(getValidatedForecast(forecast)).toEqual(forecast);
    },
  );

  test.each([
    ['before the window', { createdAt: createdAt - 180_001 }],
    ['at the end', { createdAt: createdAt + 720_000 }],
    ['after the end', { createdAt: createdAt + 720_001 }],
    ['with a shorter total window', { startsAt: createdAt - 179_999 }],
    ['with a longer total window', { startsAt: createdAt - 180_001 }],
    ['with an invalid start', { startsAt: NaN }],
    ['with an extra field', { remainingMinutes: 12 }],
  ])('rejects an end-time capture %s', (_description, overrides) => {
    const forecast = makeDeadlineForecast(overrides);
    expect(getValidatedForecast(forecast)).toBeNull();
    expect(reducer(undefined, forecastRecorded(forecast)).forecasts).toEqual([]);
  });

  test.each([undefined, null, 'now', 'scheduled', 'deadline', 12])(
    'rejects an unsupported explicit timing mode: %s',
    (timingMode) => {
      expect(getValidatedForecast(makeDeadlineForecast({ timingMode }))).toBeNull();
    },
  );

  test('requires an explicit window start for end-time snapshots', () => {
    const forecast = makeDeadlineForecast();
    delete forecast.startsAt;
    expect(getValidatedForecast(forecast)).toBeNull();
  });

  test('retains the original capture grace when no end-time mode is declared', () => {
    const forecast = makeDeadlineForecast();
    delete forecast.timingMode;
    expect(getValidatedForecast(forecast)).toBeNull();
    expect(getValidatedForecast(makeForecast({ expiresAt: createdAt + 720_000 }))).toBeNull();
    expect(
      getValidatedForecast(
        makeForecast({ startsAt: createdAt - 15_000, expiresAt: expiresAt - 15_000 }),
      ),
    ).not.toBeNull();
  });

  test('an inherited timing mode cannot bypass the ordinary capture grace', () => {
    const forecast = makeDeadlineForecast();
    delete forecast.timingMode;
    Object.setPrototypeOf(forecast, { timingMode: 'end' });
    expect(getValidatedForecast(forecast)).toBeNull();
  });

  test('the end-time mode cannot bypass a scheduled start that was missed', () => {
    const state = createSchedule();
    const forecast = makeScheduledSnapshot({
      timingMode: 'end',
      createdAt: startsAt + 180_000,
    });
    expect(getValidatedForecast(forecast)).toEqual(forecast);
    expect(reducer(state, scheduledForecastStarted({ forecast, now: forecast.createdAt }))).toBe(
      state,
    );
  });

  test('reloads a joined window and settles at the original chosen deadline', () => {
    const forecast = makeDeadlineForecast();
    let state = reducer(undefined, forecastRecorded(forecast));
    const storage = makeStorage();
    expect(saveJournal(state.forecasts, storage)).toBeNull();
    const saved = JSON.parse(storage.setItem.mock.calls[0][1]);
    expect(saved).toEqual({ version: 7, forecasts: [forecast], scheduledForecast: null });

    storage.getItem.mockReturnValue(storage.setItem.mock.calls[0][1]);
    const loaded = loadJournal(storage);
    state = reducer(
      undefined,
      historyRestored({ forecasts: loaded.forecasts, scheduledForecast: loaded.scheduledForecast }),
    );
    expect(state.forecasts).toEqual([forecast]);
    expect(loaded.warning).toBeNull();

    state = reducer(
      state,
      forecastsObserved({
        ticker: makeTicker({ time: forecast.expiresAt, receivedAt: forecast.expiresAt }),
        now: forecast.expiresAt,
      }),
    );
    expect(state.forecasts[0]).toMatchObject({
      status: 'resolved',
      timingMode: 'end',
      startsAt: forecast.startsAt,
      createdAt,
      expiresAt: forecast.expiresAt,
      observedAt: forecast.expiresAt,
      outcome: 'above',
      correct: true,
    });
    expect(saveJournal(state.forecasts, storage)).toBeNull();
    storage.getItem.mockReturnValue(storage.setItem.mock.calls[1][1]);
    expect(loadJournal(storage).forecasts).toEqual(state.forecasts);
  });

  test.each([1, 2])('still restores version %i history without timing-mode fields', (version) => {
    const envelope = { version, forecasts: [makeForecast()] };
    if (version === 2) envelope.scheduledForecast = null;
    expect(loadJournal(makeStorage(JSON.stringify(envelope)))).toEqual({
      forecasts: [makeForecast()],
      scheduledForecast: null,
      warning: null,
    });
  });
});

describe('forecast journal scoring', () => {
  test('returns no accuracy or Brier score without outcomes', () => {
    expect(selectJournalSummary({ tracker: recordForecast() })).toEqual({
      analysisCount: 0,
      withheldCount: 0,
      callCount: 0,
      coverage: null,
      resolvedCount: 0,
      scoredCount: 0,
      correctCount: 0,
      accuracy: null,
      brierScore: null,
    });
  });

  test.each([
    { aboveProbability: NaN },
    { aboveProbability: 1.2, belowProbability: -0.2 },
    { aboveProbability: '0.7' },
    { belowProbability: undefined },
    { aboveProbability: 0.6, belowProbability: 0.6 },
  ])('does not produce a Brier score from invalid probabilities: %j', (overrides) => {
    const summary = selectJournalSummary({ tracker: { forecasts: [makeResolved(overrides)] } });
    expect(summary.brierScore).toBeNull();
  });
});

describe('forecast journal persistence', () => {
  test('round-trips versioned history and restores newest forecasts first', () => {
    const forecasts = [
      makeResolved({ id: 'older' }),
      makeForecast({ id: 'newer', createdAt: createdAt + 1000, expiresAt: expiresAt + 1000 }),
    ];
    const storage = makeStorage();
    expect(saveJournal(forecasts, storage)).toBeNull();
    expect(storage.setItem).toHaveBeenCalledWith('bitcoin-tracker:journal:v1', expect.any(String));

    storage.getItem.mockReturnValue(storage.setItem.mock.calls[0][1]);
    expect(loadJournal(storage)).toEqual({
      forecasts: [forecasts[1], forecasts[0]],
      scheduledForecast: null,
      warning: null,
    });
    expect(forecasts[0].id).toBe('older');
  });

  test('an empty device has an empty journal without a warning', () => {
    expect(loadJournal(makeStorage())).toEqual({
      forecasts: [],
      scheduledForecast: null,
      warning: null,
    });
  });

  test.each([
    'not-json',
    JSON.stringify({ version: 2, forecasts: [] }),
    JSON.stringify({ version: 1, forecasts: [], extra: true }),
    savedEnvelope([makeForecast({ target: '71000' })]),
    savedEnvelope([makeForecast({ expiresAt: expiresAt + 1 })]),
    savedEnvelope([makeForecast({ aboveProbability: 0.9 })]),
    savedEnvelope([makeForecast({ extra: 'untrusted' })]),
    savedEnvelope([makeForecast({ id: '' })]),
    savedEnvelope([makeForecast(), makeForecast()]),
    savedEnvelope([makeForecast(), makeForecast({ id: 'second-pending' })]),
    savedEnvelope([makeResolved({ outcome: 'below' })]),
    savedEnvelope([makeResolved({ correct: false })]),
    savedEnvelope([makeResolved({ observedAt: expiresAt - 1 })]),
    savedEnvelope([makeResolved({ observedAt: expiresAt + 15_001 })]),
    savedEnvelope([makeResolved({ observedPrice: 0 })]),
    savedEnvelope(
      Array.from({ length: 101 }, (_, index) => makeResolved({ id: `large-${index}` })),
    ),
  ])('rejects corrupt or inconsistent saved history %#', (saved) => {
    expect(loadJournal(makeStorage(saved))).toEqual({
      forecasts: [],
      scheduledForecast: null,
      warning: expect.stringContaining('invalid'),
    });
  });

  test('blocked reads and quota failures return warnings without crashing', () => {
    const storage = {
      getItem() {
        throw new Error('Access denied');
      },
      setItem() {
        throw new Error('Quota exceeded');
      },
    };
    expect(loadJournal(storage)).toEqual({
      forecasts: [],
      scheduledForecast: null,
      warning: expect.any(String),
    });
    expect(saveJournal([makeForecast()], storage)).toEqual(expect.any(String));
  });

  test('handles browsers that throw when accessing the localStorage property', () => {
    const storageGetter = jest.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    try {
      expect(loadJournal()).toEqual({
        forecasts: [],
        scheduledForecast: null,
        warning: expect.any(String),
      });
      expect(saveJournal([makeForecast()])).toEqual(expect.any(String));
    } finally {
      storageGetter.mockRestore();
    }
  });

  test('refuses to save invalid data without replacing existing history', () => {
    const storage = makeStorage(savedEnvelope([makeResolved()]));
    expect(saveJournal([makeForecast({ aboveProbability: Infinity })], storage)).toContain(
      'invalid',
    );
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('invalid history restoration preserves current state and warnings can be cleared', () => {
    const state = recordForecast();
    expect(reducer(state, historyRestored([makeForecast({ target: -1 })]))).toBe(state);
    const withWarning = reducer(state, storageWarningChanged('Storage blocked'));
    expect(withWarning.storageWarning).toBe('Storage blocked');
    expect(reducer(withWarning, storageWarningChanged(null)).storageWarning).toBeNull();
  });

  test.each(['scheduled', 'missed'])('round-trips a %s start separately from history', (status) => {
    const storage = makeStorage();
    const scheduledForecast = makeSchedule({ status });
    expect(saveJournal([makeResolved()], storage, scheduledForecast)).toBeNull();
    const saved = storage.setItem.mock.calls[0][1];
    expect(JSON.parse(saved)).toEqual({
      version: 7,
      forecasts: [makeResolved()],
      scheduledForecast,
    });
    storage.getItem.mockReturnValue(saved);
    const restored = loadJournal(storage);
    expect(restored).toEqual({ forecasts: [makeResolved()], scheduledForecast, warning: null });
    expect(
      reducer(
        undefined,
        historyRestored({
          forecasts: restored.forecasts,
          scheduledForecast: restored.scheduledForecast,
        }),
      ),
    ).toMatchObject({ forecasts: [makeResolved()], scheduledForecast });
  });

  test('migrates version 1 history without changing legacy capture and expiry times', () => {
    const storage = makeStorage(savedEnvelope([makeResolved()]));
    const restored = loadJournal(storage);
    expect(restored).toEqual({
      forecasts: [makeResolved()],
      scheduledForecast: null,
      warning: null,
    });
    expect(saveJournal(restored.forecasts, storage, restored.scheduledForecast)).toBeNull();
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
      version: 7,
      forecasts: [makeResolved()],
      scheduledForecast: null,
    });
  });

  test('retains the planned start and actual capture time when restoring a scheduled snapshot', () => {
    const snapshot = makeScheduledSnapshot({ createdAt: startsAt + 7_000 });
    const storage = makeStorage();
    expect(saveJournal([snapshot], storage)).toBeNull();
    storage.getItem.mockReturnValue(storage.setItem.mock.calls[0][1]);
    expect(loadJournal(storage).forecasts).toEqual([snapshot]);
    expect(getValidatedForecast(makeForecast())).toEqual(makeForecast());
  });

  test.each([
    { startsAt: createdAt + 1 },
    { startsAt: createdAt - 15_001, expiresAt: expiresAt - 15_001 },
    { startsAt: createdAt - 1 },
    { startsAt: undefined },
    { startsAt: NaN },
    { startsAt: createdAt, extra: true },
  ])('rejects inconsistent scheduled snapshots: %j', (overrides) => {
    expect(getValidatedForecast(makeForecast(overrides))).toBeNull();
  });

  test.each([
    { forecasts: [], scheduledForecast: makeSchedule({ target: 0 }) },
    { forecasts: [], scheduledForecast: makeSchedule({ extra: true }) },
    { forecasts: [], scheduledForecast: makeSchedule({ expiresAt: expiresAt + 1 }) },
    { forecasts: [], scheduledForecast: makeSchedule({ status: 'pending' }) },
    { forecasts: [], scheduledForecast: {} },
    { forecasts: [], scheduledForecast: undefined },
    { forecasts: [makeForecast()], scheduledForecast: makeSchedule() },
    { forecasts: [makeForecast()], scheduledForecast: makeSchedule({ status: 'missed' }) },
    {
      forecasts: [makeResolved({ id: 'scheduled-1' })],
      scheduledForecast: makeSchedule(),
    },
  ])('rejects corrupt schedules and schedule/history conflicts %#', (journal) => {
    const storage = makeStorage(JSON.stringify({ version: 2, ...journal }));
    expect(loadJournal(storage)).toEqual({
      forecasts: [],
      scheduledForecast: null,
      warning: expect.stringContaining('invalid'),
    });
    expect(reducer(undefined, historyRestored(journal))).toEqual({
      forecasts: [],
      scheduledForecast: null,
      storageWarning: null,
    });
    // An undefined schedule is rejected on load, but omitted on save means no schedule.
    if (journal.scheduledForecast !== undefined) {
      expect(saveJournal(journal.forecasts, storage, journal.scheduledForecast)).toContain(
        'invalid',
      );
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });
});
