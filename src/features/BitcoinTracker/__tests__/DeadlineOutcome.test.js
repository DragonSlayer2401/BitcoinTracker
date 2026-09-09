import { DEADLINE_OUTCOME_DEFINITION, isVerifiedDeadlineOutcome } from '../utils/outcome.utils';
import {
  getValidatedForecast,
  getValidatedScheduledForecast,
  loadJournal,
  saveJournal,
} from '../utils/journal.utils';
import {
  getFixedForecastAnalysis,
  FIXED_PREDICTION_POLICY_VERSION,
  MARKET_AWARE_POLICY_VERSION,
} from '../utils/fixedPrediction.utils';
import reducer, {
  forecastRecorded,
  forecastsObserved,
  fixedForecastPublished,
  scheduleCreated,
  scheduledForecastStarted,
} from '../state/slices/trackerSlice';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 8, 12, 0);
const END = START + 15 * MINUTE;
const OBSERVED_NOW = END + 1000;

function makePending(overrides = {}) {
  return {
    id: 'deadline-forecast',
    createdAt: START + 3 * MINUTE,
    startsAt: START,
    expiresAt: END,
    timingMode: 'end',
    target: 49_750,
    price: 50_000,
    aboveProbability: 0.8,
    belowProbability: 0.2,
    direction: 'above',
    modelVersion: 'zero-drift-log-return-v1',
    status: 'pending',
    analysis: getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: END,
      policyVersion: MARKET_AWARE_POLICY_VERSION,
    }),
    outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
    ...overrides,
  };
}

function makeProof(overrides = {}) {
  return {
    status: 'observed',
    observedPrice: 49_800,
    observedAt: END - 1000,
    observedTradeId: 100,
    completeSince: START - 3 * MINUTE,
    confirmedThrough: OBSERVED_NOW,
    ...overrides,
  };
}

function makeLegacyPending() {
  const legacy = makePending({
    analysis: getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: END,
      policyVersion: FIXED_PREDICTION_POLICY_VERSION,
    }),
  });
  delete legacy.outcomeDefinition;
  return legacy;
}

function makeStorage(envelope) {
  let value = envelope === undefined ? null : JSON.stringify(envelope);
  return {
    getItem: jest.fn(() => value),
    setItem: jest.fn((_key, next) => {
      value = next;
    }),
  };
}

function observe(state, proof, overrides = {}) {
  return reducer(
    state,
    forecastsObserved({
      now: OBSERVED_NOW,
      // A deliberately opposite REST trade proves the new result comes from the deadline proof.
      ticker: { price: 49_000, time: END + 500, receivedAt: OBSERVED_NOW },
      deadlineOutcome: proof,
      ...overrides,
    }),
  );
}

describe('deadline outcome verification', () => {
  test.each([END, END - 1000, END - 5000])(
    'accepts a recent trade at %s with uninterrupted proof through the deadline',
    (observedAt) => {
      expect(isVerifiedDeadlineOutcome(makeProof({ observedAt }), END, OBSERVED_NOW)).toBe(true);
    },
  );

  test.each([
    ['trade after the deadline', { observedAt: END + 1 }],
    ['trade older than five seconds', { observedAt: END - 5001 }],
    ['proof that stops at the deadline', { confirmedThrough: END }],
    ['proof from the future', { confirmedThrough: OBSERVED_NOW + 1 }],
    ['continuity beginning after the selected trade', { completeSince: END - 999 }],
    ['missing trade identifier', { observedTradeId: undefined }],
    ['fractional trade identifier', { observedTradeId: 100.5 }],
    ['negative trade identifier', { observedTradeId: -1 }],
    ['missing continuity proof', { completeSince: undefined }],
    ['invalid price', { observedPrice: NaN }],
    ['zero price', { observedPrice: 0 }],
    ['unconfirmed status', { status: 'waiting' }],
  ])('rejects %s and cannot silently substitute a REST price', (_label, changes) => {
    const proof = makeProof(changes);
    expect(isVerifiedDeadlineOutcome(proof, END, OBSERVED_NOW)).toBe(false);
    const state = reducer(undefined, forecastRecorded(makePending()));
    expect(observe(state, proof)).toBe(state);
  });

  test.each([undefined, null, {}, { status: 'observed' }])(
    'rejects an incomplete proof: %s',
    (proof) => {
      expect(isVerifiedDeadlineOutcome(proof, END, OBSERVED_NOW)).toBe(false);
    },
  );

  test.each([
    [END, END - 1],
    [String(END), OBSERVED_NOW],
    [END, Infinity],
    [NaN, OBSERVED_NOW],
    [END, OBSERVED_NOW + 0.5],
    [-1, OBSERVED_NOW],
  ])('rejects invalid or premature deadline/time boundaries %s / %s', (end, now) => {
    expect(isVerifiedDeadlineOutcome(makeProof(), end, now)).toBe(false);
  });
});

describe('strict outcome reduction', () => {
  test('uses the last proven pre-deadline trade and retains proof and definition immutably', () => {
    const snapshot = makePending();
    const state = reducer(undefined, forecastRecorded(snapshot));
    const resolved = observe(state, makeProof());
    expect(resolved.forecasts[0]).toMatchObject({
      ...snapshot,
      status: 'resolved',
      observedPrice: 49_800,
      observedAt: END - 1000,
      observedTradeId: 100,
      completeSince: START - 3 * MINUTE,
      confirmedThrough: OBSERVED_NOW,
      outcome: 'above',
      correct: true,
    });
    expect(getValidatedForecast(resolved.forecasts[0])).toEqual(resolved.forecasts[0]);
    expect(observe(resolved, makeProof({ observedPrice: 1 }))).toBe(resolved);
  });

  test('cannot settle a new forecast from an otherwise eligible REST sample', () => {
    const state = reducer(undefined, forecastRecorded(makePending()));
    expect(observe(state, null)).toBe(state);
    expect(observe(state, { status: 'waiting' })).toBe(state);
  });

  test('retains a failed continuity check as unobserved without invented outcome fields', () => {
    const state = reducer(undefined, forecastRecorded(makePending()));
    const unobserved = observe(state, { status: 'unobserved', reason: 'Trade sequence gap.' });
    expect(unobserved.forecasts[0]).toMatchObject({
      status: 'unobserved',
      outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
    });
    expect(unobserved.forecasts[0].observedPrice).toBeUndefined();
    expect(unobserved.forecasts[0].correct).toBeUndefined();
    expect(observe(unobserved, makeProof())).toBe(unobserved);
  });

  test('preserves the original post-deadline REST sampling semantics for legacy forecasts', () => {
    const legacy = makeLegacyPending();
    const state = reducer(undefined, forecastRecorded(legacy));
    const resolved = observe(state, makeProof());
    expect(resolved.forecasts[0]).toMatchObject({
      ...legacy,
      status: 'resolved',
      observedPrice: 49_000,
      observedAt: END + 500,
      outcome: 'below',
      correct: false,
    });
    expect(resolved.forecasts[0].outcomeDefinition).toBeUndefined();
    expect(resolved.forecasts[0].observedTradeId).toBeUndefined();
    expect(getValidatedForecast(resolved.forecasts[0])).toEqual(resolved.forecasts[0]);
  });

  test('keeps a target-equal deadline outcome unscored', () => {
    const state = reducer(undefined, forecastRecorded(makePending()));
    expect(observe(state, makeProof({ observedPrice: 49_750 })).forecasts[0]).toMatchObject({
      status: 'resolved',
      outcome: 'equal',
      correct: null,
    });
  });
});

describe('deadline definition persistence and immutability', () => {
  test('requires the deadline definition for the market-aware policy and rejects unknown definitions', () => {
    const missing = makePending();
    delete missing.outcomeDefinition;
    expect(getValidatedForecast(missing)).toBeNull();
    expect(
      getValidatedForecast(makePending({ outcomeDefinition: 'sample-after-deadline' })),
    ).toBeNull();
    expect(
      getValidatedForecast({
        ...makeLegacyPending(),
        outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
      }),
    ).toBeNull();
  });

  test('round-trips proof under journal v5 and refuses to relabel it before its v4 introduction', () => {
    const resolved = observe(reducer(undefined, forecastRecorded(makePending())), makeProof())
      .forecasts[0];
    const storage = makeStorage();
    expect(saveJournal([resolved], storage)).toBeNull();
    const envelope = JSON.parse(storage.setItem.mock.calls[0][1]);
    expect(envelope.version).toBe(5);
    expect(loadJournal(storage)).toEqual({
      forecasts: [resolved],
      scheduledForecast: null,
      warning: null,
    });
    expect(loadJournal(makeStorage({ ...envelope, version: 3 })).warning).toContain('invalid');
  });

  test('loads legacy version 3 analysis without adding a new outcome meaning', () => {
    const legacy = makeLegacyPending();
    const storage = makeStorage({ version: 3, forecasts: [legacy], scheduledForecast: null });
    expect(loadJournal(storage)).toEqual({
      forecasts: [legacy],
      scheduledForecast: null,
      warning: null,
    });
    expect(saveJournal([legacy], storage)).toBeNull();
    expect(JSON.parse(storage.setItem.mock.calls[0][1]).version).toBe(5);
    expect(loadJournal(storage).forecasts[0].outcomeDefinition).toBeUndefined();
  });

  test('rejects corrupted saved proof even when the result labels are otherwise correct', () => {
    const resolved = observe(reducer(undefined, forecastRecorded(makePending())), makeProof())
      .forecasts[0];
    for (const changes of [
      { observedAt: END + 1 },
      { observedAt: END - 5001 },
      { completeSince: END },
      { confirmedThrough: END },
    ]) {
      const corrupt = { ...resolved, ...changes };
      expect(getValidatedForecast(corrupt)).toBeNull();
      expect(
        loadJournal(makeStorage({ version: 4, forecasts: [corrupt], scheduledForecast: null }))
          .warning,
      ).toContain('invalid');
    }
    const missing = { ...resolved };
    delete missing.observedTradeId;
    expect(getValidatedForecast(missing)).toBeNull();
  });

  test('cannot change the saved policy and outcome meaning when publishing a fixed call', () => {
    const analyzing = makePending({
      createdAt: START,
      status: 'analyzing',
      aboveProbability: null,
      belowProbability: null,
      direction: 'neutral',
    });
    const state = reducer(undefined, forecastRecorded(analyzing));
    expect(getValidatedForecast(makeLegacyPending())).not.toBeNull();
    expect(
      reducer(
        state,
        fixedForecastPublished({
          id: analyzing.id,
          now: START + 3 * MINUTE,
          forecast: makeLegacyPending(),
        }),
      ),
    ).toBe(state);
    expect(
      reducer(
        state,
        fixedForecastPublished({
          id: analyzing.id,
          now: START + 3 * MINUTE,
          forecast: makePending(),
        }),
      ).forecasts[0],
    ).toEqual(makePending());
  });

  test('a scheduled start preserves its saved outcome definition through capture and reload', () => {
    const schedule = {
      id: 'deadline-forecast',
      createdAt: START - MINUTE,
      startsAt: START,
      expiresAt: END,
      target: 49_750,
      status: 'scheduled',
      outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
    };
    expect(getValidatedScheduledForecast(schedule)).toEqual(schedule);
    const storage = makeStorage();
    expect(saveJournal([], storage, schedule)).toBeNull();
    expect(loadJournal(storage).scheduledForecast).toEqual(schedule);
    const state = reducer(undefined, scheduleCreated(schedule));
    const analyzing = makePending({
      createdAt: START,
      status: 'analyzing',
      aboveProbability: null,
      belowProbability: null,
      direction: 'neutral',
    });
    const legacy = {
      ...analyzing,
      analysis: getFixedForecastAnalysis({ startedAt: START, expiresAt: END }),
    };
    delete legacy.outcomeDefinition;
    expect(getValidatedForecast(legacy)).not.toBeNull();
    expect(reducer(state, scheduledForecastStarted({ now: START, forecast: legacy }))).toBe(state);
    const started = reducer(state, scheduledForecastStarted({ now: START, forecast: analyzing }));
    expect(started.forecasts).toEqual([analyzing]);
    expect(started.scheduledForecast).toBeNull();
  });
});
