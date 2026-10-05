import { getAdvisorForecastEvaluation } from '../utils/advisorForecastEvaluation.utils';
import { getKalshiOutcome } from '../../../utils/kalshi/contract.utils';
import { START, contract, bookAt } from './TradingAdvisor.fixtures';

function entry(market = contract, capturedAt = market.startsAt + 60000) {
  const currentForecast = {
    available: true,
    aboveProbability: 0.9,
    capturedAt,
    contract: market,
    modelVersion: 'production-v1',
    modelId: null,
  };
  return {
    id: `entry:${market.ticker}:${capturedAt}`,
    kind: 'fill',
    action: 'buy',
    side: 'yes',
    probability: 0.99,
    contract: market,
    recordedAt: capturedAt,
    book: {
      ...bookAt(capturedAt),
      ticker: market.ticker,
      yesAsks: [{ price: 0.65, quantity: 100 }],
      noAsks: [{ price: 0.4, quantity: 100 }],
    },
    forecast: currentForecast,
    forecastReconciliation: {
      version: 'advisor-forecast-reconciliation-v1',
      mode: 'shadow-only',
      observedAt: capturedAt,
      contract: market,
      originalForecast: { ...currentForecast, aboveProbability: 0.99 },
      currentForecast,
      recomputed: true,
      sameExecutionBook: true,
      executionBookProbability: 0.625,
      executionBookRequestedAt: capturedAt,
      executionBookReceivedAt: capturedAt,
      originalResearchMarketProbability: 0.9165,
      marketBlend: {
        available: true,
        appliedMarket: true,
        rawAboveProbability: 0.85,
        aboveProbability: 0.83,
        marketProbability: 0.625,
        modelId: 'candidate-1',
        modelVersion: 'challenger-v2',
        rawModelVersion: 'production-v1',
        policyVersion: 'kalshi-market-blend-v1',
        calibrationVersion: 'checkpoint-v3',
        calibrationStatus: 'fitted',
      },
      activeMarketBlend: null,
    },
  };
}

function settlement(market = contract, result = 'no') {
  const recordedAt = market.expiresAt + 1000;
  const outcome = getKalshiOutcome(
    {
      ...market,
      status: 'settled',
      result,
      settlementPrice: market.target + (result === 'yes' ? 1 : -1),
      receivedAt: recordedAt,
      settledAt: recordedAt,
    },
    recordedAt,
  );
  return {
    id: `outcome:${market.ticker}`,
    kind: 'settlement',
    contract: market,
    outcome,
    recordedAt,
  };
}

function nextContract(index) {
  return {
    ...contract,
    ticker: `${contract.ticker}-${index}`,
    eventTicker: `${contract.eventTicker}-${index}`,
    startsAt: START + index * 900000,
    expiresAt: START + (index + 1) * 900000,
  };
}

const comparison = (report, variant) => report.comparisons.find((row) => row.variant === variant);
const coverage = (report, variant) => report.coverage.find((row) => row.variant === variant);

test('scores the 99% versus 62.5% loss with paired same-book probabilities and calibration bins', () => {
  const events = [entry(), settlement()];
  const original = JSON.stringify(events);
  const report = getAdvisorForecastEvaluation(events);
  expect(report).toMatchObject({
    mode: 'exploratory-observational',
    automaticActivation: false,
    independentWindows: 1,
    settledWindows: 1,
    pendingWindows: 0,
  });
  const midpoint = comparison(report, 'execution-midpoint');
  expect(midpoint).toMatchObject({
    pairedWindows: 1,
    scores: { brier: 0.625 ** 2, directionAccuracy: 0 },
    savedIntentionScores: { brier: 0.99 ** 2, directionAccuracy: 0 },
  });
  expect(midpoint.brierDifference).toBeCloseTo(0.625 ** 2 - 0.99 ** 2);
  expect(midpoint.scores.calibrationBins.find((bin) => bin.count)).toMatchObject({
    lower: 0.6,
    meanProbability: 0.625,
    observedAboveRate: 0,
  });
  expect(comparison(report, 'raw-market-blend').scores.brier).toBeCloseTo(0.85 ** 2);
  expect(comparison(report, 'raw-market-blend').modelVersion).toBe('production-v1');
  expect(comparison(report, 'calibrated-market-blend')).toMatchObject({
    modelId: 'candidate-1',
    calibrationVersion: 'checkpoint-v3',
    calibrationStatus: 'fitted',
    scores: { brier: 0.83 ** 2 },
  });
  expect(JSON.stringify(events)).toBe(original);
});

test('selects the first fill per exact contract despite ordering, repeated purchases, or partial fills', () => {
  const first = entry();
  const later = entry(contract, first.recordedAt + 2000);
  later.probability = 0.1;
  later.forecastReconciliation = null;
  const outcome = settlement();
  const report = getAdvisorForecastEvaluation([
    later,
    { ...outcome, kind: 'comparison' },
    first,
    outcome,
  ]);
  expect(report).toMatchObject({
    entryCount: 2,
    repeatedEntryCount: 1,
    independentWindows: 1,
    settledWindows: 1,
    missingReconciliationWindows: 0,
  });
  expect(comparison(report, 'saved-intention').scores.brier).toBe(0.99 ** 2);
});

test('reports historical missing inputs, unavailable blends, and unsettled windows without backfill', () => {
  const historical = entry();
  delete historical.forecastReconciliation;
  const unavailable = entry(nextContract(1));
  unavailable.forecastReconciliation.marketBlend.available = false;
  const pending = entry(nextContract(2));
  const report = getAdvisorForecastEvaluation([
    historical,
    unavailable,
    pending,
    settlement(),
    settlement(unavailable.contract),
  ]);
  expect(report).toMatchObject({ independentWindows: 3, settledWindows: 2, pendingWindows: 1 });
  expect(coverage(report, 'raw-market-blend')).toMatchObject({
    availableWindows: 1,
    settledAvailableWindows: 0,
    missingWindows: 1,
    unavailableWindows: 1,
    coverage: 1 / 3,
  });
  expect(comparison(report, 'raw-market-blend')).toMatchObject({
    pairedWindows: 0,
    scores: { brier: null, directionAccuracy: null },
    brierDifference: null,
  });
});

test('converts NO intention probabilities into YES outcome space before scoring', () => {
  const purchase = entry();
  purchase.side = 'no';
  purchase.probability = 0.8;
  const report = getAdvisorForecastEvaluation([purchase, settlement()]);
  expect(comparison(report, 'saved-intention').scores.brier).toBeCloseTo(0.04);
  expect(comparison(report, 'saved-intention').scores.directionAccuracy).toBe(1);
});

test('keeps candidate ids, active outputs, policy versions, and calibration versions separate', () => {
  const first = entry();
  const second = entry(nextContract(1));
  second.forecastReconciliation.marketBlend.modelId = 'candidate-2';
  second.forecastReconciliation.marketBlend.calibrationVersion = 'checkpoint-v4';
  second.forecastReconciliation.activeMarketBlend = {
    ...first.forecastReconciliation.marketBlend,
    modelId: 'active-1',
  };
  const third = entry(nextContract(2));
  third.forecastReconciliation.marketBlend.policyVersion = 'future-blend';
  const report = getAdvisorForecastEvaluation([
    first,
    second,
    third,
    settlement(),
    settlement(second.contract),
    settlement(third.contract),
  ]);
  const calibrated = report.comparisons.filter((row) => row.variant === 'calibrated-market-blend');
  expect(calibrated).toHaveLength(4);
  expect(calibrated.every((row) => row.pairedWindows === 1)).toBe(true);
  expect(calibrated.find((row) => row.role === 'active').modelId).toBe('active-1');
  expect(coverage(report, 'calibrated-market-blend').availableWindows).toBe(3);
});

test.each([
  'wrong-book',
  'noncausal-book',
  'research-midpoint',
  'wrong-contract',
  'future-capture',
])('%s evidence cannot become a same-book experiment result', (mode) => {
  const purchase = entry();
  if (mode === 'wrong-book') purchase.book.ticker += '-WRONG';
  if (mode === 'noncausal-book') purchase.book.requestedAt++;
  if (mode === 'research-midpoint')
    purchase.forecastReconciliation.executionBookProbability = 0.9165;
  if (mode === 'wrong-contract') purchase.forecastReconciliation.contract = nextContract(1);
  if (mode === 'future-capture') purchase.forecastReconciliation.observedAt++;
  const report = getAdvisorForecastEvaluation([purchase, settlement()]);
  expect(comparison(report, 'refreshed-production')).toBeUndefined();
  expect(comparison(report, 'execution-midpoint')).toBeUndefined();
  expect(comparison(report, 'calibrated-market-blend')).toBeUndefined();
  expect(comparison(report, 'saved-intention').pairedWindows).toBe(1);
});

test.each(['not_calibrated', 'identity', 'outside_applicability', 'outside_checkpoint', null])(
  'a %s raw blend remains available without inventing fitted calibration',
  (status) => {
    const purchase = entry();
    purchase.forecastReconciliation.marketBlend.calibrationStatus = status;
    purchase.forecastReconciliation.activeMarketBlend = {
      ...purchase.forecastReconciliation.marketBlend,
      modelId: 'active-1',
    };
    const report = getAdvisorForecastEvaluation([purchase, settlement()]);
    expect(comparison(report, 'raw-market-blend').pairedWindows).toBe(1);
    expect(comparison(report, 'calibrated-market-blend')).toBeUndefined();
    expect(coverage(report, 'calibrated-market-blend')).toMatchObject({
      availableWindows: 0,
      missingWindows: 0,
      unavailableWindows: 1,
    });
  },
);

test.each([-1, 1])(
  'a current capture shifted by %s ms cannot score same-book model variants',
  (offset) => {
    const purchase = entry();
    purchase.forecastReconciliation.currentForecast.capturedAt += offset;
    const report = getAdvisorForecastEvaluation([purchase, settlement()]);
    expect(comparison(report, 'refreshed-production')).toBeUndefined();
    expect(comparison(report, 'raw-market-blend')).toBeUndefined();
    expect(comparison(report, 'calibrated-market-blend')).toBeUndefined();
    expect(comparison(report, 'execution-midpoint').pairedWindows).toBe(1);
  },
);

test('rejects invalid and conflicting official outcomes instead of selecting a favorable result', () => {
  const forged = settlement();
  forged.outcome.target++;
  const second = entry(nextContract(1));
  const report = getAdvisorForecastEvaluation([
    entry(),
    forged,
    second,
    settlement(second.contract, 'yes'),
    settlement(second.contract, 'no'),
  ]);
  expect(report).toMatchObject({
    settledWindows: 0,
    pendingWindows: 1,
    conflictingOutcomeWindows: 1,
    invalidOutcomeCount: 1,
  });
  expect(report.comparisons.every((row) => row.pairedWindows === 0)).toBe(true);
});

test('a balanced probability abstains on paired direction accuracy but still has a Brier score', () => {
  const purchase = entry();
  purchase.forecastReconciliation.currentForecast.aboveProbability = 0.5;
  const report = getAdvisorForecastEvaluation([purchase, settlement()]);
  expect(comparison(report, 'refreshed-production')).toMatchObject({
    scores: { brier: 0.25, directionCalls: 0, directionAccuracy: null },
    savedIntentionScores: { directionCalls: 0, directionAccuracy: null },
    directionAccuracyDifference: null,
  });
});

test('invalid purchase timing is excluded and empty evidence remains unscored', () => {
  expect(getAdvisorForecastEvaluation([])).toMatchObject({
    independentWindows: 0,
    comparisons: [],
    pendingWindows: 0,
  });
  const invalid = entry(contract, contract.expiresAt);
  const report = getAdvisorForecastEvaluation([invalid, settlement()]);
  expect(report).toMatchObject({ invalidEntryCount: 1, independentWindows: 0 });
});
