import reducer, {
  fixedForecastPublished,
  fixedForecastWithheld,
  forecastRecorded,
  forecastsObserved,
  historyCleared,
  historyRestored,
  scheduleCreated,
  scheduledForecastStarted,
} from '../state/slices/trackerSlice';
import {
  selectActiveForecast,
  selectHasForecastInProgress,
  selectJournalSummary,
} from '../state/selectors/trackerSelectors';
import {
  getValidatedForecast,
  getValidatedJournal,
  getValidatedJournalState,
  loadJournal,
  saveJournal,
} from '../utils/journal.utils';
import { getFixedForecastAnalysis } from '../utils/fixedPrediction.utils';

const startedAt = Date.UTC(2026, 8, 10, 12, 0);
const expiresAt = startedAt + 900_000;

function makeAnalysisForecast(overrides = {}) {
  const forecast = {
    id: 'observed-1',
    createdAt: startedAt,
    startsAt: startedAt,
    expiresAt,
    timingMode: 'end',
    price: 70_000,
    target: 71_000,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion: 'test-model-v1',
    status: 'analyzing',
    ...overrides,
  };
  return {
    ...forecast,
    analysis:
      overrides.analysis ??
      getFixedForecastAnalysis({ startedAt: forecast.createdAt, expiresAt: forecast.expiresAt }),
  };
}

function makePublished(forecast = makeAnalysisForecast(), now = forecast.analysis.earliestAt) {
  return {
    ...forecast,
    status: 'pending',
    createdAt: now,
    price: 71_100,
    aboveProbability: 0.75,
    belowProbability: 0.25,
    direction: 'above',
  };
}

function recordAnalysis(forecast = makeAnalysisForecast()) {
  return reducer(undefined, forecastRecorded(forecast));
}

function publish(state, forecast = makePublished(), now = forecast.createdAt) {
  return reducer(state, fixedForecastPublished({ id: 'observed-1', forecast, now }));
}

function makeStorage() {
  let saved = null;
  return {
    getItem: jest.fn(() => saved),
    setItem: jest.fn((_key, value) => {
      saved = value;
    }),
  };
}

describe('delayed fixed forecast lifecycle', () => {
  test('records analysis without inventing a fixed probability or changing the chosen window', () => {
    const forecast = makeAnalysisForecast({
      startsAt: startedAt - 180_000,
      expiresAt: startedAt + 720_000,
    });
    const state = recordAnalysis(forecast);

    expect(state.forecasts).toEqual([forecast]);
    expect(selectActiveForecast({ tracker: state })).toEqual(forecast);
    expect(selectHasForecastInProgress({ tracker: state })).toBe(true);
    expect(forecast.analysis).toEqual({
      startedAt,
      earliestAt: startedAt + 180_000,
      deadline: startedAt + 300_000,
      policyVersion: 'observed-consensus-v1',
    });
  });

  test('analysis blocks another recording, future schedule and late history restore', () => {
    const state = recordAnalysis();
    expect(reducer(state, forecastRecorded(makeAnalysisForecast({ id: 'other' })))).toBe(state);
    expect(reducer(state, forecastRecorded(makePublished()))).toBe(state);
    expect(reducer(state, historyRestored([]))).toBe(state);
    expect(
      reducer(
        state,
        scheduleCreated({
          id: 'future',
          target: 71_000,
          createdAt: startedAt,
          startsAt: startedAt + 60_000,
          expiresAt: expiresAt + 60_000,
          status: 'scheduled',
        }),
      ),
    ).toBe(state);
  });

  test('a scheduled window starts analysis only inside the original capture grace', () => {
    const schedule = {
      id: 'observed-1',
      target: 71_000,
      createdAt: startedAt - 60_000,
      startsAt: startedAt,
      expiresAt,
      status: 'scheduled',
    };
    const state = reducer(undefined, scheduleCreated(schedule));
    const forecast = makeAnalysisForecast({ createdAt: startedAt + 15_000 });
    expect(
      reducer(state, scheduledForecastStarted({ forecast, now: forecast.createdAt })),
    ).toMatchObject({ forecasts: [forecast], scheduledForecast: null });
    const late = makeAnalysisForecast({ createdAt: startedAt + 15_001 });
    expect(reducer(state, scheduledForecastStarted({ forecast: late, now: late.createdAt }))).toBe(
      state,
    );
  });

  test.each([180_000, 240_000, 300_000])(
    'publishes inside the permitted observation interval at %i ms',
    (elapsed) => {
      const forecast = makePublished(makeAnalysisForecast(), startedAt + elapsed);
      const state = publish(recordAnalysis(), forecast);
      expect(state.forecasts).toEqual([forecast]);
      expect(selectActiveForecast({ tracker: state })).toEqual(forecast);
      expect(forecast.analysis.startedAt).toBe(startedAt);
      expect(forecast.expiresAt).toBe(expiresAt);
    },
  );

  test.each([179_999, 300_001])('rejects publication outside the interval at %i ms', (elapsed) => {
    const state = recordAnalysis();
    expect(publish(state, makePublished(makeAnalysisForecast(), startedAt + elapsed))).toBe(state);
  });

  test.each([
    { id: 'different' },
    { target: 72_000 },
    { startsAt: startedAt + 1, expiresAt: expiresAt + 1 },
    { expiresAt: expiresAt + 1 },
    { timingMode: undefined },
    { modelVersion: 'different-model' },
    { createdAt: startedAt + 180_001 },
    { status: 'analyzing' },
    { aboveProbability: null },
    { aboveProbability: 0.9, belowProbability: 0.9 },
    { aboveProbability: 0.649999, belowProbability: 0.350001 },
    { aboveProbability: 0.350001, belowProbability: 0.649999, direction: 'below' },
    { aboveProbability: 0.35, belowProbability: 0.65, direction: 'above' },
    { aboveProbability: 0.65, belowProbability: 0.35, direction: 'below' },
    { direction: 'neutral' },
    { price: 0 },
    { analysis: getFixedForecastAnalysis({ startedAt: startedAt + 1, expiresAt }) },
  ])('cannot publish a changed or invalid fixed context: %j', (overrides) => {
    const state = recordAnalysis();
    const forecast = { ...makePublished(), ...overrides };
    expect(publish(state, forecast, startedAt + 180_000)).toBe(state);
  });

  test('publication becomes immutable and later quote updates settle the original fixed call', () => {
    const published = publish(recordAnalysis());
    expect(publish(published, { ...makePublished(), direction: 'below', target: 80_000 })).toBe(
      published,
    );
    expect(
      reducer(
        published,
        fixedForecastWithheld({
          id: 'observed-1',
          now: startedAt + 300_000,
          reason: 'no-consensus',
        }),
      ),
    ).toBe(published);
    const state = reducer(
      published,
      forecastsObserved({
        ticker: { price: 72_000, time: expiresAt, receivedAt: expiresAt },
        now: expiresAt,
      }),
    );
    expect(state.forecasts[0]).toMatchObject({
      ...makePublished(),
      status: 'resolved',
      observedPrice: 72_000,
      observedAt: expiresAt,
      outcome: 'above',
      correct: true,
    });
  });

  test('an unissued analysis never becomes an observed prediction', () => {
    const state = recordAnalysis();
    expect(
      reducer(
        state,
        forecastsObserved({
          ticker: { price: 72_000, time: expiresAt, receivedAt: expiresAt },
          now: expiresAt,
        }),
      ),
    ).toBe(state);
    expect(reducer(state, forecastsObserved({ ticker: null, now: expiresAt + 60_000 }))).toBe(
      state,
    );
  });

  test.each(['no-consensus', 'market-data-unavailable', 'model-unavailable'])(
    'records an unscored no-call for %s at or after the deadline',
    (reason) => {
      const state = recordAnalysis();
      const action = { id: 'observed-1', now: startedAt + 300_000, reason };
      expect(reducer(state, fixedForecastWithheld({ ...action, now: action.now - 1 }))).toBe(state);
      for (const now of [action.now, expiresAt + 60_000]) {
        const withheld = reducer(state, fixedForecastWithheld({ ...action, now }));
        expect(withheld.forecasts[0]).toEqual({
          ...makeAnalysisForecast(),
          status: 'withheld',
          withholdingReason: reason,
        });
        expect(selectActiveForecast({ tracker: withheld })).toBeNull();
        expect(selectHasForecastInProgress({ tracker: withheld })).toBe(false);
      }
    },
  );

  test.each([59_999, 60_000, 239_999])(
    'immediately withholds a late join with %i ms remaining',
    (remaining) => {
      const forecast = makeAnalysisForecast({
        startsAt: startedAt + remaining - 900_000,
        expiresAt: startedAt + remaining,
      });
      const state = recordAnalysis(forecast);
      expect(forecast.analysis.earliestAt).toBeGreaterThan(forecast.analysis.deadline);
      expect(
        reducer(
          state,
          fixedForecastWithheld({ id: forecast.id, now: startedAt, reason: 'insufficient-time' }),
        ).forecasts[0],
      ).toEqual({ ...forecast, status: 'withheld', withholdingReason: 'insufficient-time' });
      expect(publish(state, makePublished(forecast))).toBe(state);
    },
  );

  test('exactly four minutes remaining allows three minutes observation plus one minute lead', () => {
    const forecast = makeAnalysisForecast({
      startsAt: startedAt - 660_000,
      expiresAt: startedAt + 240_000,
    });
    const state = recordAnalysis(forecast);
    expect(forecast.analysis.deadline).toBe(forecast.analysis.earliestAt);
    expect(publish(state, makePublished(forecast)).forecasts[0].status).toBe('pending');
    expect(
      reducer(
        state,
        fixedForecastWithheld({ id: forecast.id, now: startedAt, reason: 'insufficient-time' }),
      ),
    ).toBe(state);
  });

  test.each([
    { id: 'missing', now: startedAt + 300_000, reason: 'no-consensus' },
    { id: 'observed-1', now: NaN, reason: 'no-consensus' },
    { id: 'observed-1', now: startedAt - 1, reason: 'no-consensus' },
    { id: 'observed-1', now: startedAt + 300_000, reason: 'unsupported' },
    { id: 'observed-1', now: startedAt + 300_000, reason: 'insufficient-time' },
  ])('rejects invalid withholding: %j', (payload) => {
    const state = recordAnalysis();
    expect(reducer(state, fixedForecastWithheld(payload))).toBe(state);
  });

  test('clearing completed entries preserves analysis and its eventual issued call', () => {
    const old = {
      ...makeAnalysisForecast({ id: 'old' }),
      status: 'withheld',
      withholdingReason: 'no-consensus',
    };
    let state = reducer(undefined, historyRestored([old]));
    state = reducer(state, forecastRecorded(makeAnalysisForecast()));
    state = reducer(state, historyCleared());
    expect(state.forecasts).toEqual([makeAnalysisForecast()]);
    state = publish(state);
    expect(reducer(state, historyCleared()).forecasts).toEqual([makePublished()]);
  });
});

describe('analysis persistence and scoring', () => {
  test.each([
    ['above', 0.65, 0.35],
    ['below', 0.35, 0.65],
  ])(
    'accepts the exact policy threshold for a %s call',
    (direction, aboveProbability, belowProbability) => {
      const forecast = { ...makePublished(), direction, aboveProbability, belowProbability };
      expect(getValidatedForecast(forecast)).toEqual(forecast);
      expect(publish(recordAnalysis(), forecast).forecasts).toEqual([forecast]);
    },
  );

  test('rejects saved issued calls whose probabilities do not support the claimed direction', () => {
    const storage = makeStorage();
    for (const forecast of [
      { ...makePublished(), direction: 'below' },
      { ...makePublished(), aboveProbability: 0.6, belowProbability: 0.4 },
    ]) {
      expect(saveJournal([forecast], storage)).toContain('invalid');
      storage.getItem.mockReturnValue(
        JSON.stringify({ version: 3, forecasts: [forecast], scheduledForecast: null }),
      );
      expect(loadJournal(storage).warning).toContain('invalid');
    }
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('preserves the earlier probability validation for legacy records without analysis', () => {
    const legacy = { ...makePublished(), aboveProbability: 0.6, belowProbability: 0.4 };
    delete legacy.analysis;
    expect(getValidatedForecast(legacy)).toEqual(legacy);
  });

  test('persists a model-unavailable no-call separately from a market-data failure', () => {
    const forecast = {
      ...makeAnalysisForecast(),
      status: 'withheld',
      withholdingReason: 'model-unavailable',
    };
    const storage = makeStorage();
    expect(saveJournal([forecast], storage)).toBeNull();
    expect(loadJournal(storage)).toEqual({
      forecasts: [forecast],
      scheduledForecast: null,
      warning: null,
    });
  });

  test.each(['analyzing', 'pending', 'resolved', 'unobserved', 'withheld'])(
    'round-trips %s through version 5 without changing its deadline or policy',
    (status) => {
      const forecast =
        status === 'analyzing' || status === 'withheld' ? makeAnalysisForecast() : makePublished();
      forecast.status = status;
      if (status === 'withheld') forecast.withholdingReason = 'no-consensus';
      if (status === 'resolved')
        Object.assign(forecast, {
          observedPrice: 72_000,
          observedAt: expiresAt,
          outcome: 'above',
          correct: true,
        });
      const storage = makeStorage();
      expect(saveJournal([forecast], storage)).toBeNull();
      expect(JSON.parse(storage.setItem.mock.calls[0][1]).version).toBe(5);
      const restored = loadJournal(storage);
      expect(restored).toEqual({ forecasts: [forecast], scheduledForecast: null, warning: null });
      expect(reducer(undefined, historyRestored(restored.forecasts)).forecasts).toEqual([forecast]);
    },
  );

  test.each([
    { analysis: null },
    { analysis: {} },
    { analysis: { ...getFixedForecastAnalysis({ startedAt, expiresAt }), extra: true } },
    {
      analysis: { ...getFixedForecastAnalysis({ startedAt, expiresAt }), policyVersion: 'unknown' },
    },
    { analysis: { ...getFixedForecastAnalysis({ startedAt, expiresAt }), earliestAt: startedAt } },
    { analysis: { ...getFixedForecastAnalysis({ startedAt, expiresAt }), deadline: expiresAt } },
    {
      analysis: { ...getFixedForecastAnalysis({ startedAt, expiresAt }), startedAt: startedAt - 1 },
    },
    { aboveProbability: 0.6, belowProbability: 0.4 },
    { direction: 'above' },
    { createdAt: startedAt + 1 },
    { startsAt: undefined },
    { timingMode: undefined },
    { withholdingReason: 'no-consensus' },
    { status: 'withheld' },
    { status: 'withheld', withholdingReason: 'insufficient-time' },
  ])('rejects invalid analysis metadata or lifecycle fields: %j', (overrides) => {
    expect(getValidatedForecast({ ...makeAnalysisForecast(), ...overrides })).toBeNull();
  });

  test('does not share mutable analysis metadata with the supplied object', () => {
    const input = makeAnalysisForecast();
    const validated = getValidatedForecast(input);
    input.analysis.deadline = expiresAt;
    expect(validated.analysis.deadline).toBe(startedAt + 300_000);
  });

  test('requires analysis metadata and its fields to be owned properties', () => {
    const input = makeAnalysisForecast();
    const analysis = input.analysis;
    delete input.analysis;
    Object.setPrototypeOf(input, { analysis });
    expect(getValidatedForecast(input)).toBeNull();

    const invalidAnalysis = { ...analysis };
    delete invalidAnalysis.policyVersion;
    Object.setPrototypeOf(invalidAnalysis, { policyVersion: analysis.policyVersion });
    expect(getValidatedForecast(makeAnalysisForecast({ analysis: invalidAnalysis }))).toBeNull();
  });

  test('rejects two active analyses or a conflict with a scheduled forecast', () => {
    expect(
      getValidatedJournal([makeAnalysisForecast(), makeAnalysisForecast({ id: 'other' })]),
    ).toBeNull();
    expect(
      getValidatedJournal([makeAnalysisForecast(), { ...makePublished(), id: 'other' }]),
    ).toBeNull();
    expect(
      getValidatedJournalState({
        forecasts: [makeAnalysisForecast()],
        scheduledForecast: {
          id: 'other',
          target: 71_000,
          createdAt: startedAt,
          startsAt: startedAt + 60_000,
          expiresAt: expiresAt + 60_000,
          status: 'scheduled',
        },
      }),
    ).toBeNull();
  });

  test.each([1, 2])('rejects new analysis records in a version %i envelope', (version) => {
    const envelope = { version, forecasts: [makeAnalysisForecast()] };
    if (version === 2) envelope.scheduledForecast = null;
    const storage = { getItem: () => JSON.stringify(envelope) };
    expect(loadJournal(storage).warning).toContain('invalid');
  });

  test('coverage counts completed analysis decisions and excludes active analysis and legacy calls', () => {
    const issued = makePublished();
    const resolved = {
      ...issued,
      id: 'resolved',
      status: 'resolved',
      observedPrice: 72_000,
      observedAt: expiresAt,
      outcome: 'above',
      correct: true,
    };
    const legacy = { ...resolved, id: 'legacy' };
    delete legacy.analysis;
    const forecasts = [
      makeAnalysisForecast(),
      issued,
      resolved,
      { ...issued, id: 'unobserved', status: 'unobserved' },
      {
        ...makeAnalysisForecast(),
        id: 'withheld',
        status: 'withheld',
        withholdingReason: 'no-consensus',
      },
      legacy,
    ];
    expect(selectJournalSummary({ tracker: { forecasts } })).toEqual({
      analysisCount: 1,
      withheldCount: 1,
      callCount: 3,
      coverage: 0.75,
      resolvedCount: 2,
      scoredCount: 2,
      correctCount: 2,
      accuracy: 1,
      brierScore: 0.0625,
    });
    expect(
      selectJournalSummary({ tracker: { forecasts: [makeAnalysisForecast()] } }),
    ).toMatchObject({
      coverage: null,
      accuracy: null,
      brierScore: null,
    });
  });
});
