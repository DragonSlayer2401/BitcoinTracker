import { createElement } from 'react';
import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import useFixedPrediction from '../hooks/useFixedPrediction';
import useForecastEvidence from '../hooks/useForecastEvidence';
import trackerReducer, {
  forecastRecorded,
  forecastsObserved,
  historyRestored,
} from '../state/slices/trackerSlice';
import { selectActiveForecast, selectForecasts } from '../state/selectors/trackerSelectors';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getValidatedForecast, loadJournal, saveJournal } from '../utils/journal.utils';
import { appendEvidenceRows } from '../utils/evidenceStorage.utils';
import { OUTCOME_MODEL_VERSION, CALIBRATION_VERSION } from '../utils/learning/model.utils';
import {
  EARLY_MODEL_VERSION,
  EARLY_CALIBRATION_VERSION,
  EARLY_LEARNING_REQUIREMENTS,
  EARLY_FIT_PARAMETERS,
} from '../utils/learning/earlyModel.utils';
import { LEARNING_FEATURE_NAMES, LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';
import { KALSHI_OUTCOME_DEFINITION, getKalshiOutcome } from '../utils/kalshi/contract.utils';

jest.mock('../utils/evidenceStorage.utils', () => ({
  ...jest.requireActual('../utils/evidenceStorage.utils'),
  appendEvidenceRows: jest.fn(),
}));

const START = Date.UTC(2026, 8, 9, 12);
const CAPTURE = START + 180_000;
const END = START + 900_000;
const TARGET = 49990;
const CONTRACT = {
  ticker: 'KXBTC15M-26SEP091215-15',
  eventTicker: 'KXBTC15M-26SEP091215',
  seriesTicker: 'KXBTC15M',
  target: TARGET,
  startsAt: START,
  expiresAt: END,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
};

function market(now) {
  const minute = Math.floor(now / 60_000) * 60_000;
  let price = 50000;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price;
    price *= Math.exp(index % 2 ? -0.0002 : 0.0002);
    return {
      time: minute - (120 - index) * 60_000,
      open,
      close: price,
      high: Math.max(open, price) * 1.000001,
      low: Math.min(open, price) * 0.999999,
      volume: 10,
    };
  });
  return {
    now,
    kalshiMarket: CONTRACT,
    candles,
    ticker: { price, bid: price - 1, ask: price + 1, volume: 100, time: now, receivedAt: now },
    stream: {
      status: 'disconnected',
      flow: { available: false },
      liquidity: { available: false },
      quality: {},
      getDeadlineOutcome: () => ({ status: 'waiting' }),
    },
  };
}

function artifact(probability = 0.2, overrides = {}) {
  const length = LEARNING_FEATURE_NAMES.length;
  const trainedAt = START - 60_000;
  const id = `${OUTCOME_MODEL_VERSION}-integration`;
  return {
    id,
    version: OUTCOME_MODEL_VERSION,
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
      coefficients: [Math.log(probability / (1 - probability)), ...Array(length).fill(0)],
    },
    calibration: {
      version: CALIBRATION_VERSION,
      model: { indexes: [0], means: [0], scales: [1], coefficients: [0, 1] },
    },
    evaluation: { eligibleForShadow: true },
    activation: {
      modelId: id,
      activatedAt: START - 1000,
      shadowEvaluation: { eligibleForPromotion: true, modelId: id, evaluatedAt: START - 1000 },
    },
    ...overrides,
    applicability: {
      baselineModelVersion: KALSHI_MODEL_VERSION,
      featureInputSources: ['coinbase-candles'],
      referenceSources: ['coinbase-proxy'],
      minimumHorizonMinutes: 1,
      maximumHorizonMinutes: 15,
      availabilityPatterns: ['0000011'],
      minimumTargetDistance: -8,
      maximumTargetDistance: 8,
      ...overrides.applicability,
    },
  };
}

function analyzing() {
  return {
    id: 'fixed-one',
    kalshiMarket: CONTRACT,
    kalshi: null,
    startsAt: START,
    timingMode: 'end',
    createdAt: START,
    expiresAt: END,
    price: 50000,
    target: TARGET,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion: KALSHI_MODEL_VERSION,
    status: 'analyzing',
    calculationMode: null,
    analysis: getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: END,
      policyVersion: KALSHI_POLICY_VERSION,
    }),
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
}

function earlyArtifact(overrides = {}) {
  const base = artifact();
  const id = `${EARLY_MODEL_VERSION}-integration`;
  return {
    ...base,
    id,
    version: EARLY_MODEL_VERSION,
    calibrationCutoffAt: base.trainingCutoffAt,
    evaluationCutoffAt: base.trainingCutoffAt,
    requirements: { ...EARLY_LEARNING_REQUIREMENTS },
    model: {
      indexes: [0],
      means: [0],
      scales: [1],
      coefficients: [-4, 1],
      penalty: EARLY_FIT_PARAMETERS.penalty,
    },
    calibration: { version: EARLY_CALIBRATION_VERSION },
    applicability: {
      ...base.applicability,
      minimumBaselineProbability: 0,
      maximumBaselineProbability: 1,
    },
    activation: {
      ...base.activation,
      modelId: id,
      shadowEvaluation: { ...base.activation.shadowEvaluation, modelId: id },
    },
    ...overrides,
  };
}

function createObservation({
  now = START,
  models = { active: artifact() },
  hasRequestError = false,
  recordEvidence = true,
} = {}) {
  jest.setSystemTime(now);
  const store = configureStore({ reducer: { tracker: trackerReducer } });
  store.dispatch(forecastRecorded(analyzing()));
  const initialProps = { ...market(now), models, hasRequestError };
  const wrapper = ({ children }) => createElement(Provider, { store }, children);
  const hook = renderHook(
    (props) => {
      const active = useSelector(selectActiveForecast);
      const forecasts = useSelector(selectForecasts);
      const progress = useFixedPrediction({ ...props, forecast: active });
      useForecastEvidence({ ...props, forecasts, progress, isReady: recordEvidence });
      return { active, progress };
    },
    { initialProps, wrapper },
  );
  return {
    ...hook,
    store,
    update(timestamp, patch = {}) {
      jest.setSystemTime(timestamp);
      hook.rerender({ ...initialProps, ...market(timestamp), ...patch });
    },
  };
}

const stored = (view) => view.store.getState().tracker.forecasts[0];
const evidenceRows = () => appendEvidenceRows.mock.calls.flatMap(([rows]) => rows);
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('learned forecast integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
    window.localStorage.clear();
    appendEvidenceRows.mockResolvedValue();
  });
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test('records early and full candidates independently without changing the live baseline', () => {
    const input = market(CAPTURE);
    const full = artifact();
    const early = earlyArtifact({ activation: undefined });
    const baseline = getResearchForecast(input);
    const preview = getResearchForecast(input, { candidate: full, earlyCandidate: early }, START);
    expect(preview.aboveProbability).toBe(baseline.aboveProbability);
    expect(preview.shadowPrediction?.modelId).toBe(full.id);
    expect(preview.earlyShadowPrediction).toMatchObject({
      modelId: early.id,
      featureCutoffAt: CAPTURE,
    });
    expect(preview.earlyShadowPrediction.aboveProbability).toBeLessThan(baseline.aboveProbability);
    expect(
      getResearchForecast(input, { early: { candidate: early } }, START).earlyShadowPrediction,
    ).toEqual(preview.earlyShadowPrediction);
    expect(getResearchForecast(input, { earlyCandidate: early }).earlyShadowPrediction).toBeNull();
    expect(
      getResearchForecast(
        input,
        {
          earlyCandidate: earlyArtifact({ trainedAt: START + 1000, shadowStartsAt: START + 1000 }),
        },
        START,
      ).earlyShadowPrediction,
    ).toBeNull();
  });

  test('captures and restores an activated early correction without changing saved probabilities', async () => {
    const model = earlyArtifact();
    const baseline = getResearchForecast(market(CAPTURE));
    const view = createObservation({ now: CAPTURE, models: { active: model } });
    await flush();
    const fixed = JSON.parse(JSON.stringify(stored(view)));
    expect(fixed).toMatchObject({
      status: 'pending',
      modelVersion: EARLY_MODEL_VERSION,
      calculationMode: 'outcome-trained',
      learning: { modelId: model.id, calibrationVersion: EARLY_CALIBRATION_VERSION },
    });
    expect(Math.abs(fixed.aboveProbability - baseline.aboveProbability)).toBeLessThanOrEqual(
      0.05 + 1e-9,
    );
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    expect(saveJournal([fixed], window.localStorage)).toBeNull();
    expect(loadJournal(window.localStorage).forecasts).toEqual([fixed]);
    expect(evidenceRows().find((row) => row.event === 'decision')?.learning.modelId).toBe(model.id);
    view.update(CAPTURE + 1000, { models: {} });
    await flush();
    expect(stored(view)).toEqual(fixed);
    const excessive = {
      ...fixed,
      aboveProbability: Math.min(0.99, baseline.aboveProbability + 0.1),
    };
    excessive.learning = { ...fixed.learning, aboveProbability: excessive.aboveProbability };
    excessive.belowProbability = 1 - excessive.aboveProbability;
    expect(getValidatedForecast(excessive)).toBeNull();
  });

  test('archives early shadow inputs at capture and falls back when an early model is retired', async () => {
    const early = earlyArtifact({ activation: undefined });
    const view = createObservation({ now: CAPTURE, models: { earlyCandidate: early } });
    await flush();
    const decision = evidenceRows().find((row) => row.event === 'decision');
    expect(decision.earlyShadowPrediction).toMatchObject({
      modelId: early.id,
      featureCutoffAt: CAPTURE,
    });
    const input = market(CAPTURE);
    expect(
      getResearchForecast(input, {
        active: earlyArtifact({
          retirement: { retiredAt: CAPTURE - 1, reason: 'Performance worsened.' },
        }),
      }).aboveProbability,
    ).toBe(getResearchForecast(input).aboveProbability);
  });

  test('applies an activated reversal model to the same deadline while retaining the baseline comparison', () => {
    const input = { ...market(CAPTURE), target: TARGET, horizonMinutes: 12, expiresAt: END };
    const baseline = getResearchForecast(input);
    const learned = getResearchForecast(input, { active: artifact() }, START);
    expect(baseline.direction).toBe('above');
    expect(learned).toMatchObject({
      modelVersion: OUTCOME_MODEL_VERSION,
      direction: 'below',
      target: TARGET,
      expiresAt: END,
      intervalAvailable: false,
      lowerBound: null,
      upperBound: null,
      learning: {
        applied: true,
        baselineAboveProbability: baseline.aboveProbability,
        featureVersion: LEARNING_FEATURE_VERSION,
      },
    });
    expect(learned.aboveProbability).toBeCloseTo(0.2);
    expect(learned.learningFeatures).toMatchObject({
      target: TARGET,
      expiresAt: END,
      featureCutoffAt: CAPTURE,
    });
  });

  test('publishes the learned fixed call after three minutes and archives its exact contemporaneous inputs', async () => {
    const view = createObservation();
    await flush();
    view.update(CAPTURE - 1);
    await flush();
    expect(stored(view).status).toBe('analyzing');
    view.update(CAPTURE);
    await flush();
    const fixed = stored(view);
    expect(fixed).toMatchObject({
      status: 'pending',
      direction: 'below',
      modelVersion: OUTCOME_MODEL_VERSION,
      calculationMode: 'outcome-trained',
      target: TARGET,
      expiresAt: END,
      createdAt: CAPTURE,
      learning: { applied: true, modelId: artifact().id, calibrationVersion: CALIBRATION_VERSION },
    });
    expect(fixed.aboveProbability).toBeCloseTo(0.2);
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    const decision = evidenceRows().find((row) => row.event === 'decision');
    expect(decision).toMatchObject({
      forecastId: fixed.id,
      target: TARGET,
      expiresAt: END,
      inputObservedAt: CAPTURE,
      aboveProbability: fixed.aboveProbability,
      calibrationVersion: CALIBRATION_VERSION,
      learning: fixed.learning,
      learningFeatures: { target: TARGET, expiresAt: END, featureCutoffAt: CAPTURE },
    });
    expect(decision.learningFeatures.baselineAboveProbability).toBe(
      fixed.learning.baselineAboveProbability,
    );
    expect(decision.intervalLow).toBeNull();
    expect(decision.intervalHigh).toBeNull();
  });

  test('reloads a learned fixed call unchanged and resolves it against the official Kalshi result', async () => {
    const view = createObservation({ now: CAPTURE, recordEvidence: false });
    await flush();
    const fixed = stored(view);
    expect(saveJournal([fixed], window.localStorage)).toBeNull();
    const journal = JSON.parse(window.localStorage.getItem('bitcoin-tracker:journal:v1'));
    expect(journal.version).toBe(7);
    view.unmount();
    const loaded = loadJournal(window.localStorage);
    expect(loaded.warning).toBeNull();
    expect(loaded.forecasts).toEqual([fixed]);
    const restored = configureStore({ reducer: { tracker: trackerReducer } });
    restored.dispatch(historyRestored({ forecasts: loaded.forecasts, scheduledForecast: null }));
    restored.dispatch(
      forecastsObserved({
        now: END + 1000,
        ticker: { price: 49000, time: END + 1000, receivedAt: END + 1000 },
        kalshiOutcomes: [
          getKalshiOutcome(
            {
              ...CONTRACT,
              status: 'finalized',
              result: 'yes',
              settlementPrice: 50100,
              receivedAt: END + 1000,
              settledAt: END + 1000,
            },
            END + 1000,
          ),
        ],
      }),
    );
    const resolved = restored.getState().tracker.forecasts[0];
    expect(resolved).toMatchObject({
      ...fixed,
      status: 'resolved',
      outcome: 'above',
      correct: false,
      observedPrice: 50100,
    });
    expect(resolved.learning).toEqual(fixed.learning);
    expect(saveJournal([resolved], window.localStorage)).toBeNull();
    expect(loadJournal(window.localStorage).forecasts).toEqual([resolved]);
  });

  test('a later active model or changed live price cannot rewrite an already-captured forecast', async () => {
    const view = createObservation({ now: CAPTURE });
    await flush();
    const fixed = JSON.parse(JSON.stringify(stored(view)));
    const changed = market(CAPTURE + 10_000);
    changed.ticker.price = 48000;
    view.update(CAPTURE + 10_000, { ...changed, models: { active: artifact(0.9) } });
    await flush();
    expect(stored(view)).toEqual(fixed);
  });

  test.each([
    ['no learned model', {}],
    ['shadow-only candidate', { candidate: artifact(0.2, { activation: undefined }) }],
    [
      'unsupported target distance',
      {
        active: artifact(0.2, {
          applicability: { minimumTargetDistance: 0, maximumTargetDistance: 0 },
        }),
      },
    ],
    [
      'unsupported horizon',
      {
        active: artifact(0.2, {
          applicability: {
            minimumHorizonMinutes: 13,
            maximumHorizonMinutes: 15,
            availabilityPatterns: ['0000011'],
          },
        }),
      },
    ],
    [
      'unsupported missing-feed combination',
      {
        active: artifact(0.2, {
          applicability: {
            minimumHorizonMinutes: 1,
            maximumHorizonMinutes: 15,
            availabilityPatterns: ['11111'],
          },
        }),
      },
    ],
    [
      'future activation',
      {
        active: artifact(0.2, {
          activation: {
            modelId: artifact().id,
            activatedAt: CAPTURE + 1,
            shadowEvaluation: { eligibleForPromotion: true },
          },
        }),
      },
    ],
  ])('publishes a valid baseline fallback when there is %s', async (_, models) => {
    const view = createObservation({ now: CAPTURE, models, recordEvidence: false });
    await flush();
    const fixed = stored(view);
    expect(fixed).toMatchObject({
      status: 'pending',
      direction: 'above',
      modelVersion: KALSHI_MODEL_VERSION,
      calculationMode: 'baseline-fallback',
    });
    expect(fixed.learning).toBeUndefined();
    expect(getValidatedForecast(fixed)).toEqual(fixed);
  });

  test('essential quote failures still prevent capture until valid data returns', async () => {
    const view = createObservation({ now: CAPTURE, hasRequestError: true });
    await flush();
    expect(stored(view).status).toBe('analyzing');
    view.update(CAPTURE + 1000, { hasRequestError: false });
    await flush();
    expect(stored(view)).toMatchObject({ status: 'pending', modelVersion: OUTCOME_MODEL_VERSION });
  });

  test('records shadow probabilities only for candidates trained before the forecast window began', () => {
    const input = { ...market(CAPTURE), target: TARGET, expiresAt: END, horizonMinutes: 12 };
    const beforeWindow = getResearchForecast(input, { candidate: artifact() }, START);
    expect(beforeWindow.modelVersion).toBe(KALSHI_MODEL_VERSION);
    expect(beforeWindow.shadowPrediction).toMatchObject({
      modelId: artifact().id,
      featureCutoffAt: CAPTURE,
    });
    const duringWindow = artifact(0.2, { trainedAt: START + 1000, shadowStartsAt: START + 1000 });
    expect(
      getResearchForecast(input, { candidate: duringWindow }, START).shadowPrediction,
    ).toBeNull();
    expect(getResearchForecast(input, { candidate: artifact() }).shadowPrediction).toBeNull();
  });

  test('requires the Kalshi journal envelope for learned fixed records', async () => {
    const view = createObservation({ now: CAPTURE, recordEvidence: false });
    await flush();
    const fixed = stored(view);
    const read = (version) =>
      loadJournal({
        getItem: () => JSON.stringify({ version, forecasts: [fixed], scheduledForecast: null }),
      });
    expect(read(5).warning).not.toBeNull();
    expect(read(5).forecasts).toEqual([]);
    expect(read(7).forecasts).toEqual([fixed]);
  });
});
