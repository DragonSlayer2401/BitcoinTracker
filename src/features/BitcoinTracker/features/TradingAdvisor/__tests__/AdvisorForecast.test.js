import {
  createAdvisorForecast,
  getAdvisorBookQuote,
  getAdvisorForecastReconciliation,
} from '../utils/advisorForecast.utils';
import { getResearchForecast } from '../../../utils/researchForecast.utils';
import { replayResearchInputSnapshot } from '../../../utils/researchExperiments.utils';
import {
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_POLICY_VERSION,
  CHALLENGER_REQUIREMENTS,
  getChallengerPolicyVersion,
} from '../../../utils/learning/challengerModel.utils';
import {
  CHALLENGER_CALIBRATION_VERSION,
  fitCheckpointCalibration,
} from '../../../utils/learning/challengerCheckpoint.utils';
import { MARKET_BLEND_POLICY } from '../../../utils/researchVariantConfig.utils';
import { START, contract, bookAt } from './TradingAdvisor.fixtures';

const NOW = contract.expiresAt - 6 * 60_000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const executionBook = () => ({
  ...bookAt(NOW),
  requestedAt: NOW - 100,
  yesAsks: [{ price: 0.63, quantity: 100 }],
  noAsks: [{ price: 0.38, quantity: 100 }],
});

function input(now = NOW, referencePrice = 75010) {
  const minute = Math.floor(now / 60000) * 60000;
  let price = referencePrice;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const open = price;
    price *= Math.exp(index % 2 ? 0.001 : -0.001);
    return {
      time: minute - (120 - index) * 60000,
      open,
      high: Math.max(open, price) * 1.0001,
      low: Math.min(open, price) / 1.0001,
      close: price,
      volume: 10,
    };
  });
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: now - (1200 - index) * 1000,
    receivedAt: now - (1200 - index) * 1000,
    price: referencePrice * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
  }));
  return {
    now,
    kalshiMarket: contract,
    kalshiQuote: getAdvisorBookQuote({ contract, book: executionBook(), now }),
    candles,
    candlesReceivedAt: now,
    ticker: { price, bid: price - 1, ask: price + 1, time: now, receivedAt: now, volume: 100 },
    benchmark: { status: 'live', samples, current: samples.at(-1), receivedAt: now },
    stream: {
      status: 'disconnected',
      flow: { available: false },
      liquidity: { available: false },
      quality: {},
    },
  };
}

function calibratedArtifact(values, id, fitted) {
  const features = getResearchForecast(values).learningFeatures;
  return {
    id: `${CHALLENGER_MODEL_VERSION}-market-blend-${id}`,
    version: CHALLENGER_MODEL_VERSION,
    policyVersion: CHALLENGER_POLICY_VERSION,
    variantPolicyVersion: getChallengerPolicyVersion('market-blend'),
    kind: 'market-blend',
    variantName: 'market-blend',
    status: 'shadow',
    outcomeDefinition: contract.outcomeDefinition,
    trainedAt: START - 1,
    trainingCutoffAt: START - 2,
    shadowStartsAt: START - 1,
    featureVersion: features.schemaVersion,
    pipeline: {
      baselineModelVersion: features.baselineModelVersion,
      referenceSource: features.referenceSource,
      featureInputSource: features.featureInputSource,
      featureVersion: features.schemaVersion,
    },
    requirements: { ...CHALLENGER_REQUIREMENTS },
    applicability: { minimumHorizonMinutes: 1, maximumHorizonMinutes: 15 },
    calibration: {
      version: CHALLENGER_CALIBRATION_VERSION,
      primaryCutoffAt: START - 4000,
      startedAt: START - 3000,
      cutoffAt: START - 2000,
      independentWindows: 20,
      checkpoints: fitCheckpointCalibration(
        fitted
          ? Array.from({ length: 20 }, (_, index) => ({
              horizonMinutes: 6,
              probability: 0.8,
              outcome: index % 2,
            }))
          : [],
      ),
    },
  };
}

test('the validated execution depth supplies both complementary bid/ask pairs', () => {
  const book = executionBook();
  const quote = getAdvisorBookQuote({ contract, book, now: NOW });
  expect(quote).toMatchObject({
    marketTicker: contract.ticker,
    target: contract.target,
    expiresAt: contract.expiresAt,
    requestedAt: NOW - 100,
    receivedAt: NOW,
    yesBid: 0.62,
    yesAsk: 0.63,
    noBid: 0.37,
    noAsk: 0.38,
  });
  expect((quote.yesBid + quote.yesAsk) / 2).toBe(0.625);
  expect(book).toEqual(executionBook());
});

test.each([
  [
    'stale',
    (book) => {
      book.receivedAt = NOW - 15001;
      book.requestedAt = book.receivedAt - 100;
    },
  ],
  ['future', (book) => (book.receivedAt = NOW + 1)],
  ['missing request', (book) => delete book.requestedAt],
  ['noncausal request', (book) => (book.requestedAt = NOW + 1)],
  ['mismatched ticker', (book) => (book.ticker += '-OTHER')],
  ['mismatched target', (book) => (book.target = contract.target + 1)],
  ['mismatched expiry', (book) => (book.expiresAt = contract.expiresAt + 1000)],
  ['one sided', (book) => (book.noAsks = [])],
  ['crossed', (book) => (book.noAsks[0].price = 0.36)],
  ['invalid price', (book) => (book.yesAsks[0].price = 0.63123)],
  ['invalid quantity', (book) => (book.yesAsks[0].quantity = -1)],
  ['unordered depth', (book) => book.yesAsks.push({ price: 0.62, quantity: 5 })],
])('%s depth is unavailable instead of inheriting the research-market quote', (_, change) => {
  const book = executionBook();
  change(book);
  expect(getAdvisorBookQuote({ contract, book, now: NOW })).toBeNull();
});

test('market comparison needs valid depth but does not invent dependence on execution fees', () => {
  const book = { ...executionBook(), fee: null };
  expect(getAdvisorBookQuote({ contract, book, now: NOW })).not.toBeNull();
});

test('a locked decimal book remains valid through quote conversion and same-book reconciliation', () => {
  const book = {
    ...executionBook(),
    yesAsks: [{ price: 0.3, quantity: 100 }],
    noAsks: [{ price: 0.7, quantity: 100 }],
  };
  const quote = getAdvisorBookQuote({ contract, book, now: NOW });
  expect(quote).toMatchObject({ yesBid: 0.3, yesAsk: 0.3, noBid: 0.7, noAsk: 0.7 });
  const current = createAdvisorForecast({ ...input(), kalshiQuote: quote }, {}, START);
  expect(
    getAdvisorForecastReconciliation({
      contract,
      currentForecast: current,
      book,
      now: NOW,
    }),
  ).toMatchObject({
    recomputed: true,
    sameExecutionBook: true,
    executionBookProbability: 0.3,
    marketBlend: { available: true, marketProbability: 0.3 },
  });
});

test('execution book freshness includes the existing fifteen-second boundary', () => {
  const book = executionBook();
  book.receivedAt = NOW - 15000;
  book.requestedAt = book.receivedAt - 100;
  expect(getAdvisorBookQuote({ contract, book, now: NOW })).not.toBeNull();
});

test('99% production and 91.65% research evidence retain their gaps to the 62.5% entry book', () => {
  const original = createAdvisorForecast(input(NOW - 5000, 75500), {}, START);
  // Preserve the recorded losing purchase independently of today's model calculation.
  original.aboveProbability = 0.99;
  original.marketProbability = 0.9165;
  original.marketQuoteReceivedAt = NOW - 5000;
  const current = createAdvisorForecast(input(), {}, START);
  const evidence = getAdvisorForecastReconciliation({
    contract,
    originalForecast: original,
    currentForecast: current,
    book: executionBook(),
    now: NOW,
  });
  expect(evidence).toMatchObject({
    mode: 'shadow-only',
    recomputed: true,
    sameExecutionBook: true,
    reason: null,
    executionBookProbability: 0.625,
    originalResearchMarketProbability: 0.9165,
    originalResearchMarketQuoteReceivedAt: NOW - 5000,
    disagreementThreshold: 0.15,
    largeDisagreement: true,
    originalForecast: { aboveProbability: 0.99, referencePrice: 75500 },
    currentForecast: { referencePrice: 75010, capturedAt: NOW },
    marketBlend: { available: true, appliedMarket: true, marketProbability: 0.625 },
  });
  expect(evidence.gaps.originalForecastToExecutionBook).toBeCloseTo(0.365);
  expect(evidence.gaps.researchMarketToExecutionBook).toBeCloseTo(0.2915);
  expect(evidence.gaps.forecastChange).toBeCloseTo(current.aboveProbability - 0.99);
  const weight = 0.15 + (0.5 - 0.15) * (1 - 6 / 15);
  expect(current.marketBlend.rawAboveProbability).toBeCloseTo(
    (1 - weight) * current.aboveProbability + weight * 0.625,
  );
  expect(current.marketBlend.aboveProbability).toBe(current.marketBlend.rawAboveProbability);
  expect(current.marketBlend.rawModelVersion).toBe(current.modelVersion);
  expect(replayResearchInputSnapshot(current.researchInputSnapshot).aboveProbability).toBe(
    current.aboveProbability,
  );
});

test('same-family raw, calibrated candidate and calibrated active outputs keep separate identities', () => {
  const values = input();
  const candidate = calibratedArtifact(values, 'replacement-market-blend', false);
  const active = calibratedArtifact(values, 'active-market-blend', true);
  active.activation = {
    modelId: active.id,
    activatedAt: START,
    shadowEvaluation: {
      modelId: active.id,
      phase: 'confirmation',
      eligibleForPromotion: true,
      approvedCheckpoints: [6],
      evaluatedAt: START,
    },
  };
  const forecast = createAdvisorForecast(
    values,
    { challengers: { active, candidates: [candidate] } },
    START,
  );
  const raw = createAdvisorForecast(values, {}, START).marketBlend;
  expect(forecast.marketBlend).toMatchObject({
    available: true,
    modelId: candidate.id,
    modelVersion: CHALLENGER_MODEL_VERSION,
    rawModelVersion: raw.modelVersion,
    policyVersion: MARKET_BLEND_POLICY.version,
    calibrationVersion: CHALLENGER_CALIBRATION_VERSION,
    calibrationStatus: 'identity',
    checkpointMinutes: 6,
    marketProbability: 0.625,
    rawAboveProbability: raw.aboveProbability,
  });
  expect(forecast.activeMarketBlend).toMatchObject({
    available: true,
    modelId: active.id,
    modelVersion: CHALLENGER_MODEL_VERSION,
    rawModelVersion: raw.modelVersion,
    calibrationStatus: 'fitted',
    checkpointMinutes: 6,
    marketProbability: 0.625,
    rawAboveProbability: forecast.marketBlend.rawAboveProbability,
  });
  expect(forecast.activeMarketBlend.aboveProbability).not.toBe(
    forecast.marketBlend.aboveProbability,
  );
  expect(forecast.modelId).toBe(active.id);
  expect(forecast.aboveProbability).toBe(forecast.activeMarketBlend.aboveProbability);
  expect(replayResearchInputSnapshot(forecast.researchInputSnapshot).aboveProbability).toBe(
    forecast.aboveProbability,
  );
});

test('flags new disagreement introduced by the current recomputation without changing it', () => {
  const current = createAdvisorForecast(input(NOW, 75500), {}, START);
  const result = getAdvisorForecastReconciliation({
    contract,
    originalForecast: { aboveProbability: 0.625, marketProbability: 0.625 },
    currentForecast: current,
    book: executionBook(),
    now: NOW,
  });
  expect(result).toMatchObject({
    recomputed: true,
    largeDisagreement: true,
    currentForecast: { aboveProbability: current.aboveProbability },
    gaps: { originalForecastToExecutionBook: 0, researchMarketToExecutionBook: 0 },
  });
  expect(result.gaps.currentForecastToExecutionBook).toBeGreaterThan(0.15);
});

test('reconciliation reads blend evidence from the same-book snapshot, not a mixed compact field', () => {
  const forecast = createAdvisorForecast(input(), {}, START);
  const actualBlend = clone(forecast.marketBlend);
  forecast.marketBlend.aboveProbability = 0.999;
  forecast.marketBlend.marketProbability = 0.9165;
  const result = getAdvisorForecastReconciliation({
    contract,
    currentForecast: forecast,
    book: executionBook(),
    now: NOW,
  });
  expect(result.recomputed).toBe(true);
  expect(result.marketBlend).toEqual(actualBlend);
});

test.each([
  ['missing snapshot', (forecast) => delete forecast.researchInputSnapshot],
  [
    'nonreplayable inputs',
    (forecast) => (forecast.researchInputSnapshot.timing.replayable = false),
  ],
  ['earlier capture', (forecast) => (forecast.capturedAt -= 1)],
  ['different production probability', (forecast) => (forecast.aboveProbability = 0.1)],
  [
    'research quote reused',
    (forecast) => (forecast.researchInputSnapshot.input.kalshiQuote.yesAsk = 0.92),
  ],
  ['missing exact quote', (forecast) => delete forecast.researchInputSnapshot.input.kalshiQuote],
  [
    'same price different book',
    (forecast) => (forecast.researchInputSnapshot.input.kalshiQuote.requestedAt -= 1),
  ],
  ['other contract', (forecast) => (forecast.researchInputSnapshot.input.kalshiMarket.target += 1)],
])('%s cannot be claimed as a same-book recomputation or valid blend experiment', (_, change) => {
  const forecast = clone(createAdvisorForecast(input(), {}, START));
  change(forecast);
  const result = getAdvisorForecastReconciliation({
    contract,
    originalForecast: { aboveProbability: 0.99, marketProbability: 0.9165 },
    currentForecast: forecast,
    book: executionBook(),
    now: NOW,
  });
  expect(result.recomputed).toBe(false);
  expect(result.marketBlend).toMatchObject({ available: false, aboveProbability: null });
  expect(result.gaps.currentForecastToExecutionBook).toBeNull();
  expect(result.executionBookProbability).toBe(0.625);
});

test('an absent execution quote stays absent even when the contract still carries research prices', () => {
  const values = input();
  values.kalshiMarket = { ...contract, yesBid: 0.913, yesAsk: 0.92, receivedAt: NOW };
  delete values.kalshiQuote;
  expect(createAdvisorForecast(values, {}, START).marketProbability).toBeCloseTo(0.9165);
  values.kalshiQuote = null;
  const missing = createAdvisorForecast(values, {}, START);
  expect(missing.available).toBe(true);
  expect(missing.marketProbability).toBeNull();
  expect(missing.marketBlend).toMatchObject({
    available: false,
    appliedMarket: false,
    aboveProbability: null,
    rawAboveProbability: null,
  });
});

test('a wide execution book records its midpoint while the existing blend policy abstains', () => {
  const book = executionBook();
  book.yesAsks[0].price = 0.8;
  const values = input();
  values.kalshiQuote = getAdvisorBookQuote({ contract, book, now: NOW });
  const forecast = createAdvisorForecast(values, {}, START);
  const result = getAdvisorForecastReconciliation({
    contract,
    originalForecast: forecast,
    currentForecast: forecast,
    book,
    now: NOW,
  });
  expect(result).toMatchObject({
    recomputed: true,
    executionBookProbability: 0.71,
    marketBlend: { available: false, aboveProbability: null, appliedMarket: false },
  });
  expect(result.marketBlend.reason).toMatch(/spread is too wide/);
});
