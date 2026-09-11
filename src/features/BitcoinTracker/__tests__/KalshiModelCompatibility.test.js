import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getValidatedForecast, loadJournal, saveJournal } from '../utils/journal.utils';
import { getKalshiOutcome, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_MODEL_PARAMETERS, KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import {
  createKalshiResearchRecorder,
  getValidatedKalshiRecorderState,
} from '../utils/kalshi/researchRecorder.utils';
import { CALIBRATION_VERSION, KALSHI_OUTCOME_MODEL_VERSION } from '../utils/learning/model.utils';
import { LEARNING_FEATURE_VERSION } from '../utils/learning/features.utils';

const START = Date.UTC(2026, 8, 10, 12);
const END = START + 900_000;
const CAPTURE = START + 180_000;
const legacyParameters = {
  sampleCount: 60,
  maximumBenchmarkAgeMs: 5000,
  minimumProxyBasisLogDeviation: 0.0005,
};
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

function capturedForecast(version = 'kalshi-brti-average-v1') {
  return {
    id: 'saved-kalshi-call',
    createdAt: CAPTURE,
    startsAt: START,
    expiresAt: END,
    timingMode: 'end',
    price: 50_010,
    target: 50_000,
    aboveProbability: 0.61,
    belowProbability: 0.39,
    direction: 'above',
    status: 'pending',
    modelVersion: version,
    calculationMode: 'baseline-fallback',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshiMarket: { ...contract },
    analysis: getFixedForecastAnalysis({
      startedAt: START,
      expiresAt: END,
      policyVersion: KALSHI_POLICY_VERSION,
    }),
    kalshi: {
      marketTicker: contract.ticker,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      referenceSource: 'coinbase-proxy',
      referencePrice: 50_010,
      referenceAt: CAPTURE,
      modelKind: 'experimental',
      approximate: true,
      observedSampleCount: 0,
      missingElapsedSampleCount: 0,
      futureSampleCount: 60,
      basisLogDeviation: 0.0005,
      basisAssumption: 'Unfitted shared venue-to-index uncertainty floor.',
      expectedSettlementAverage: 50_010,
      settlementStandardDeviation: 200,
      settlementLowerBound: 49_800,
      settlementUpperBound: 50_200,
      requiredFutureAverage: 49_999.995,
      warning: 'Coinbase proxy estimate: the live settlement benchmark is unavailable.',
      parameters: {
        ...(version === 'kalshi-brti-average-v1' ? legacyParameters : KALSHI_MODEL_PARAMETERS),
      },
    },
  };
}

function storageFor(forecasts) {
  let value = JSON.stringify({ version: 7, forecasts, scheduledForecast: null });
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

describe('Kalshi saved model compatibility', () => {
  test.each(['pending', 'awaiting-settlement', 'unobserved', 'resolved'])(
    'preserves a historical v1 %s forecast and its captured numbers through reload and save',
    (status) => {
      const forecast = { ...capturedForecast(), status };
      if (status === 'resolved') {
        const outcome = getKalshiOutcome(
          {
            ...contract,
            status: 'finalized',
            result: 'yes',
            settlementPrice: 50_012.34,
            settledAt: END + 1000,
            receivedAt: END + 2000,
          },
          END + 2000,
        );
        Object.assign(forecast, {
          kalshiOutcome: outcome,
          observedPrice: outcome.observedPrice,
          observedAt: END,
          outcome: 'above',
          correct: true,
        });
      }
      const storage = storageFor([forecast]);
      const restored = loadJournal(storage);
      expect(restored).toEqual({ forecasts: [forecast], scheduledForecast: null, warning: null });
      expect(saveJournal(restored.forecasts, storage)).toBeNull();
      expect(loadJournal(storage).forecasts).toEqual([forecast]);
      expect(restored.forecasts[0].kalshi.parameters).toEqual(legacyParameters);
      expect(restored.forecasts[0].modelVersion).toBe('kalshi-brti-average-v1');
    },
  );

  test.each(['analyzing', 'withheld'])(
    'keeps a v1 %s entry so the current lifecycle can finish it explicitly',
    (status) => {
      const forecast = {
        ...capturedForecast(),
        createdAt: START,
        status,
        aboveProbability: null,
        belowProbability: null,
        direction: 'neutral',
        calculationMode: null,
        kalshi: null,
        ...(status === 'withheld' ? { withholdingReason: 'model-unavailable' } : {}),
      };
      expect(loadJournal(storageFor([forecast])).forecasts).toEqual([forecast]);
    },
  );

  test('accepts new baseline calls with current parameters without rewriting old assumptions', () => {
    const current = capturedForecast(KALSHI_MODEL_VERSION);
    expect(getValidatedForecast(current)).toEqual(current);
    const missingParameter = JSON.parse(JSON.stringify(current));
    delete missingParameter.kalshi.parameters.maximumBasisComparisonAgeMs;
    expect(getValidatedForecast(missingParameter)).toBeNull();
    const corruptLegacy = capturedForecast();
    corruptLegacy.kalshi.parameters.minimumProxyBasisLogDeviation = 0;
    expect(getValidatedForecast(corruptLegacy)).toBeNull();
  });

  test.each([
    ['outcome-logistic-kalshi-v1', 'deadline-reversal-features-v1', legacyParameters],
    [KALSHI_OUTCOME_MODEL_VERSION, LEARNING_FEATURE_VERSION, KALSHI_MODEL_PARAMETERS],
  ])(
    'retains %s learned calls using their corresponding feature schema',
    (version, schema, parameters) => {
      const forecast = capturedForecast();
      forecast.modelVersion = version;
      forecast.calculationMode = 'outcome-trained';
      forecast.kalshi.parameters = { ...parameters };
      forecast.learning = {
        applied: true,
        modelId: `${version}-saved`,
        calibrationVersion: CALIBRATION_VERSION,
        trainingCutoffAt: START - 1000,
        baselineAboveProbability: 0.53,
        aboveProbability: forecast.aboveProbability,
        featureVersion: schema,
      };
      expect(loadJournal(storageFor([forecast])).forecasts).toEqual([forecast]);
      expect(
        getValidatedForecast({
          ...forecast,
          learning: { ...forecast.learning, modelId: 'outcome-logistic-kalshi-v99-saved' },
        }),
      ).toBeNull();
      expect(
        getValidatedForecast({
          ...forecast,
          learning: { ...forecast.learning, featureVersion: `${schema}-wrong` },
        }),
      ).toBeNull();
    },
  );

  test('retains older pending research checkpoints with their original Kalshi evidence', () => {
    const recorderId = 'saved-recorder';
    const recorder = createKalshiResearchRecorder({ recorderId });
    const estimate = capturedForecast();
    const result = recorder.advance({
      now: CAPTURE,
      markets: [{ ...contract, status: 'active', receivedAt: CAPTURE }],
      ticker: { price: 50_010, time: CAPTURE, receivedAt: CAPTURE },
      getEstimate: () => ({ ...estimate, available: true }),
    });
    const state = result.state;
    expect(state.markets[0].checkpoints[0]).toMatchObject({
      status: 'pending',
      modelVersion: 'kalshi-brti-average-v1',
      aboveProbability: 0.61,
      kalshi: estimate.kalshi,
    });
    expect(getValidatedKalshiRecorderState(state, recorderId)).toEqual(state);
  });
});
