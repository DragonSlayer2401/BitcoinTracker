import {
  createKalshiMarketSpecification,
  hasSupportedKalshiOutcomeRules,
  parseKalshiUtcTimestamp,
} from '@/features/MarketData/utils/kalshi/marketSpecification.utils';

export const KALSHI_SERIES_TICKER = 'KXBTC15M';
export const KALSHI_OUTCOME_DEFINITION = 'kalshi-btc15m-brti-average-v1';
export const KALSHI_RULES_URL = 'https://assets.kalshi.com/contract_terms/CRYPTO.pdf';
const BENCHMARK_HISTORY_WINDOW_MS = 60 * 60_000;
const MARKET_TICKER = /^KXBTC15M-\d{2}[A-Z]{3}\d{6}-\d{2}$/;
const EVENT_TICKER = /^KXBTC15M-\d{2}[A-Z]{3}\d{6}$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;

export class KalshiDataError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'KalshiDataError';
    this.status = status;
  }
}

export function assertKalshiTicker(ticker, { event = false } = {}) {
  if (typeof ticker !== 'string' || !(event ? EVENT_TICKER : MARKET_TICKER).test(ticker)) {
    throw new KalshiDataError('Select a valid Kalshi 15-minute Bitcoin market.', 400);
  }
  return ticker;
}

const parseTime = parseKalshiUtcTimestamp;

function parseDecimal(value, { zero = false } = {}) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !DECIMAL.test(value))) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && (zero ? number >= 0 : number > 0) ? number : null;
}

function parseContractPrice(value) {
  const price = parseDecimal(value, { zero: true });
  return price !== null && price <= 1 ? price : null;
}

export const parseKalshiSeries = (payload) => {
  const series = payload?.series;
  if (
    series?.ticker !== KALSHI_SERIES_TICKER ||
    !Number.isSafeInteger(series.exchange_index) ||
    series.exchange_index < 0 ||
    series.exchange_index > 100
  )
    throw new KalshiDataError('Kalshi returned invalid Bitcoin series metadata.');
  return {
    exchangeIndex: series.exchange_index,
    specificationMetadata: {
      ticker: series.ticker,
      contractTermsUrl: series.contract_terms_url ?? null,
      certificationUrl: series.contract_url ?? null,
      frequency: series.frequency ?? null,
      settlementSources: Array.isArray(series.settlement_sources)
        ? series.settlement_sources.map((source) => ({ name: source?.name, url: source?.url }))
        : [],
      updatedAt: series.last_updated_ts ?? null,
      feeType: series.fee_type ?? null,
      feeMultiplier: series.fee_multiplier ?? null,
    },
    rulesVerified:
      series.contract_terms_url === KALSHI_RULES_URL &&
      series.frequency === 'fifteen_min' &&
      Array.isArray(series.settlement_sources) &&
      series.settlement_sources.some((source) => source?.name === 'CF Benchmarks'),
  };
};

// Match the supported contract template and the times in its actual rule text.
// close_time is the observation deadline; expiration_time can be a week later.
export const parseKalshiMarket = (payload, series, receivedAt = Date.now(), options = {}) => {
  const market = payload?.market ?? payload;
  assertKalshiTicker(market?.ticker);
  assertKalshiTicker(market?.event_ticker, { event: true });
  if (!market.ticker.startsWith(`${market.event_ticker}-`)) {
    throw new KalshiDataError('Kalshi returned mismatched market identifiers.');
  }
  const startsAt = parseTime(market.open_time);
  const expiresAt = parseTime(market.close_time);
  const target = parseDecimal(market.floor_strike);
  const primary = typeof market.rules_primary === 'string' ? market.rules_primary : '';
  const secondary = typeof market.rules_secondary === 'string' ? market.rules_secondary : '';
  const rulesVerified = hasSupportedKalshiOutcomeRules(market, series);
  const specification = createKalshiMarketSpecification({
    market,
    series,
    receivedAt,
    quantityRuleEvidence: options.quantityRuleEvidence,
    roundingRuleEvidence: options.roundingRuleEvidence,
  });
  const isFinal = ['finalized', 'settled'].includes(market.status);
  const result = isFinal && ['yes', 'no'].includes(market.result) ? market.result : null;
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    seriesTicker: KALSHI_SERIES_TICKER,
    exchangeIndex: market.exchange_index ?? series.exchangeIndex,
    title:
      typeof market.title === 'string' ? market.title.slice(0, 300) : 'Bitcoin 15-minute event',
    target,
    startsAt,
    expiresAt,
    comparison: rulesVerified ? 'greater_or_equal' : null,
    roundDigits: 2,
    rulesVerified,
    supported: rulesVerified,
    specification,
    unsupportedReason: rulesVerified
      ? null
      : 'The current contract rules differ from the supported BRTI 60-second average contract.',
    status: market.status,
    result,
    settlementPrice: result ? parseDecimal(market.expiration_value, { zero: true }) : null,
    settledAt: result ? parseTime(market.settlement_ts) : null,
    settlementExpectedAt: parseTime(market.expected_expiration_time),
    yesBid: parseContractPrice(market.yes_bid_dollars),
    yesAsk: parseContractPrice(market.yes_ask_dollars),
    noBid: parseContractPrice(market.no_bid_dollars),
    noAsk: parseContractPrice(market.no_ask_dollars),
    rulesPrimary: primary.slice(0, 4_000),
    rulesSecondary: secondary.slice(0, 4_000),
    rulesUrl: KALSHI_RULES_URL,
    url: `https://kalshi.com/markets/kxbtc15m/bitcoin-price-up-down/${market.event_ticker.toLowerCase()}`,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    receivedAt,
  };
};

// /cfbenchmarks/values supplies the last hour of raw RTI values. Keep that history
// for source-matched volatility instead of discarding all but the last 20 minutes.
// PER_SECOND excludes 200 ms ticks; duplicates must never count as extra seconds.
export function parseKalshiBenchmark(payload, receivedAt = Date.now()) {
  const rows = payload?.data?.payload;
  if (payload?.data?.error || !Array.isArray(rows) || rows.length > 5_000) {
    throw new KalshiDataError('CF Benchmarks returned invalid BRTI samples.');
  }
  const samplesByTime = new Map();
  for (const row of rows) {
    const price =
      typeof row?.value === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(row.value)
        ? Number(row.value)
        : NaN;
    if (
      !Number.isSafeInteger(row?.time) ||
      row.time <= 0 ||
      row.time % 1_000 !== 0 ||
      row.time > receivedAt + 1_000 ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new KalshiDataError('CF Benchmarks returned invalid BRTI samples.');
    }
    if (row.repeatOfPreviousValue === true || row.time > receivedAt) continue;
    if (
      row.amendTime != null &&
      (!Number.isSafeInteger(row.amendTime) || row.amendTime > receivedAt)
    ) {
      throw new KalshiDataError('CF Benchmarks returned invalid amendment metadata.');
    }
    if (row.time <= receivedAt - BENCHMARK_HISTORY_WINDOW_MS) continue;
    const previous = samplesByTime.get(row.time);
    if (previous && previous.price !== price) {
      throw new KalshiDataError('CF Benchmarks returned conflicting BRTI samples.');
    }
    samplesByTime.set(row.time, { time: row.time, price });
  }
  const samples = [...samplesByTime.values()].sort((first, second) => first.time - second.time);
  const current = samples.at(-1) ?? null;
  const isFresh = current !== null && receivedAt - current.time <= 5_000;
  return {
    status: isFresh ? 'live' : 'stale',
    available: isFresh,
    source: 'CF Benchmarks BRTI',
    current,
    samples,
    history: {
      windowMinutes: 60,
      sampleCount: samples.length,
      expectedSampleCount: 3_600,
      missingSampleCount: 3_600 - samples.length,
      coverage: samples.length / 3_600,
      firstSampleAt: samples[0]?.time ?? null,
      lastSampleAt: current?.time ?? null,
    },
    receivedAt,
    reason: isFresh ? null : 'The official BRTI feed has no fresh per-second values.',
  };
}
