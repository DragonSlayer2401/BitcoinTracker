import { configureStore } from '@reduxjs/toolkit';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Provider, useSelector } from 'react-redux';
import useForecastEvidence from '../hooks/useForecastEvidence';
import useFixedPrediction from '../hooks/useFixedPrediction';
import reducer, { forecastRecorded } from '../state/slices/trackerSlice';
import { selectActiveForecast } from '../state/selectors/trackerSelectors';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { appendEvidenceRows } from '../utils/evidenceStorage.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getValidatedForecast, loadJournal, saveJournal } from '../utils/journal.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import {
  KALSHI_MODEL_VERSION,
  KALSHI_DERIVATIVES_MODEL_VERSION,
  LEGACY_KALSHI_MODEL_VERSION,
  LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION,
  isKalshiDerivativesModelVersion,
} from '../utils/kalshi/forecast.utils';
import {
  RESEARCH_EXPERIMENT_V3,
  RESEARCH_EXPERIMENT_V5,
} from '../utils/researchVariantConfig.utils';

jest.mock('../utils/evidenceStorage.utils', () => ({
  ...jest.requireActual('../utils/evidenceStorage.utils'),
  appendEvidenceRows: jest.fn(),
}));

const START = Date.UTC(2026, 8, 17, 12);
const CAPTURE = START + 180_000;
const END = START + 900_000;
const contract = {
  ticker: 'KXBTC15M-26SEP171215-15',
  eventTicker: 'KXBTC15M-26SEP171215',
  seriesTicker: 'KXBTC15M',
  startsAt: START,
  expiresAt: END,
  target: 49_990,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
const versions = [
  [LEGACY_KALSHI_MODEL_VERSION, RESEARCH_EXPERIMENT_V3],
  [LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION, RESEARCH_EXPERIMENT_V3],
  [KALSHI_MODEL_VERSION, RESEARCH_EXPERIMENT_V5],
  [KALSHI_DERIVATIVES_MODEL_VERSION, RESEARCH_EXPERIMENT_V5],
];

function inputs(modelVersion, { proxy = false, quoteLag = 0 } = {}) {
  const samples = Array.from({ length: 3600 }, (_, index) => ({
    time: CAPTURE - (3599 - index) * 1000,
    price: 50_000 * Math.exp(0.0003 * Math.sin(index / 60)),
  }));
  const candles = Array.from({ length: 120 }, (_, index) => ({
    time: CAPTURE - (120 - index) * 60_000,
    open: 50_000,
    high: 50_030,
    low: 49_970,
    close: index % 2 ? 50_010 : 49_990,
    volume: 10,
  }));
  return {
    now: CAPTURE,
    candles: proxy ? candles : [],
    ticker: proxy
      ? {
          price: 50_000,
          bid: 49_999,
          ask: 50_001,
          volume: 100,
          time: CAPTURE - quoteLag,
          receivedAt: CAPTURE,
        }
      : null,
    stream: null,
    derivatives: isKalshiDerivativesModelVersion(modelVersion) ? null : undefined,
    kalshiMarket: contract,
    target: contract.target,
    expiresAt: END,
    horizonMinutes: 12,
    benchmark: proxy
      ? null
      : { available: true, status: 'live', receivedAt: CAPTURE, samples, current: samples.at(-1) },
  };
}

function analyzing(modelVersion) {
  return {
    id: 'compatibility-fixed',
    startsAt: START,
    createdAt: START,
    expiresAt: END,
    timingMode: 'end',
    price: 50_000,
    target: contract.target,
    modelVersion,
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

function savedForecast(estimate) {
  return {
    ...analyzing(estimate.modelVersion),
    createdAt: CAPTURE,
    price: estimate.kalshi.referencePrice,
    status: 'pending',
    direction: estimate.direction,
    aboveProbability: estimate.aboveProbability,
    belowProbability: estimate.belowProbability,
    calculationMode:
      estimate.pressure?.applied || estimate.derivatives?.applied
        ? 'pressure-adjusted'
        : 'baseline-fallback',
    kalshi: estimate.kalshi,
    ...(estimate.derivatives ? { derivatives: estimate.derivatives } : {}),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(CAPTURE);
  window.localStorage.clear();
  appendEvidenceRows.mockReset();
  appendEvidenceRows.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

test.each(versions)(
  'restored %s observations retain their matching calculation generation',
  async (modelVersion, researchVersion) => {
    const entry = analyzing(modelVersion);
    const original = JSON.stringify(entry);
    const input = inputs(modelVersion);
    const expected = getResearchForecast(input, {}, START, { researchVersion });
    renderHook(() =>
      useForecastEvidence({
        ...input,
        forecasts: [entry],
        progress: null,
        isReady: true,
        models: {},
      }),
    );
    await act(async () => {});
    const observation = appendEvidenceRows.mock.calls
      .flatMap(([rows]) => rows)
      .find((row) => row.event === 'observation');
    expect(observation.modelVersion).toBe(modelVersion);
    expect(observation.learningFeatures.baselineModelVersion).toBe(modelVersion);
    expect(observation.researchExperiment).toEqual(expected.researchExperiment);
    expect(JSON.stringify(entry)).toBe(original);
  },
);

test.each(versions)(
  'restored %s fixed publication retains its original policy and saved probability',
  (modelVersion, researchVersion) => {
    const store = configureStore({ reducer: { tracker: reducer } });
    store.dispatch(forecastRecorded(analyzing(modelVersion)));
    const input = inputs(modelVersion);
    const expected = getResearchForecast(input, {}, START, { researchVersion });
    const view = renderHook(
      (props) =>
        useFixedPrediction({
          ...props,
          forecast: useSelector(selectActiveForecast),
          hasRequestError: true,
          models: {},
        }),
      {
        initialProps: input,
        wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
      },
    );
    const fixed = store.getState().tracker.forecasts[0];
    expect(fixed.status).toBe('pending');
    expect(fixed.modelVersion).toBe(modelVersion);
    expect(fixed.aboveProbability).toBe(expected.aboveProbability);
    expect(getValidatedForecast(fixed)).toEqual(fixed);
    expect(saveJournal([fixed])).toBeNull();
    expect(loadJournal().forecasts).toEqual([fixed]);
    view.rerender({ ...input, benchmark: null, derivatives: null });
    expect(store.getState().tracker.forecasts[0]).toEqual(fixed);
  },
);

test.each([KALSHI_MODEL_VERSION, KALSHI_DERIVATIVES_MODEL_VERSION])(
  'current %s proxy records preserve a real earlier quote timestamp',
  (modelVersion) => {
    const estimate = getResearchForecast(
      inputs(modelVersion, { proxy: true, quoteLag: 10_000 }),
      {},
      START,
    );
    const saved = savedForecast(estimate);
    expect(saved.kalshi.referenceAt).toBe(CAPTURE - 10_000);
    expect(getValidatedForecast(saved)).toEqual(saved);
    for (const referenceAt of [CAPTURE - 20_001, CAPTURE + 1]) {
      expect(
        getValidatedForecast({ ...saved, kalshi: { ...saved.kalshi, referenceAt } }),
      ).toBeNull();
    }
  },
);

test.each([LEGACY_KALSHI_MODEL_VERSION, LEGACY_KALSHI_DERIVATIVES_MODEL_VERSION])(
  'legacy %s proxy metadata keeps its exact capture-time rule',
  (modelVersion) => {
    const estimate = getResearchForecast(
      inputs(modelVersion, { proxy: true, quoteLag: 10_000 }),
      {},
      START,
      { researchVersion: RESEARCH_EXPERIMENT_V3 },
    );
    const saved = savedForecast(estimate);
    expect(saved.kalshi.referenceAt).toBe(CAPTURE);
    expect(getValidatedForecast(saved)).toEqual(saved);
    expect(
      getValidatedForecast({
        ...saved,
        kalshi: { ...saved.kalshi, referenceAt: CAPTURE - 10_000 },
      }),
    ).toBeNull();
  },
);
