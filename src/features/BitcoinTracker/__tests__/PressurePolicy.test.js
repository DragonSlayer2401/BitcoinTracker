import {
  FIXED_PREDICTION_POLICY_VERSION,
  MARKET_AWARE_POLICY_VERSION,
  PRESSURE_POLICY_VERSION,
  getFixedForecastAnalysis,
  getFixedPredictionProgress,
  getQualifyingDirection,
} from '../utils/fixedPrediction.utils';
import {
  getValidatedForecast,
  getValidatedScheduledForecast,
  loadJournal,
  saveJournal,
} from '../utils/journal.utils';
import { PRESSURE_MODEL_VERSION } from '../utils/pressureForecast.utils';
import { DEADLINE_OUTCOME_DEFINITION } from '../utils/outcome.utils';
import reducer, {
  fixedForecastPublished,
  fixedForecastWithheld,
  forecastRecorded,
  forecastsObserved,
  scheduleCreated,
  scheduledForecastStarted,
} from '../state/slices/trackerSlice';

const MINUTE = 60_000;
const START = Date.UTC(2026, 8, 8, 12);
const END = START + 15 * MINUTE;
const analysis = getFixedForecastAnalysis({
  startedAt: START,
  expiresAt: END,
  policyVersion: PRESSURE_POLICY_VERSION,
});
const estimate = (aboveProbability = 0.51, overrides = {}) => ({
  available: true,
  aboveProbability,
  belowProbability: 1 - aboveProbability,
  ...overrides,
});
const progress = (overrides = {}) =>
  getFixedPredictionProgress({
    analysis,
    samples: [],
    estimate: estimate(),
    now: START,
    ...overrides,
  });
const makeAnalyzing = (overrides = {}) => ({
  id: 'pressure-call',
  createdAt: START,
  startsAt: START,
  expiresAt: END,
  timingMode: 'end',
  price: 50_000,
  target: 50_001,
  aboveProbability: null,
  belowProbability: null,
  direction: 'neutral',
  status: 'analyzing',
  modelVersion: PRESSURE_MODEL_VERSION,
  calculationMode: null,
  outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  analysis,
  ...overrides,
});
const makePending = (aboveProbability = 0.51, overrides = {}) => ({
  ...makeAnalyzing(),
  createdAt: analysis.earliestAt,
  status: 'pending',
  calculationMode: 'pressure-adjusted',
  aboveProbability,
  belowProbability: 1 - aboveProbability,
  direction: aboveProbability > 0.5 ? 'above' : aboveProbability < 0.5 ? 'below' : 'neutral',
  ...overrides,
});
const makeSchedule = (overrides = {}) => ({
  id: 'pressure-call',
  createdAt: START - MINUTE,
  startsAt: START,
  expiresAt: END,
  target: 50_001,
  status: 'scheduled',
  outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  policyVersion: PRESSURE_POLICY_VERSION,
  ...overrides,
});
function makeStorage(envelope) {
  let saved = envelope ? JSON.stringify(envelope) : null;
  return {
    getItem: jest.fn(() => saved),
    setItem: jest.fn((_key, value) => {
      saved = value;
    }),
  };
}

describe('pressure snapshot publication', () => {
  test.each([
    [0.51, 'above'],
    [0.49, 'below'],
    [0.5, 'neutral'],
  ])(
    'publishes a %s estimate after observation without requiring a strong or persistent direction',
    (probability, direction) => {
      const prediction = estimate(probability);
      expect(getQualifyingDirection(prediction, PRESSURE_POLICY_VERSION)).toBe(direction);
      expect(progress({ now: analysis.earliestAt - 1, estimate: prediction }).phase).toBe(
        'observing',
      );
      expect(progress({ now: analysis.earliestAt, estimate: prediction })).toMatchObject({
        phase: 'ready',
        confirmationRemainingMs: 0,
        sampleCount: 0,
      });
      const initial = reducer(undefined, forecastRecorded(makeAnalyzing()));
      const snapshot = makePending(probability);
      const state = reducer(
        initial,
        fixedForecastPublished({
          id: snapshot.id,
          now: snapshot.createdAt,
          forecast: snapshot,
        }),
      );
      expect(state.forecasts).toEqual([snapshot]);
      expect(
        reducer(
          state,
          fixedForecastPublished({
            id: snapshot.id,
            now: snapshot.createdAt + 1000,
            forecast: makePending(0.9, { createdAt: snapshot.createdAt + 1000 }),
          }),
        ),
      ).toBe(state);
    },
  );

  test('direction reversals and a just-started sample run do not extend the initial wait', () => {
    expect(progress({ now: analysis.earliestAt - 1000, estimate: estimate(0.8) }).phase).toBe(
      'observing',
    );
    expect(
      progress({
        now: analysis.earliestAt,
        estimate: estimate(0.49),
        samples: [
          {
            time: analysis.earliestAt - 1000,
            quoteTime: analysis.earliestAt - 1000,
            direction: 'above',
          },
        ],
      }).phase,
    ).toBe('ready');
  });

  test.each([
    { available: false },
    { aboveProbability: NaN },
    { belowProbability: Infinity },
    { aboveProbability: '0.51' },
    { aboveProbability: null },
    { aboveProbability: -0.1, belowProbability: 1.1 },
    { aboveProbability: 1.1, belowProbability: -0.1 },
    { belowProbability: 0.7 },
  ])('waits for usable data and declines at the cutoff for invalid estimates: %j', (changes) => {
    const invalid = estimate(0.51, changes);
    expect(getQualifyingDirection(invalid, PRESSURE_POLICY_VERSION)).toBeNull();
    expect(progress({ now: analysis.earliestAt, estimate: invalid }).phase).toBe('confirming');
    expect(progress({ now: analysis.deadline, estimate: invalid })).toMatchObject({
      phase: 'withheld',
      withholdingReason: 'market-data-unavailable',
    });
  });

  test('accepts recovery through the cutoff but cannot issue retrospectively afterward', () => {
    expect(
      progress({ now: analysis.deadline - 1, estimate: estimate(0.51, { available: false }) })
        .phase,
    ).toBe('confirming');
    expect(progress({ now: analysis.deadline }).phase).toBe('ready');
    expect(progress({ now: analysis.deadline + 1 }).phase).toBe('withheld');
  });

  test('a joined window needs three minutes observation plus a minute of remaining lead', () => {
    const joined = getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: START + 4 * MINUTE - 1,
      policyVersion: PRESSURE_POLICY_VERSION,
    });
    expect(progress({ analysis: joined })).toMatchObject({
      phase: 'withheld',
      withholdingReason: 'insufficient-time',
    });
    const exact = getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: START + 4 * MINUTE,
      policyVersion: PRESSURE_POLICY_VERSION,
    });
    expect(progress({ analysis: exact, now: exact.earliestAt }).phase).toBe('ready');
  });

  test.each([FIXED_PREDICTION_POLICY_VERSION, MARKET_AWARE_POLICY_VERSION])(
    'retains the original 65 percent and confirmation rule for saved %s forecasts',
    (policyVersion) => {
      expect(getQualifyingDirection(estimate(0.51), policyVersion)).toBeNull();
      expect(getQualifyingDirection(estimate(0.65), policyVersion)).toBe('above');
      expect(
        progress({
          analysis: { ...analysis, policyVersion },
          now: analysis.earliestAt,
          estimate: estimate(0.8),
        }).phase,
      ).toBe('confirming');
    },
  );
});

describe('pressure forecast persistence and outcome consistency', () => {
  test.each([0.49, 0.5, 0.51])(
    'round-trips a weak or tied %s snapshot under version 5',
    (probability) => {
      const snapshot = makePending(probability);
      const storage = makeStorage();
      expect(saveJournal([snapshot], storage)).toBeNull();
      expect(JSON.parse(storage.setItem.mock.calls[0][1]).version).toBe(5);
      expect(loadJournal(storage)).toEqual({
        forecasts: [snapshot],
        scheduledForecast: null,
        warning: null,
      });
    },
  );

  test.each([
    { modelVersion: 'zero-drift-log-return-v1' },
    { analysis: { ...analysis, policyVersion: MARKET_AWARE_POLICY_VERSION } },
    { outcomeDefinition: undefined },
    { calculationMode: undefined },
    { calculationMode: null },
    { calculationMode: 'unknown' },
    { direction: 'below' },
    { direction: 'neutral' },
    { aboveProbability: 0.51, belowProbability: 0.6 },
  ])('rejects a model, policy, direction or definition mismatch: %j', (changes) => {
    expect(getValidatedForecast(makePending(0.51, changes))).toBeNull();
  });

  test('requires an owned pressure policy, even for a forecast without analysis metadata', () => {
    const snapshot = makePending();
    delete snapshot.analysis;
    delete snapshot.outcomeDefinition;
    expect(getValidatedForecast(snapshot)).toBeNull();
  });

  test('preserves a baseline fallback snapshot without mislabeling its calculation', () => {
    const forecast = makePending(0.51, { calculationMode: 'baseline-fallback' });
    const storage = makeStorage();
    expect(saveJournal([forecast], storage)).toBeNull();
    expect(loadJournal(storage).forecasts).toEqual([forecast]);
  });

  test('analyzing and withheld pressure entries cannot claim a calculation before capture', () => {
    expect(
      getValidatedForecast(makeAnalyzing({ calculationMode: 'pressure-adjusted' })),
    ).toBeNull();
    expect(
      getValidatedForecast(
        makeAnalyzing({
          status: 'withheld',
          withholdingReason: 'market-data-unavailable',
          calculationMode: 'baseline-fallback',
        }),
      ),
    ).toBeNull();
  });

  test('keeps a tied fixed snapshot measurable without inventing directional correctness', () => {
    const initial = reducer(undefined, forecastRecorded(makePending(0.5)));
    const resolved = reducer(
      initial,
      forecastsObserved({
        now: END + 1000,
        deadlineOutcome: {
          status: 'observed',
          observedPrice: 50_100,
          observedAt: END - 1,
          observedTradeId: 123,
          confirmedThrough: END + 1000,
          completeSince: START,
        },
      }),
    );
    expect(resolved.forecasts[0]).toMatchObject({
      status: 'resolved',
      direction: 'neutral',
      correct: null,
      outcome: 'above',
    });
    expect(getValidatedForecast(resolved.forecasts[0])).toEqual(resolved.forecasts[0]);
  });

  test.each(['no-consensus', 'market-conditions'])(
    'cannot restore an obsolete %s veto for a pressure snapshot',
    (reason) => {
      const initial = reducer(undefined, forecastRecorded(makeAnalyzing()));
      expect(
        reducer(
          initial,
          fixedForecastWithheld({ id: 'pressure-call', now: analysis.deadline, reason }),
        ),
      ).toBe(initial);
    },
  );

  test.each([1, 2, 3, 4])(
    'does not relabel a new pressure snapshot into older version %i',
    (version) => {
      const envelope = { version, forecasts: [makePending()] };
      if (version > 1) envelope.scheduledForecast = null;
      expect(loadJournal(makeStorage(envelope)).warning).toContain('invalid');
    },
  );

  test('loads version 4 market-aware analysis unchanged and saves it without adopting pressure rules', () => {
    const legacy = makeAnalyzing({
      modelVersion: 'zero-drift-log-return-v1',
      analysis: { ...analysis, policyVersion: MARKET_AWARE_POLICY_VERSION },
    });
    delete legacy.calculationMode;
    const storage = makeStorage({ version: 4, forecasts: [legacy], scheduledForecast: null });
    expect(loadJournal(storage)).toEqual({
      forecasts: [legacy],
      scheduledForecast: null,
      warning: null,
    });
    expect(saveJournal([legacy], storage)).toBeNull();
    expect(loadJournal(storage).forecasts).toEqual([legacy]);
  });
});

describe('scheduled pressure policy retention', () => {
  test('saves and starts the selected pressure policy under version 5', () => {
    const schedule = makeSchedule();
    const storage = makeStorage();
    expect(saveJournal([], storage, schedule)).toBeNull();
    expect(loadJournal(storage).scheduledForecast).toEqual(schedule);
    const state = reducer(undefined, scheduleCreated(schedule));
    expect(
      reducer(state, scheduledForecastStarted({ now: START, forecast: makeAnalyzing() })),
    ).toMatchObject({ forecasts: [makeAnalyzing()], scheduledForecast: null });
  });

  test.each([undefined, 'unknown', MARKET_AWARE_POLICY_VERSION])(
    'rejects an unsupported explicit schedule policy %s',
    (policyVersion) => {
      expect(getValidatedScheduledForecast(makeSchedule({ policyVersion }))).toBeNull();
    },
  );

  test('a pressure schedule requires the verified deadline outcome definition', () => {
    const schedule = makeSchedule();
    delete schedule.outcomeDefinition;
    expect(getValidatedScheduledForecast(schedule)).toBeNull();
  });

  test('does not silently upgrade a saved version 4 schedule when it starts', () => {
    const schedule = makeSchedule();
    delete schedule.policyVersion;
    const storage = makeStorage({ version: 4, forecasts: [], scheduledForecast: schedule });
    expect(loadJournal(storage).scheduledForecast).toEqual(schedule);
    const state = reducer(undefined, scheduleCreated(schedule));
    expect(
      reducer(state, scheduledForecastStarted({ now: START, forecast: makeAnalyzing() })),
    ).toBe(state);
    const legacy = makeAnalyzing({
      modelVersion: 'zero-drift-log-return-v1',
      analysis: { ...analysis, policyVersion: MARKET_AWARE_POLICY_VERSION },
    });
    delete legacy.calculationMode;
    expect(
      reducer(state, scheduledForecastStarted({ now: START, forecast: legacy })).forecasts,
    ).toEqual([legacy]);
  });

  test('cannot downgrade a pressure schedule to an otherwise valid legacy forecast', () => {
    const state = reducer(undefined, scheduleCreated(makeSchedule()));
    const legacy = makeAnalyzing({
      modelVersion: 'zero-drift-log-return-v1',
      analysis: { ...analysis, policyVersion: MARKET_AWARE_POLICY_VERSION },
    });
    delete legacy.calculationMode;
    expect(getValidatedForecast(legacy)).toEqual(legacy);
    expect(reducer(state, scheduledForecastStarted({ now: START, forecast: legacy }))).toBe(state);
  });

  test('rejects the explicit new policy under a version 4 schedule envelope', () => {
    expect(
      loadJournal(makeStorage({ version: 4, forecasts: [], scheduledForecast: makeSchedule() }))
        .warning,
    ).toContain('invalid');
  });
});
