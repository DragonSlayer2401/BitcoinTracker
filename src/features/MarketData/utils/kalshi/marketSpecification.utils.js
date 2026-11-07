import {
  formatDecimalUnits,
  isValidPriceGrid,
  parseDecimalUnits,
  roundRationalUnits,
} from '@/utils/fixedPoint.utils';

const termsUrl = 'https://assets.kalshi.com/contract_terms/CRYPTO.pdf';
const apiBaseUrl = 'https://external-api.kalshi.com/trade-api/v2';
const primaryRule =
  /^If the simple average of the sixty seconds of CF Benchmarks' BRTI before (.+) is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before (.+), then the market resolves to Yes\.$/;
const secondaryRule =
  "Not all cryptocurrency price data is the same. While checking a source like Google or Coinbase may help guide your decision, the price used to determine this market is based on CF Benchmarks' corresponding Real Time Index (RTI). At the last minute before expiration, 60 RTI prices are collected. The official and final value is the average of these prices, rounded to the nearest 2 decimal places.";
const isTimestamp = (value) =>
  Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());

/** UTC wire times may carry more precision than our explicitly millisecond timestamps. */
export const parseKalshiUtcTimestamp = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    return null;
  const timestamp = Date.parse(value);
  return isTimestamp(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
    ? timestamp
    : null;
};

const ruleTimeMatches = (value, timestamp) => {
  if (!isTimestamp(timestamp)) return false;
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
};

/** Legacy forecast support and new trading readiness are deliberately separate. */
export const hasSupportedKalshiOutcomeRules = (market, series) => {
  const startsAt = parseKalshiUtcTimestamp(market?.open_time);
  const closesAt = parseKalshiUtcTimestamp(market?.close_time);
  const target = parseDecimalUnits(String(market?.floor_strike), 2);
  const isAwaitingStrike = ['initialized', 'unopened'].includes(market?.status) && target === null;
  const match = typeof market?.rules_primary === 'string' && primaryRule.exec(market.rules_primary);
  return Boolean(
    series?.rulesVerified === true &&
    market?.market_type === 'binary' &&
    (market.strike_type === 'greater_or_equal' || (isAwaitingStrike && !market.strike_type)) &&
    (String(market.custom_strike?.round_digits) === '2' ||
      (isAwaitingStrike && market.custom_strike == null)) &&
    startsAt &&
    closesAt &&
    closesAt - startsAt === 900_000 &&
    startsAt % 900_000 === 0 &&
    match &&
    ruleTimeMatches(match[1], closesAt) &&
    ruleTimeMatches(match[2], startsAt) &&
    market.rules_secondary === secondaryRule &&
    Number.isSafeInteger(market.exchange_index) &&
    market.exchange_index >= 0,
  );
};

/** Persisted normalized contracts must still agree with their captured source rule text. */
export const hasSupportedKalshiSpecificationRuleText = (specification) => {
  const primary = specification?.ruleText?.primary;
  const match = typeof primary === 'string' && primaryRule.exec(primary);
  return Boolean(
    match &&
    ruleTimeMatches(match[1], specification?.timestamps?.closesAt) &&
    ruleTimeMatches(match[2], specification?.timestamps?.opensAt) &&
    specification?.ruleText?.secondary === secondaryRule,
  );
};

const matchesTermsExpirationTime = (timestamp) => {
  if (!isTimestamp(timestamp)) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(timestamp)
      .map(({ type, value }) => [type, value]),
  );
  return parts.hour === '10' && parts.minute === '00' && parts.second === '00';
};

/** The linked terms' administrative expiry must not silently lose to conflicting metadata. */
export const hasSupportedKalshiSpecificationTimestamps = (specification) =>
  specification?.expirationRule?.timeZone === 'America/New_York' &&
  specification.expirationRule.localTime === '10:00:00' &&
  specification.expirationRule.sourceUrl === termsUrl &&
  matchesTermsExpirationTime(specification?.timestamps?.expirationAt);

const readPriceGrid = (ranges) => {
  if (!Array.isArray(ranges)) return null;
  const grid = ranges.map((range) => ({
    start: parseDecimalUnits(range?.start, 4)?.toString() ?? null,
    end: parseDecimalUnits(range?.end, 4)?.toString() ?? null,
    step: parseDecimalUnits(range?.step, 4)?.toString() ?? null,
  }));
  return isValidPriceGrid(grid) ? grid : null;
};

const isReviewedSourceUrl = (source) => {
  try {
    const url = new URL(source.url);
    return (
      url.protocol === 'https:' &&
      (source.kind === 'synthetic' ||
        url.hostname === 'kalshi.com' ||
        url.hostname.endsWith('.kalshi.com'))
    );
  } catch {
    return false;
  }
};

const isReviewedRuleSource = (source, receivedAt) =>
  ['official', 'synthetic'].includes(source?.kind) &&
  ['kalshi', 'synthetic-fixture'].includes(source?.id) &&
  (source.kind === 'official') === (source.id === 'kalshi') &&
  typeof source.url === 'string' &&
  isReviewedSourceUrl(source) &&
  isTimestamp(source.retrievedAt) &&
  isTimestamp(receivedAt) &&
  source.retrievedAt <= receivedAt &&
  typeof source.documentVersion === 'string' &&
  source.documentVersion.length > 0;

/** Explicit reviewed evidence is separate from the API payload; no undocumented flag is inferred. */
const readQuantityRules = (evidence, ticker, receivedAt) => {
  const source = evidence?.source;
  const minimum = parseDecimalUnits(evidence?.minimum, 2);
  const step = parseDecimalUnits(evidence?.step, 2);
  const maximum = evidence?.maximum === undefined ? null : parseDecimalUnits(evidence.maximum, 2);
  if (
    evidence?.version !== 'kalshi-quantity-rule-evidence-v1' ||
    evidence.marketTicker !== ticker ||
    !isReviewedRuleSource(source, receivedAt) ||
    minimum === null ||
    minimum <= 0n ||
    step === null ||
    step <= 0n ||
    minimum % step !== 0n ||
    (evidence.maximum !== undefined && (maximum === null || maximum < minimum))
  )
    return null;
  return {
    minimum: minimum.toString(),
    step: step.toString(),
    ...(maximum === null ? {} : { maximum: maximum.toString() }),
    source: { ...source },
  };
};

const readRoundingRule = (evidence, ticker, receivedAt) =>
  evidence?.version === 'kalshi-rounding-rule-evidence-v1' &&
  evidence.marketTicker === ticker &&
  ['half-up', 'half-even'].includes(evidence.halfway) &&
  isReviewedRuleSource(evidence.source, receivedAt)
    ? { halfway: evidence.halfway, source: { ...evidence.source } }
    : { halfway: 'unspecified', source: null };

const createAverageWindow = (endAt) =>
  isTimestamp(endAt)
    ? {
        startAt: endAt - 60_000,
        endAt,
        startInclusive: false,
        endInclusive: true,
        sampleCount: 60,
        sampleIntervalMs: 1000,
      }
    : null;

/** A versioned, serializable market contract, not a strategy or an exchange-result inference. */
export const createKalshiMarketSpecification = ({
  market,
  series,
  receivedAt,
  quantityRuleEvidence = null,
  roundingRuleEvidence = null,
}) => {
  const metadata = series?.specificationMetadata;
  const conflicts = [];
  const missing = [];
  const outcomeRulesVerified = hasSupportedKalshiOutcomeRules(market, series);
  const timestamps = {
    opensAt: parseKalshiUtcTimestamp(market?.open_time),
    closesAt: parseKalshiUtcTimestamp(market?.close_time),
    expectedExpirationAt: parseKalshiUtcTimestamp(market?.expected_expiration_time),
    expirationAt: parseKalshiUtcTimestamp(market?.expiration_time),
    latestExpirationAt: parseKalshiUtcTimestamp(market?.latest_expiration_time),
    settledAt: parseKalshiUtcTimestamp(market?.settlement_ts),
  };
  const targetUnits = parseDecimalUnits(String(market?.floor_strike), 2);
  const priceGrid = readPriceGrid(market?.price_ranges);
  const quantityRules = readQuantityRules(quantityRuleEvidence, market?.ticker, receivedAt);
  const roundingRule = readRoundingRule(roundingRuleEvidence, market?.ticker, receivedAt);
  if (!isTimestamp(receivedAt)) missing.push('invalid_metadata_receipt_time');
  if (!outcomeRulesVerified) conflicts.push('unsupported_or_conflicting_outcome_rules');
  if (
    metadata?.ticker !== 'KXBTC15M' ||
    metadata?.contractTermsUrl !== termsUrl ||
    metadata?.frequency !== 'fifteen_min' ||
    !metadata?.settlementSources?.some((source) => source.name === 'CF Benchmarks')
  )
    missing.push('unverified_series_metadata');
  if (market?.exchange_index !== series?.exchangeIndex)
    conflicts.push('conflicting_exchange_index');
  if (
    typeof market?.ticker !== 'string' ||
    typeof market?.event_ticker !== 'string' ||
    !market.ticker.startsWith(`${market.event_ticker}-`) ||
    !/^KXBTC15M-\d{2}[A-Z]{3}\d{6}-\d{2}$/.test(market.ticker) ||
    !/^KXBTC15M-\d{2}[A-Z]{3}\d{6}$/.test(market.event_ticker)
  )
    conflicts.push('conflicting_market_identity');
  if (targetUnits === null || targetUnits <= 0n) missing.push('missing_or_invalid_opening_target');
  if (!priceGrid) missing.push('missing_or_invalid_price_grid');
  if (!quantityRules) missing.push('unverified_quantity_rules');
  if (roundingRule.halfway === 'unspecified') missing.push('unverified_halfway_rounding');
  if (parseDecimalUnits(market?.notional_value_dollars, 4) !== 10_000n)
    conflicts.push('unsupported_contract_payout');
  if (typeof market?.can_close_early !== 'boolean') missing.push('missing_early_close_metadata');
  if (
    !Number.isSafeInteger(market?.settlement_timer_seconds) ||
    market.settlement_timer_seconds < 0
  )
    missing.push('missing_or_invalid_settlement_timer');
  for (const field of [
    'opensAt',
    'closesAt',
    'expectedExpirationAt',
    'expirationAt',
    'latestExpirationAt',
  ]) {
    if (!isTimestamp(timestamps[field])) missing.push(`missing_or_invalid_${field}`);
  }
  if (
    (timestamps.expectedExpirationAt !== null &&
      timestamps.expectedExpirationAt < timestamps.closesAt) ||
    (timestamps.expirationAt !== null && timestamps.expirationAt < timestamps.closesAt) ||
    (timestamps.latestExpirationAt !== null &&
      timestamps.latestExpirationAt < timestamps.expirationAt) ||
    (timestamps.settledAt !== null && timestamps.settledAt < timestamps.closesAt)
  )
    conflicts.push('conflicting_market_timestamps');
  if (timestamps.expirationAt !== null && !matchesTermsExpirationTime(timestamps.expirationAt))
    conflicts.push('contract_expiration_schedule_conflict');
  const reasons = [...conflicts, ...missing];
  const source = (id, url, documentVersion) => ({
    id,
    kind: 'official',
    url,
    retrievedAt: receivedAt,
    documentVersion,
  });
  const reviewedSource = (id, url, documentVersion) => ({
    id,
    kind: 'official',
    url,
    retrievedOn: '2026-11-06',
    retrievalTimeZone: 'America/Chicago',
    documentVersion,
  });
  return {
    version: 'kalshi-market-spec-v1',
    marketTicker: market?.ticker ?? null,
    eventTicker: market?.event_ticker ?? null,
    seriesTicker: 'KXBTC15M',
    currency: 'USD',
    timestampUnit: 'unix-ms',
    priceScale: 4,
    quantityScale: 2,
    moneyScale: 6,
    target: targetUnits === null ? null : { value: formatDecimalUnits(targetUnits, 2), scale: 2 },
    referenceSource: {
      id: 'cf-brti',
      kind: 'official',
      index: 'BRTI',
      agency: 'CF Benchmarks',
      unit: 'USD/BTC',
    },
    referenceWindow: createAverageWindow(timestamps.opensAt),
    closingWindow: createAverageWindow(timestamps.closesAt),
    comparison: 'greater_or_equal',
    tieResult: 'YES',
    rounding: { decimalPlaces: 2, mode: 'nearest', ...roundingRule },
    timestamps,
    expirationRule: {
      timeZone: 'America/New_York',
      localTime: '10:00:00',
      sourceUrl: termsUrl,
      settlementDeadline: 'day_after_expiration_except_exchange_review',
    },
    canCloseEarly: market?.can_close_early ?? null,
    settlementTimerSeconds: Number.isSafeInteger(market?.settlement_timer_seconds)
      ? market.settlement_timer_seconds
      : null,
    priceGrid,
    priceLevelStructure:
      typeof market?.price_level_structure === 'string' ? market.price_level_structure : null,
    quantityRules,
    payoutUnits: '1000000',
    contingency: {
      localMissingObservation: 'unknown_not_source_outage',
      sourceAgencyDataUnavailable: 'contract_no_subject_to_exchange_review',
      postExpirationRevisions: 'excluded_by_contract_terms',
      outcomeReview: 'exchange_may_review_before_settlement',
      indeterminateExpirationValue: 'exchange_determines_payout_under_rule_6_3_b',
      settlementAuthority: 'official_finalized_kalshi_result',
    },
    outcomeRulesVerified,
    verification: {
      status: conflicts.length ? 'conflicting' : missing.length ? 'incomplete' : 'verified',
      reasons,
    },
    actionable: reasons.length === 0,
    sources: [
      source('kalshi-series', `${apiBaseUrl}/series/KXBTC15M`, metadata?.updatedAt ?? null),
      source(
        'kalshi-market',
        `${apiBaseUrl}/markets/${market?.ticker ?? ''}`,
        market?.updated_time ?? null,
      ),
      reviewedSource('kalshi-contract-terms', termsUrl, 'CRYPTO; no printed revision'),
      reviewedSource(
        'kalshi-api',
        'https://docs.kalshi.com/api-reference/market/get-market',
        'Trade API v2',
      ),
      reviewedSource(
        'kalshi-precision',
        'https://docs.kalshi.com/getting_started/fixed_point_migration',
        '2026-11-05',
      ),
      reviewedSource(
        'kalshi-benchmark-window',
        'https://docs.kalshi.com/websockets/cfbenchmarks-value',
        'unversioned quarter-hour averaging semantics',
      ),
      reviewedSource(
        'kalshi-fees',
        'https://kalshi.com/docs/kalshi-fee-schedule.pdf',
        'effective 2026-07-07',
      ),
      reviewedSource(
        'kalshi-fee-rounding',
        'https://docs.kalshi.com/getting_started/fee_rounding',
        'unversioned',
      ),
    ],
    ruleText: {
      primary: market?.rules_primary ?? null,
      secondary: market?.rules_secondary ?? null,
    },
    receivedAt,
  };
};

/** Local arithmetic is diagnostic only: neither missing readings nor this result settles an account. */
export const evaluateKalshiSettlementSamples = ({
  specification,
  observations,
  sourceAgencyStatus = 'unknown',
}) => {
  const unavailable = (reason, extra = {}) => ({
    status: 'awaiting_official_result',
    reason,
    localResult: null,
    officialResult: null,
    ...extra,
  });
  if (
    specification?.version !== 'kalshi-market-spec-v1' ||
    specification.currency !== 'USD' ||
    specification.timestampUnit !== 'unix-ms' ||
    specification.outcomeRulesVerified !== true ||
    !specification.closingWindow ||
    specification.comparison !== 'greater_or_equal' ||
    specification.tieResult !== 'YES' ||
    specification.referenceSource?.id !== 'cf-brti' ||
    specification.referenceSource?.kind !== 'official' ||
    specification.referenceSource?.index !== 'BRTI' ||
    specification.referenceSource?.agency !== 'CF Benchmarks' ||
    specification.referenceSource?.unit !== 'USD/BTC' ||
    specification.target?.scale !== 2 ||
    !hasSupportedKalshiSpecificationRuleText(specification) ||
    specification.rounding?.mode !== 'nearest' ||
    specification.rounding?.decimalPlaces !== 2 ||
    !['unspecified', 'half-up', 'half-even'].includes(specification.rounding?.halfway) ||
    (specification.rounding.halfway !== 'unspecified' &&
      !isReviewedRuleSource(specification.rounding.source, specification.receivedAt)) ||
    !Array.isArray(observations) ||
    observations.length > 5000 ||
    !['unknown', 'confirmed_available', 'confirmed_outage'].includes(sourceAgencyStatus)
  )
    return unavailable('unverified_settlement_rules');
  const window = specification.closingWindow;
  const referenceWindow = specification.referenceWindow;
  if (
    !isTimestamp(window.startAt) ||
    !isTimestamp(window.endAt) ||
    window.endAt - window.startAt !== 60_000 ||
    window.startInclusive !== false ||
    window.endInclusive !== true ||
    window.sampleCount !== 60 ||
    window.sampleIntervalMs !== 1000 ||
    window.endAt !== specification.timestamps?.closesAt ||
    !isTimestamp(referenceWindow?.startAt) ||
    !isTimestamp(referenceWindow?.endAt) ||
    referenceWindow.endAt - referenceWindow.startAt !== 60_000 ||
    referenceWindow.startInclusive !== false ||
    referenceWindow.endInclusive !== true ||
    referenceWindow.sampleCount !== 60 ||
    referenceWindow.sampleIntervalMs !== 1000 ||
    referenceWindow.endAt !== specification.timestamps?.opensAt ||
    window.endAt - referenceWindow.endAt !== 900_000
  )
    return unavailable('unverified_settlement_window');
  if (sourceAgencyStatus === 'confirmed_outage')
    return unavailable('source_agency_outage_subject_to_contract_and_exchange_review');
  const selected = observations.filter(
    (observation) =>
      observation?.observedAt > window.startAt && observation.observedAt <= window.endAt,
  );
  const byTime = new Map();
  for (const observation of selected) {
    if (
      observation?.source?.id !== 'cf-brti' ||
      observation.source.kind !== 'official' ||
      !isTimestamp(observation.observedAt) ||
      observation.observedAt % 1000 !== 0 ||
      !isTimestamp(observation.receivedAt) ||
      observation.receivedAt < observation.observedAt ||
      typeof observation.value !== 'string' ||
      parseDecimalUnits(observation.value, 18) === null ||
      parseDecimalUnits(observation.value, 18) <= 0n
    )
      return unavailable('invalid_local_observation');
    const existing = byTime.get(observation.observedAt);
    if (
      existing !== undefined &&
      parseDecimalUnits(existing, 18) !== parseDecimalUnits(observation.value, 18)
    )
      return unavailable('conflicting_local_observations');
    byTime.set(observation.observedAt, observation.value);
  }
  const times = Array.from({ length: 60 }, (_, index) => window.startAt + (index + 1) * 1000);
  const missingSampleCount = times.filter((timestamp) => !byTime.has(timestamp)).length;
  if (missingSampleCount)
    return unavailable('locally_missing_observations', { missingSampleCount });
  const total = times.reduce(
    (sum, timestamp) => sum + parseDecimalUnits(byTime.get(timestamp), 18),
    0n,
  );
  const divisor = 60n * 10n ** 16n;
  const isHalfway = (total % divisor) * 2n === divisor;
  if (isHalfway && specification.rounding?.halfway === 'unspecified')
    return unavailable('undocumented_halfway_rounding');
  // Away from an exact midpoint, both supported nearest-rounding conventions agree.
  const rounded = roundRationalUnits(
    total,
    divisor,
    specification.rounding.halfway === 'unspecified' ? 'half-up' : specification.rounding.halfway,
  );
  const target = parseDecimalUnits(specification.target?.value, 2);
  if (rounded === null || target === null || target <= 0n)
    return unavailable('invalid_settlement_target');
  return {
    status: 'local_comparison_only',
    localResult: rounded >= target ? 'YES' : 'NO',
    officialResult: null,
    roundedAverage: formatDecimalUnits(rounded, 2),
    observedSampleCount: 60,
    sourceAgencyStatus,
  };
};
