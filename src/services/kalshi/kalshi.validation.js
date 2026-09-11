export const KALSHI_SERIES_TICKER = 'KXBTC15M';
export const KALSHI_OUTCOME_DEFINITION = 'kalshi-btc15m-brti-average-v1';
export const KALSHI_RULES_URL = 'https://assets.kalshi.com/contract_terms/CRYPTO.pdf';
const BENCHMARK_HISTORY_WINDOW_MS = 60 * 60_000;
const MARKET_TICKER = /^KXBTC15M-\d{2}[A-Z]{3}\d{6}-\d{2}$/;
const EVENT_TICKER = /^KXBTC15M-\d{2}[A-Z]{3}\d{6}$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const PRIMARY_RULE =
  /^If the simple average of the sixty seconds of CF Benchmarks' BRTI before (.+) is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before (.+), then the market resolves to Yes\.$/;
const SECONDARY_RULE =
  "Not all cryptocurrency price data is the same. While checking a source like Google or Coinbase may help guide your decision, the price used to determine this market is based on CF Benchmarks' corresponding Real Time Index (RTI). At the last minute before expiration, 60 RTI prices are collected. The official and final value is the average of these prices, rounded to the nearest 2 decimal places.";

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

function parseTime(value) {
  const time = typeof value === 'string' && /Z$/.test(value) ? Date.parse(value) : NaN;
  return Number.isSafeInteger(time) && time > 0 ? time : null;
}

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

function ruleTimeMatches(value, timestamp) {
  if (!timestamp) return false;
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
      .formatToParts(timestamp)
      .map(({ type, value: part }) => [type, part]),
  );
  const longMonth = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
  }).format(timestamp);
  return [parts.month, longMonth].some(
    (month) =>
      value ===
      `${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName} on ${month} ${parts.day}, ${parts.year}`,
  );
}

export function parseKalshiSeries(payload) {
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
    rulesVerified:
      series.contract_terms_url === KALSHI_RULES_URL &&
      series.frequency === 'fifteen_min' &&
      series.settlement_sources?.some((source) => source.name === 'CF Benchmarks'),
  };
}

// Match the supported contract template and the times in its actual rule text.
// close_time is the observation deadline; expiration_time can be a week later.
export function parseKalshiMarket(payload, series, receivedAt = Date.now()) {
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
  const ruleMatch = PRIMARY_RULE.exec(primary);
  // Future events publish the full rule text before the opening target and its
  // machine-readable strike fields exist. The exact text already specifies both.
  const isAwaitingStrike = ['initialized', 'unopened'].includes(market.status) && target === null;
  const hasMatchingComparison =
    market.strike_type === 'greater_or_equal' || (isAwaitingStrike && !market.strike_type);
  const hasMatchingRounding =
    String(market.custom_strike?.round_digits) === '2' ||
    (isAwaitingStrike && market.custom_strike == null);
  const rulesVerified = Boolean(
    series.rulesVerified &&
    market.market_type === 'binary' &&
    hasMatchingComparison &&
    hasMatchingRounding &&
    startsAt &&
    expiresAt &&
    expiresAt - startsAt === 900_000 &&
    startsAt % 900_000 === 0 &&
    ruleMatch &&
    ruleTimeMatches(ruleMatch[1], expiresAt) &&
    ruleTimeMatches(ruleMatch[2], startsAt) &&
    secondary === SECONDARY_RULE &&
    Number.isSafeInteger(market.exchange_index) &&
    market.exchange_index >= 0,
  );
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
}

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
