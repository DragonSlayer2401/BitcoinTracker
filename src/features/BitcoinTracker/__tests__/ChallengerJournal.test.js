import { getValidatedForecast, loadJournal, saveJournal } from '../utils/journal.utils';
import {
  isKalshiModelVersion,
  isLearnedModelVersion,
  isSnapshotModelVersion,
} from '../utils/journal/modelValidation.utils';
import { getKalshiForecast } from '../utils/kalshi/forecast.utils';
import { createKalshiForecastRecord } from '../utils/kalshi/forecastRecord.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import {
  CHALLENGER_KINDS,
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_POLICY_VERSION,
  DIRECTIONAL_REVERSAL_KIND,
  DIRECTIONAL_REVERSAL_POLICY_VERSION,
  LEGACY_CHALLENGER_MODEL_VERSION,
} from '../utils/learning/challengerModel.utils';
import { DERIVATIVES_LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';

const START = Date.UTC(2026, 8, 15, 12);
const CAPTURE = START + 180_000;
const END = START + 900_000;

function forecast(kind = 'reversal', adjustment = 0.03) {
  const contract = {
    ticker: 'KXBTC15M-26SEP151215-15',
    eventTicker: 'KXBTC15M-26SEP151215',
    seriesTicker: 'KXBTC15M',
    startsAt: START,
    expiresAt: END,
    target: 50_000,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: CAPTURE - (1200 - index) * 1000,
    price: 50_000,
  }));
  const baseline = getKalshiForecast(
    {
      now: CAPTURE,
      kalshiMarket: contract,
      benchmark: { samples, current: samples.at(-1), receivedAt: CAPTURE },
      derivatives: null,
    },
    { available: false, pressure: { applied: false } },
  );
  const aboveProbability = baseline.aboveProbability + adjustment;
  return {
    ...createKalshiForecastRecord({
      id: `challenger-${kind}`,
      contract,
      createdAt: START,
      price: 50_000,
    }),
    createdAt: CAPTURE,
    aboveProbability,
    belowProbability: 1 - aboveProbability,
    direction: aboveProbability > 0.5 ? 'above' : 'below',
    status: 'pending',
    modelVersion: CHALLENGER_MODEL_VERSION,
    calculationMode: 'outcome-trained',
    kalshi: baseline.kalshi,
    derivatives: baseline.derivatives,
    learning: {
      applied: true,
      modelId: `${CHALLENGER_MODEL_VERSION}-${kind}-journal`,
      calibrationVersion:
        kind === DIRECTIONAL_REVERSAL_KIND
          ? DIRECTIONAL_REVERSAL_POLICY_VERSION
          : CHALLENGER_POLICY_VERSION,
      trainingCutoffAt: START - 60_000,
      baselineAboveProbability: baseline.aboveProbability,
      aboveProbability,
      featureVersion: DERIVATIVES_LEARNING_FEATURE_VERSION,
    },
  };
}

beforeEach(() => window.localStorage.clear());

test('challenger model versions enter the existing learned Kalshi snapshot validation path', () => {
  expect(isLearnedModelVersion(CHALLENGER_MODEL_VERSION)).toBe(true);
  expect(isKalshiModelVersion(CHALLENGER_MODEL_VERSION)).toBe(true);
  expect(isSnapshotModelVersion(CHALLENGER_MODEL_VERSION)).toBe(true);
});

test.each(CHALLENGER_KINDS)(
  '%s predictions preserve their exact immutable probabilities through reload',
  (kind) => {
    const fixed = forecast(kind);
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    expect(saveJournal([fixed])).toBeNull();
    expect(loadJournal()).toMatchObject({ forecasts: [fixed], warning: null });
  },
);

test.each(['reversal', 'forward-pressure'])(
  '%s adjustments enforce their fitted-model five-point bound',
  (kind) => {
    expect(getValidatedForecast(forecast(kind, 0.05))).not.toBeNull();
    expect(getValidatedForecast(forecast(kind, -0.05))).not.toBeNull();
    expect(getValidatedForecast(forecast(kind, 0.050001))).toBeNull();
    expect(getValidatedForecast(forecast(kind, -0.050001))).toBeNull();
  },
);

test.each(['reduced-pressure', 'fast-decay', 'market-blend'])(
  '%s policy adjustments are not incorrectly limited to five points',
  (kind) => {
    expect(getValidatedForecast(forecast(kind, 0.2))).not.toBeNull();
    expect(getValidatedForecast(forecast(kind, -0.2))).not.toBeNull();
  },
);

test.each([0.2, -0.2])(
  'a direct directional adjustment of %s survives journal reload without a five-point cap',
  (adjustment) => {
    const fixed = forecast(DIRECTIONAL_REVERSAL_KIND, adjustment);
    expect(
      Math.abs(fixed.learning.aboveProbability - fixed.learning.baselineAboveProbability),
    ).toBeGreaterThan(0.05);
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    expect(saveJournal([fixed])).toBeNull();
    expect(loadJournal()).toEqual({ forecasts: [fixed], scheduledForecast: null, warning: null });
  },
);

test('directional and bounded challenger policies cannot be substituted during restoration', () => {
  const direct = forecast(DIRECTIONAL_REVERSAL_KIND, 0.2);
  direct.learning.calibrationVersion = CHALLENGER_POLICY_VERSION;
  expect(getValidatedForecast(direct)).toBeNull();

  const bounded = forecast('reversal', 0.03);
  bounded.learning.calibrationVersion = DIRECTIONAL_REVERSAL_POLICY_VERSION;
  expect(getValidatedForecast(bounded)).toBeNull();

  const legacy = forecast(DIRECTIONAL_REVERSAL_KIND, 0.2);
  legacy.modelVersion = LEGACY_CHALLENGER_MODEL_VERSION;
  legacy.learning.modelId = `${LEGACY_CHALLENGER_MODEL_VERSION}-${DIRECTIONAL_REVERSAL_KIND}-journal`;
  expect(getValidatedForecast(legacy)).toBeNull();
});

test.each([
  [
    'future training cutoff',
    (fixed) => {
      fixed.learning.trainingCutoffAt = CAPTURE + 1;
    },
  ],
  [
    'training at capture',
    (fixed) => {
      fixed.learning.trainingCutoffAt = CAPTURE;
    },
  ],
  [
    'missing learning metadata',
    (fixed) => {
      delete fixed.learning;
    },
  ],
  [
    'missing model id',
    (fixed) => {
      delete fixed.learning.modelId;
    },
  ],
  [
    'unexpected metadata field',
    (fixed) => {
      fixed.learning.kind = 'reversal';
    },
  ],
  [
    'unknown challenger kind',
    (fixed) => {
      fixed.learning.modelId = `${CHALLENGER_MODEL_VERSION}-unknown-journal`;
    },
  ],
  [
    'missing challenger identity suffix',
    (fixed) => {
      fixed.learning.modelId = `${CHALLENGER_MODEL_VERSION}-reversal-`;
    },
  ],
  [
    'wrong calibration',
    (fixed) => {
      fixed.learning.calibrationVersion = 'platt-v1';
    },
  ],
  [
    'wrong feature version',
    (fixed) => {
      fixed.learning.featureVersion = 'deadline-reversal-features-v99';
    },
  ],
  [
    'wrong probability',
    (fixed) => {
      fixed.learning.aboveProbability += 0.001;
    },
  ],
  [
    'missing derivative metadata',
    (fixed) => {
      delete fixed.derivatives;
    },
  ],
  [
    'wrong derivative baseline',
    (fixed) => {
      fixed.derivatives.aboveProbability += 0.001;
    },
  ],
  [
    'wrong settlement market',
    (fixed) => {
      fixed.kalshi.marketTicker += '-OTHER';
    },
  ],
])('rejects %s while restoring a challenger prediction', (_, alter) => {
  for (const kind of ['reversal', DIRECTIONAL_REVERSAL_KIND]) {
    const fixed = forecast(kind);
    alter(fixed);
    expect(getValidatedForecast(fixed)).toBeNull();
  }
});
