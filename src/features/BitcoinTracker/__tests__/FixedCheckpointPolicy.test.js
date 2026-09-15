/** @jest-environment node */
import {
  getFixedForecastAnalysis,
  getFixedPredictionProgress,
  getQualifyingDirection,
  hasInsufficientFixedPredictionTime,
  isKalshiCheckpointMinutes,
  isKalshiCheckpointSelection,
  KALSHI_CHECKPOINT_GRACE_MS,
  KALSHI_CHECKPOINT_MINUTES,
  KALSHI_CHECKPOINT_POLICY_VERSION,
  KALSHI_POLICY_VERSION,
  usesSnapshotPolicy,
} from '../utils/fixedPrediction.utils';
import { createKalshiForecastRecord } from '../utils/kalshi/forecastRecord.utils';
import { getKalshiForecast } from '../utils/kalshi/forecast.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import {
  getValidatedForecast,
  getValidatedJournal,
  getValidatedScheduledForecast,
  loadJournal,
  saveJournal,
} from '../utils/journal.utils';
import { validateForecastSnapshotConsistency } from '../../../services/research/research.validation';

const START = Date.UTC(2026, 8, 10, 12);
const END = START + 900_000;
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
const estimate = (aboveProbability = 0.51) => ({
  available: true,
  aboveProbability,
  belowProbability: 1 - aboveProbability,
});
const makeForecast = (checkpointMinutes = 12, createdAt = START) =>
  createKalshiForecastRecord({
    id: 'checkpoint-forecast',
    contract,
    createdAt,
    price: 50_000,
    checkpointMinutes,
  });
const getProgress = (forecast, now, prediction = estimate()) =>
  getFixedPredictionProgress({
    analysis: forecast.analysis,
    samples: [],
    estimate: prediction,
    now,
  });
const makeSchedule = (checkpointMinutes = 12) => ({
  id: 'checkpoint-schedule',
  createdAt: START - 30_000,
  startsAt: START,
  expiresAt: END,
  target: null,
  status: 'scheduled',
  marketTicker: contract.ticker,
  eventTicker: contract.eventTicker,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION,
  checkpointMinutes,
});

function publish(forecast, now = forecast.analysis.earliestAt) {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: Math.floor(now / 1000) * 1000 - (1200 - index) * 1000,
    price: 50_000 * Math.exp(Math.sin(index / 30) * 0.0001),
  }));
  const prediction = getKalshiForecast({
    kalshiMarket: forecast.kalshiMarket,
    now,
    candles: [],
    ticker: { price: 50_000, bid: 49_999, ask: 50_001, time: now, receivedAt: now },
    benchmark: { available: true, samples, current: samples.at(-1), receivedAt: now },
  });
  expect(prediction.available).toBe(true);
  return {
    ...forecast,
    createdAt: now,
    status: 'pending',
    aboveProbability: prediction.aboveProbability,
    belowProbability: prediction.belowProbability,
    direction: prediction.direction,
    calculationMode: 'baseline-fallback',
    kalshi: prediction.kalshi,
  };
}

test.each(KALSHI_CHECKPOINT_MINUTES)(
  '%i minutes means remaining time, with an immutable five-second capture window',
  (checkpointMinutes) => {
    const forecast = makeForecast(checkpointMinutes, START + 1000);
    const captureAt = END - checkpointMinutes * 60_000;
    expect(forecast.analysis).toEqual({
      startedAt: START + 1000,
      earliestAt: captureAt,
      deadline: captureAt + KALSHI_CHECKPOINT_GRACE_MS,
      policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION,
    });
    expect(forecast.analysis.deadline).toBeLessThan(END);
    expect(getProgress(forecast, captureAt - 1).phase).toBe('observing');
    expect(getProgress(forecast, captureAt).phase).toBe('ready');
    expect(getProgress(forecast, captureAt + 5000).phase).toBe('ready');
    expect(getProgress(forecast, captureAt + 5001).phase).toBe('withheld');
    expect(getValidatedForecast(forecast)).toEqual(forecast);
    const pending = publish(forecast, captureAt + 5000);
    expect(getValidatedForecast(pending)).toEqual(pending);
  },
);

test.each([0.49, 0.5, 0.51])(
  'captures weak or balanced estimates (%f) without a consensus gate',
  (above) => {
    const forecast = makeForecast();
    const direction = above > 0.5 ? 'above' : above < 0.5 ? 'below' : 'neutral';
    expect(usesSnapshotPolicy(forecast.analysis.policyVersion)).toBe(true);
    expect(getQualifyingDirection(estimate(above), forecast.analysis.policyVersion)).toBe(
      direction,
    );
    expect(getProgress(forecast, forecast.analysis.earliestAt, estimate(above))).toMatchObject({
      phase: 'ready',
      sampleCount: 0,
      confirmationRemainingMs: 0,
    });
  },
);

test('a late join inside grace captures immediately without starting another observation period', () => {
  const captureAt = END - 12 * 60_000;
  const forecast = makeForecast(12, captureAt + 4000);
  expect(getProgress(forecast, captureAt + 4000).phase).toBe('ready');
  expect(getProgress(forecast, captureAt).phase).not.toBe('ready');
  expect(getValidatedForecast(publish(forecast, captureAt + 4000))).not.toBeNull();
  expect(getValidatedForecast(publish(forecast, captureAt))).toBeNull();
});

test('joining after grace is insufficient and never backfills an earlier checkpoint', () => {
  const forecast = makeForecast(12, END - 12 * 60_000 + 5001);
  expect(hasInsufficientFixedPredictionTime(forecast.analysis)).toBe(true);
  expect(getProgress(forecast, forecast.createdAt)).toMatchObject({
    phase: 'withheld',
    withholdingReason: 'insufficient-time',
  });
  const withheld = { ...forecast, status: 'withheld', withholdingReason: 'insufficient-time' };
  expect(getValidatedForecast(withheld)).toEqual(withheld);
  expect(getValidatedForecast(publish(forecast, forecast.analysis.deadline))).toBeNull();
});

test('invalid market estimates wait only through the selected grace period', () => {
  const forecast = makeForecast();
  expect(getProgress(forecast, forecast.analysis.earliestAt, { available: false }).phase).toBe(
    'confirming',
  );
  expect(getProgress(forecast, forecast.analysis.deadline, { available: false })).toMatchObject({
    phase: 'withheld',
    withholdingReason: 'market-data-unavailable',
  });
  expect(getProgress(forecast, forecast.analysis.deadline + 1).phase).toBe('withheld');
  expect(
    getQualifyingDirection(
      { ...estimate(), belowProbability: 0.7 },
      KALSHI_CHECKPOINT_POLICY_VERSION,
    ),
  ).toBeNull();
});

test.each([null, '12', 0, 2, 15, -1, NaN, Infinity])(
  'rejects unsupported checkpoint %s',
  (value) => {
    expect(isKalshiCheckpointMinutes(value)).toBe(false);
    expect(() => makeForecast(value)).toThrow(RangeError);
    expect(getValidatedScheduledForecast(makeSchedule(value))).toBeNull();
  },
);

test('legacy v4 creation and late-join observation timing stay unchanged when checkpoint is omitted', () => {
  const createdAt = END - 60_000;
  const legacy = createKalshiForecastRecord({ id: 'legacy', contract, createdAt, price: 50_000 });
  expect(legacy).not.toHaveProperty('checkpointMinutes');
  expect(legacy.analysis).toEqual({
    startedAt: createdAt,
    earliestAt: createdAt + 15_000,
    deadline: END - 5000,
    policyVersion: KALSHI_POLICY_VERSION,
  });
  expect(getValidatedForecast(legacy)).toEqual(legacy);
  expect(
    getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: END,
      policyVersion: KALSHI_POLICY_VERSION,
    }),
  ).toEqual({
    startedAt: START,
    earliestAt: START + 180_000,
    deadline: START + 300_000,
    policyVersion: KALSHI_POLICY_VERSION,
  });
});

test.each(KALSHI_CHECKPOINT_MINUTES)(
  'restores a future contract with %i-minute checkpoint and no invented target',
  (checkpointMinutes) => {
    const schedule = makeSchedule(checkpointMinutes);
    expect(getValidatedScheduledForecast(schedule)).toEqual(schedule);
    const data = new Map();
    const storage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    };
    expect(saveJournal([], storage, schedule)).toBeNull();
    expect(loadJournal(storage)).toEqual({
      forecasts: [],
      scheduledForecast: schedule,
      warning: null,
    });
    const pending = publish(makeForecast(checkpointMinutes));
    expect(saveJournal([pending], storage)).toBeNull();
    expect(loadJournal(storage)).toEqual({
      forecasts: [pending],
      scheduledForecast: null,
      warning: null,
    });
  },
);

test('restore rejects altered, missing, or legacy-tagged checkpoint timing', () => {
  const original = makeForecast();
  const { checkpointMinutes, ...missing } = original;
  expect(getValidatedForecast(missing)).toBeNull();
  expect(getValidatedForecast({ ...original, checkpointMinutes: 9 })).toBeNull();
  expect(
    getValidatedForecast({
      ...original,
      analysis: { ...original.analysis, deadline: original.analysis.deadline + 1 },
    }),
  ).toBeNull();
  expect(
    getValidatedForecast({
      ...original,
      analysis: { ...original.analysis, policyVersion: KALSHI_POLICY_VERSION },
    }),
  ).toBeNull();
  const schedule = makeSchedule();
  const { checkpointMinutes: selected, ...missingSchedule } = schedule;
  expect(getValidatedScheduledForecast(missingSchedule)).toBeNull();
  expect(
    getValidatedScheduledForecast({ ...schedule, policyVersion: KALSHI_POLICY_VERSION }),
  ).toBeNull();
});

test('database snapshots cannot change or delete a checkpoint even if other fields are unchanged', () => {
  const original = makeForecast();
  expect(() =>
    validateForecastSnapshotConsistency(original, { ...original, checkpointMinutes: 9 }),
  ).toThrow('original target');
  const { checkpointMinutes, ...missing } = original;
  expect(() => validateForecastSnapshotConsistency(original, missing)).toThrow('original target');
  expect(() => validateForecastSnapshotConsistency(original, { ...original })).not.toThrow();
});

test('multiple unique checkpoints restore together only for one identical verified Kalshi contract', () => {
  const forecasts = KALSHI_CHECKPOINT_MINUTES.map((minutes) => ({
    ...makeForecast(minutes),
    id: `checkpoint-${minutes}`,
  }));
  forecasts[0] = publish(forecasts[0]);
  expect(getValidatedJournal(forecasts)).toHaveLength(5);
  const previous = publish(
    createKalshiForecastRecord({
      id: 'previous-contract',
      contract: {
        ...contract,
        ticker: 'KXBTC15M-26SEP101200-00',
        eventTicker: 'KXBTC15M-26SEP101200',
        startsAt: START - 900_000,
        expiresAt: START,
      },
      createdAt: START - 900_000,
      price: 50_000,
      checkpointMinutes: 12,
    }),
  );
  previous.status = 'awaiting-settlement';
  const validated = getValidatedJournal([...forecasts, previous]);
  expect(validated).toHaveLength(6);
  expect(validated).toContainEqual(previous);
  expect(
    getValidatedJournal([forecasts[0], { ...forecasts[0], id: 'duplicate-checkpoint' }]),
  ).toBeNull();
  expect(getValidatedJournal([forecasts[1], { ...previous, status: 'pending' }])).toBeNull();
  expect(
    getValidatedJournal([
      forecasts[1],
      {
        ...makeForecast(6),
        id: 'different-target',
        target: 50_001,
        kalshiMarket: { ...contract, target: 50_001 },
      },
    ]),
  ).toBeNull();
  const legacy = createKalshiForecastRecord({
    id: 'legacy',
    contract,
    createdAt: START,
    price: 50_000,
  });
  expect(getValidatedJournal([forecasts[0], legacy])).toBeNull();
  expect(getValidatedJournal([legacy, { ...legacy, id: 'second-legacy' }])).toBeNull();
});

test('schedules retain all selected checkpoints and reject empty, repeated, or unsupported selections', () => {
  const selected = [12, 6, 1];
  expect(isKalshiCheckpointSelection(selected)).toBe(true);
  const schedule = { ...makeSchedule(), checkpointMinutes: selected, captureOrigin: 'automatic' };
  const validated = getValidatedScheduledForecast(schedule);
  expect(validated).toEqual(schedule);
  expect(validated.checkpointMinutes).not.toBe(selected);
  for (const checkpoints of [[], [12, 12], [12, 2], ['12'], [1, 3, 6, 9, 12, 12]]) {
    expect(isKalshiCheckpointSelection(checkpoints)).toBe(false);
    expect(
      getValidatedScheduledForecast({ ...schedule, checkpointMinutes: checkpoints }),
    ).toBeNull();
  }
});

test.each(['automatic', 'manual'])(
  'preserves %s capture origin across creation, restore, and storage',
  (captureOrigin) => {
    const original = createKalshiForecastRecord({
      id: 'origin-forecast',
      contract,
      createdAt: START,
      price: 50_000,
      checkpointMinutes: 12,
      captureOrigin,
    });
    expect(original.captureOrigin).toBe(captureOrigin);
    expect(getValidatedForecast(original)).toEqual(original);
    const schedule = { ...makeSchedule(), captureOrigin };
    expect(getValidatedScheduledForecast(schedule)).toEqual(schedule);
    const changed = {
      ...original,
      captureOrigin: captureOrigin === 'manual' ? 'automatic' : 'manual',
    };
    expect(() => validateForecastSnapshotConsistency(original, changed)).toThrow('original target');
    const { captureOrigin: omitted, ...missing } = original;
    expect(() => validateForecastSnapshotConsistency(original, missing)).toThrow('original target');
  },
);

test.each(['research', '', null, false])(
  'rejects unsupported capture origin %s',
  (captureOrigin) => {
    expect(getValidatedForecast({ ...makeForecast(), captureOrigin })).toBeNull();
    expect(getValidatedScheduledForecast({ ...makeSchedule(), captureOrigin })).toBeNull();
  },
);
