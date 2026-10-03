import {
  getKalshiPurchaseValue,
  getPurchaseFeeEstimate,
} from '../utils/kalshi/purchaseValue.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const START = Date.UTC(2026, 8, 15, 12);
const NOW = START + 120_000;
const ticker = 'KXBTC15M-26SEP151215-15';
const contract = {
  ticker,
  eventTicker: 'KXBTC15M-26SEP151215',
  seriesTicker: 'KXBTC15M',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  rulesVerified: true,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  target: 75_000,
  startsAt: START,
  expiresAt: START + 900_000,
};
const fee = {
  available: true,
  type: 'quadratic',
  multiplier: 1,
  checkedAt: NOW,
  validUntil: NOW + 30_000,
};
const input = () => ({
  contract,
  now: NOW,
  contracts: 3,
  accountType: 'direct',
  aboveProbability: 0.7,
  book: {
    ticker,
    receivedAt: NOW,
    fee,
    yesAsks: [
      { price: 0.5, quantity: 1 },
      { price: 0.6, quantity: 2 },
    ],
    noAsks: [{ price: 0.55, quantity: 100 }],
  },
});

test('uses executable asks across levels, complement probability, and single-order cost', () => {
  const result = getKalshiPurchaseValue(input());
  expect(result.yes).toMatchObject({
    isFullyCovered: true,
    filledQuantity: 3,
    cost: 1.7,
    exchangeFee: 0.0511,
  });
  expect(result.yes.averageAsk).toBeCloseTo(1.7 / 3);
  expect(result.yes.grossExpectedValue).toBeCloseTo(0.4);
  expect(result.yes.netExpectedValue).toBeCloseTo(0.3489);
  expect(result.yes.breakEvenProbability).toBeCloseTo(1.7511 / 3);
  expect(result.no.probability).toBeCloseTo(0.3);
  expect(result.no.grossExpectedValue).toBeLessThan(0);
});

test('accumulates rounding across the order instead of charging rounded per-contract fees', () => {
  const fills = [{ price: 0.5, quantity: 100 }];
  expect(getPurchaseFeeEstimate(fills, fee, 'direct', NOW)).toBe(1.75);
  expect(getPurchaseFeeEstimate(fills, fee, 'intermediary', NOW)).toBe(1.75);
  expect(getPurchaseFeeEstimate([{ price: 0.055, quantity: 1 }], fee, 'intermediary', NOW)).toBe(
    0.005,
  );
  expect(getPurchaseFeeEstimate([{ price: 0.5, quantity: 1 }], fee, 'direct', NOW)).toBe(0.0175);
  expect(getPurchaseFeeEstimate([{ price: 0.5, quantity: 1 }], fee, 'intermediary', NOW)).toBe(
    0.02,
  );
});

test('withholds full-quantity value when displayed depth is insufficient', () => {
  const result = getKalshiPurchaseValue({ ...input(), contracts: 10 });
  expect(result.yes).toMatchObject({
    filledQuantity: 3,
    isFullyCovered: false,
    cost: 1.7,
    grossExpectedValue: null,
    netExpectedValue: null,
    breakEvenProbability: null,
  });
  expect(result.no.isFullyCovered).toBe(true);
});

test.each(['unknown', 'intermediary'])(
  'shows gross value but no unverified net value for %s accounts',
  (accountType) => {
    const result = getKalshiPurchaseValue({ ...input(), accountType });
    expect(result.yes.grossExpectedValue).toBeCloseTo(0.4);
    expect(result.yes.netExpectedValue).toBeNull();
    expect(result.feeReason).toBeTruthy();
  },
);

test.each([
  { available: false, reason: 'Missing fees' },
  { ...fee, type: 'unknown' },
  { ...fee, multiplier: NaN },
  { ...fee, checkedAt: NOW + 1 },
  { ...fee, checkedAt: NOW - 30_001 },
  { ...fee, validUntil: NOW },
])('does not invent net value for unusable fee metadata %p', (invalidFee) => {
  const values = input();
  values.book.fee = invalidFee;
  const result = getKalshiPurchaseValue(values);
  expect(result.yes.netExpectedValue).toBeNull();
  expect(result.yes.grossExpectedValue).toBeCloseTo(0.4);
});

test.each([0, -1, 0.5, 10_001, NaN, '3'])(
  'rejects invalid requested contract quantity %p',
  (contracts) => {
    expect(getKalshiPurchaseValue({ ...input(), contracts }).available).toBe(false);
  },
);

test.each([
  { receivedAt: NOW - 15_001 },
  { receivedAt: NOW + 1001 },
  { ticker: 'KXBTC15M-OTHER' },
  {
    yesAsks: [
      { price: 0.6, quantity: 1 },
      { price: 0.5, quantity: 2 },
    ],
  },
  { noAsks: [{ price: 0.5, quantity: -1 }] },
])('rejects stale, mismatched, or malformed depth %p', (patch) => {
  const values = input();
  values.book = { ...values.book, ...patch };
  expect(getKalshiPurchaseValue(values).available).toBe(false);
});

test('does not compare a closed contract or an unavailable live prediction', () => {
  expect(getKalshiPurchaseValue({ ...input(), now: contract.expiresAt }).available).toBe(false);
  expect(getKalshiPurchaseValue({ ...input(), aboveProbability: null }).available).toBe(false);
});
