import { parseKalshiMarket, parseKalshiSeries } from '@/services/kalshi/kalshi.validation';

export const marketStart = Date.UTC(2026, 10, 6, 23, 45);
export const marketNow = marketStart + 6 * 60_000;

const ruleTime = (time) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
      .formatToParts(time)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName} on ${parts.month} ${parts.day}, ${parts.year}`;
};

// Synthetic metadata using the documented response shape. Values are not historical evidence.
export const createMarketMetadata = ({ startsAt = marketStart, ...overrides } = {}) => {
  const closesAt = startsAt + 900_000;
  const expiration = new Date(closesAt + 86_400_000);
  const offsetLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(expiration)
    .find((part) => part.type === 'timeZoneName').value;
  const easternOffset = Number(offsetLabel.replace('GMT', ''));
  // A deliberately compliant administrative expiry isolates the tests of verified
  // rules. The actual audited market's conflicting expiry is tested separately.
  expiration.setUTCHours(10 - easternOffset, 0, 0, 0);
  return {
    ticker: 'KXBTC15M-26NOV061900-00',
    event_ticker: 'KXBTC15M-26NOV061900',
    market_type: 'binary',
    exchange_index: 2,
    status: 'active',
    created_time: new Date(startsAt - 900_000).toISOString(),
    updated_time: new Date(startsAt).toISOString(),
    open_time: new Date(startsAt).toISOString(),
    close_time: new Date(closesAt).toISOString(),
    expected_expiration_time: new Date(closesAt + 300_000).toISOString(),
    expiration_time: expiration.toISOString(),
    latest_expiration_time: expiration.toISOString(),
    settlement_timer_seconds: 1,
    can_close_early: true,
    floor_strike: 50000,
    strike_type: 'greater_or_equal',
    custom_strike: { round_digits: '2' },
    notional_value_dollars: '1.0000',
    rules_primary: `If the simple average of the sixty seconds of CF Benchmarks' BRTI before ${ruleTime(closesAt)} is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before ${ruleTime(startsAt)}, then the market resolves to Yes.`,
    rules_secondary:
      "Not all cryptocurrency price data is the same. While checking a source like Google or Coinbase may help guide your decision, the price used to determine this market is based on CF Benchmarks' corresponding Real Time Index (RTI). At the last minute before expiration, 60 RTI prices are collected. The official and final value is the average of these prices, rounded to the nearest 2 decimal places.",
    price_level_structure: 'tapered_deci_cent',
    price_ranges: [
      { start: '0.0000', end: '0.1000', step: '0.0010' },
      { start: '0.1000', end: '0.9000', step: '0.0100' },
      { start: '0.9000', end: '1.0000', step: '0.0010' },
    ],
    ...overrides,
  };
};

export const createSeriesMetadata = () => ({
  series: {
    ticker: 'KXBTC15M',
    exchange_index: 2,
    frequency: 'fifteen_min',
    contract_terms_url: 'https://assets.kalshi.com/contract_terms/CRYPTO.pdf',
    settlement_sources: [{ name: 'CF Benchmarks', url: 'https://www.cfbenchmarks.com/' }],
    last_updated_ts: new Date(marketStart - 86_400_000).toISOString(),
    fee_type: 'quadratic',
    fee_multiplier: 1,
  },
});

// Explicit synthetic rule evidence is separate from API fields. The live API did not
// provide these quantity rules; tests must never imply that it did.
export const createQuantityRuleEvidence = (market, now, overrides = {}) => ({
  version: 'kalshi-quantity-rule-evidence-v1',
  marketTicker: market.ticker,
  minimum: '0.01',
  step: '0.01',
  maximum: '10000.00',
  source: {
    id: 'synthetic-fixture',
    kind: 'synthetic',
    url: 'https://example.invalid/synthetic-quantity-rules',
    retrievedAt: now,
    documentVersion: 'synthetic-test-v1',
  },
  ...overrides,
});

// The official nearest-cent wording does not specify exact midpoint behavior.
// These explicit synthetic assumptions support positive offline workflows only.
export const createRoundingRuleEvidence = (market, now, overrides = {}) => ({
  version: 'kalshi-rounding-rule-evidence-v1',
  marketTicker: market.ticker,
  halfway: 'half-up',
  source: {
    id: 'synthetic-fixture',
    kind: 'synthetic',
    url: 'https://example.invalid/synthetic-rounding-rules',
    retrievedAt: now,
    documentVersion: 'synthetic-test-v1',
  },
  ...overrides,
});

export const createSpecifiedMarket = ({
  raw = createMarketMetadata(),
  now = Date.parse(raw.open_time) + 360_000,
  quantityRuleEvidence = createQuantityRuleEvidence(raw, now),
  roundingRuleEvidence = createRoundingRuleEvidence(raw, now),
} = {}) =>
  parseKalshiMarket(raw, parseKalshiSeries(createSeriesMetadata()), now, {
    quantityRuleEvidence,
    roundingRuleEvidence,
  });

export const createTradingInputs = (contract = createSpecifiedMarket()) => {
  const now = contract.startsAt + 360_000;
  return {
    contract,
    now,
    forecast: {
      available: true,
      aboveProbability: 0.9,
      capturedAt: now,
      modelVersion: 'synthetic-independent-model-v1',
      contract,
    },
    book: {
      ticker: contract.ticker,
      receivedAt: now,
      requestedAt: now,
      yesAsks: [{ price: 0.4, quantity: 20 }],
      noAsks: [{ price: 0.65, quantity: 20 }],
      fee: {
        available: true,
        type: 'quadratic',
        multiplier: 1,
        checkedAt: now,
        validUntil: now + 30_000,
      },
    },
    portfolio: { cash: 100, openRisk: 0, dailyRealizedPnl: 0, positions: [] },
  };
};
