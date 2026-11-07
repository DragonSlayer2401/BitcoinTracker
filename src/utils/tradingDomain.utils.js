import {
  isOnPriceGrid,
  isValidPriceGrid,
  parseDecimalUnits,
  parseIntegerUnits,
} from './fixedPoint.utils';
import {
  hasSupportedKalshiSpecificationRuleText,
  hasSupportedKalshiSpecificationTimestamps,
} from '@/features/MarketData/utils/kalshi/marketSpecification.utils';

/** @typedef {import('./tradingDomain.types').MarketSpecification} MarketSpecification */

export const tradingDomainVersions = Object.freeze({
  marketSpecification: 'kalshi-market-spec-v1',
  observation: 'timestamped-observation-v1',
  forecast: 'outcome-forecast-v1',
  quote: 'market-quote-v1',
  order: 'trading-order-v1',
  fill: 'trading-fill-v1',
  position: 'trading-position-v1',
  decision: 'trading-decision-v1',
});

export const tradingDomainUnits = Object.freeze({
  currency: 'USD',
  timestampUnit: 'unix-ms',
  priceScale: 4,
  quantityScale: 2,
  moneyScale: 6,
});

export const tradingDomainSources = Object.freeze({
  kalshi: 'official',
  'cf-brti': 'official',
  'coinbase-btc-usd': 'proxy',
  'bybit-btcusdt': 'proxy',
  'forecast-model': 'model',
  'paper-simulator': 'paper',
  'kalshi-demo': 'demo',
  'synthetic-fixture': 'synthetic',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 500;
const isTime = (value) =>
  Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const isUnits = (value, { positive = false } = {}) => {
  const units = typeof value === 'string' ? parseIntegerUnits(value) : null;
  return units !== null && (positive ? units > 0n : units >= 0n);
};
const hasUnits = (value) =>
  Object.entries(tradingDomainUnits).every(([name, expected]) => value?.[name] === expected);
const isSide = (value) => ['YES', 'NO'].includes(value);
const isSource = (source) =>
  isObject(source) &&
  Object.hasOwn(tradingDomainSources, source.id) &&
  tradingDomainSources[source.id] === source.kind;
const isSourceEvidence = (source) =>
  isObject(source) &&
  isText(source.url) &&
  /^(?:https:\/\/|fixture:\/\/)/.test(source.url) &&
  isTime(source.retrievedAt);

const hasOfficialRuleUrl = (source) =>
  source?.kind === 'synthetic' ||
  /^https:\/\/(?:[a-z0-9-]+\.)*kalshi\.com(?:\/|$)/i.test(source?.url ?? '');

const isJsonValue = (value, parents = new Set(), depth = 0) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 12 || parents.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return false;
  parents.add(value);
  const valid = Object.values(value).every((item) => isJsonValue(item, parents, depth + 1));
  parents.delete(value);
  return valid;
};

const isRuleSource = (source) =>
  isObject(source) &&
  isText(source.id) &&
  ['official', 'synthetic'].includes(source.kind) &&
  isText(source.url) &&
  /^(?:https:\/\/|fixture:\/\/)/.test(source.url) &&
  hasOfficialRuleUrl(source) &&
  (isTime(source.retrievedAt) || /^\d{4}-\d{2}-\d{2}$/.test(source.retrievedOn ?? '')) &&
  (source.documentVersion === null || isText(source.documentVersion));

const isReviewedRuleSource = (source, receivedAt) =>
  isSourceEvidence(source) &&
  source.url.startsWith('https://') &&
  hasOfficialRuleUrl(source) &&
  isText(source.documentVersion) &&
  isTime(receivedAt) &&
  source.retrievedAt <= receivedAt &&
  ((source.id === 'kalshi' && source.kind === 'official') ||
    (source.id === 'synthetic-fixture' && source.kind === 'synthetic'));

const hasQuantityRules = (rules, receivedAt) =>
  isObject(rules) &&
  isUnits(rules.minimum, { positive: true }) &&
  isUnits(rules.step, { positive: true }) &&
  BigInt(rules.minimum) % BigInt(rules.step) === 0n &&
  (rules.maximum == null ||
    (isUnits(rules.maximum, { positive: true }) &&
      BigInt(rules.maximum) >= BigInt(rules.minimum))) &&
  isReviewedRuleSource(rules.source, receivedAt);

const isReferenceWindow = (window) =>
  isObject(window) &&
  isTime(window.startAt) &&
  isTime(window.endAt) &&
  window.endAt - window.startAt === 60_000 &&
  window.startInclusive === false &&
  window.endInclusive === true &&
  window.sampleCount === 60 &&
  window.sampleIntervalMs === 1000;

const getMarketSpecificationErrors = (specification) => {
  const errors = [];
  if (specification?.version !== tradingDomainVersions.marketSpecification)
    errors.push('unsupported_specification_version');
  if (!hasUnits(specification)) errors.push('invalid_units');
  if (
    !isText(specification?.marketTicker) ||
    !isText(specification?.eventTicker) ||
    specification.seriesTicker !== 'KXBTC15M' ||
    !specification.marketTicker?.startsWith(`${specification.eventTicker}-`)
  )
    errors.push('invalid_market_identity');
  if (
    !['verified', 'incomplete', 'conflicting'].includes(specification?.verification?.status) ||
    !Array.isArray(specification?.verification?.reasons) ||
    !specification.verification.reasons.every(isText) ||
    typeof specification?.actionable !== 'boolean'
  )
    errors.push('invalid_verification');
  if (
    !Array.isArray(specification?.sources) ||
    specification.sources.length === 0 ||
    !specification.sources.every(isRuleSource)
  )
    errors.push('missing_rule_sources');
  if (!isObject(specification?.timestamps)) errors.push('missing_timestamps');
  if (specification?.actionable) {
    const timestamps = specification.timestamps;
    if (
      specification.verification?.status !== 'verified' ||
      specification.verification?.reasons?.length !== 0 ||
      specification.outcomeRulesVerified !== true ||
      !hasSupportedKalshiSpecificationTimestamps(specification) ||
      specification.expirationRule?.settlementDeadline !==
        'day_after_expiration_except_exchange_review' ||
      specification.referenceSource?.id !== 'cf-brti' ||
      specification.referenceSource?.kind !== 'official' ||
      specification.referenceSource?.index !== 'BRTI' ||
      specification.referenceSource?.agency !== 'CF Benchmarks' ||
      specification.referenceSource?.unit !== 'USD/BTC' ||
      specification.comparison !== 'greater_or_equal' ||
      specification.tieResult !== 'YES' ||
      specification.rounding?.decimalPlaces !== 2 ||
      specification.rounding?.mode !== 'nearest' ||
      !isReferenceWindow(specification.referenceWindow) ||
      !isReferenceWindow(specification.closingWindow) ||
      !isTime(timestamps?.opensAt) ||
      !isTime(timestamps?.closesAt) ||
      !isTime(timestamps?.expectedExpirationAt) ||
      !isTime(timestamps?.expirationAt) ||
      !isTime(timestamps?.latestExpirationAt) ||
      timestamps.closesAt - timestamps.opensAt !== 900_000 ||
      timestamps.expectedExpirationAt < timestamps.closesAt ||
      timestamps.expirationAt < timestamps.closesAt ||
      timestamps.latestExpirationAt < timestamps.expirationAt ||
      (timestamps.settledAt !== null &&
        (!isTime(timestamps.settledAt) || timestamps.settledAt < timestamps.closesAt)) ||
      typeof specification.canCloseEarly !== 'boolean' ||
      !Number.isSafeInteger(specification.settlementTimerSeconds) ||
      specification.settlementTimerSeconds < 0 ||
      specification.payoutUnits !== '1000000' ||
      !isTime(specification.receivedAt) ||
      specification.referenceWindow?.endAt !== timestamps.opensAt ||
      specification.closingWindow?.endAt !== timestamps.closesAt ||
      specification.target?.scale !== 2 ||
      (parseDecimalUnits(specification.target?.value, 2) ?? 0n) <= 0n
    )
      errors.push('conflicting_market_rules');
    if (!isValidPriceGrid(specification.priceGrid)) errors.push('invalid_price_grid');
    if (!hasQuantityRules(specification.quantityRules, specification.receivedAt))
      errors.push('missing_quantity_rules');
    if (
      !['half-up', 'half-even'].includes(specification.rounding?.halfway) ||
      !isReviewedRuleSource(specification.rounding?.source, specification.receivedAt)
    )
      errors.push('unverified_halfway_rounding');
    if (
      !hasSupportedKalshiSpecificationRuleText(specification) ||
      !Array.isArray(specification.sources) ||
      ![
        'kalshi-series',
        'kalshi-market',
        'kalshi-contract-terms',
        'kalshi-api',
        'kalshi-precision',
      ].every((id) => specification.sources.some((source) => source?.id === id)) ||
      specification.contingency?.localMissingObservation !== 'unknown_not_source_outage' ||
      specification.contingency?.sourceAgencyDataUnavailable !==
        'contract_no_subject_to_exchange_review' ||
      specification.contingency?.postExpirationRevisions !== 'excluded_by_contract_terms' ||
      specification.contingency?.outcomeReview !== 'exchange_may_review_before_settlement' ||
      specification.contingency?.indeterminateExpirationValue !==
        'exchange_determines_payout_under_rule_6_3_b' ||
      specification.contingency?.settlementAuthority !== 'official_finalized_kalshi_result'
    )
      errors.push('incomplete_rule_provenance');
  }
  return errors;
};

export const isTradableMarketSpecification = (specification) =>
  specification?.actionable === true && getMarketSpecificationErrors(specification).length === 0;

/** Price metadata describes the YES book; the opposite outcome mirrors its legal grid. */
export const isValidVenuePrice = (priceUnits, specification, side = 'YES') => {
  const price = parseIntegerUnits(priceUnits);
  return Boolean(
    isTradableMarketSpecification(specification) &&
    isSide(side) &&
    price !== null &&
    price > 0n &&
    price < 10_000n &&
    isOnPriceGrid(side === 'NO' ? 10_000n - price : price, specification.priceGrid),
  );
};

export const isValidVenueQuantity = (quantityUnits, specification) => {
  const quantity = parseIntegerUnits(quantityUnits);
  if (!isTradableMarketSpecification(specification) || quantity === null) return false;
  const { minimum, step, maximum } = specification.quantityRules;
  return (
    quantity >= BigInt(minimum) &&
    quantity % BigInt(step) === 0n &&
    (maximum == null || quantity <= BigInt(maximum))
  );
};

const getRecordErrors = (record, specification) => {
  const errors = [];
  const add = (condition, reason) => {
    if (!condition) errors.push(reason);
  };
  add(isText(record.id), 'missing_record_id');
  add(hasUnits(record), 'invalid_units');
  add(isSource(record.source), 'invalid_source');
  add(isTime(record.observedAt), 'invalid_observed_at');
  add(isTime(record.receivedAt) && record.receivedAt >= record.observedAt, 'invalid_received_at');
  add(
    record.observationClock === undefined || record.observationClock === 'source-event'
      ? record.sourceObservedAt === undefined || record.sourceObservedAt === record.observedAt
      : record.observationClock === 'local-receipt' &&
          record.observedAt === record.receivedAt &&
          record.sourceObservedAt === null,
    'invalid_observation_clock',
  );
  add(
    specification?.version === tradingDomainVersions.marketSpecification &&
      getMarketSpecificationErrors(specification).length === 0 &&
      record.specificationVersion === specification.version &&
      record.marketTicker === specification.marketTicker,
    'mismatched_market_specification',
  );
  const validUntil = () =>
    add(
      isTime(record.validUntil) &&
        record.validUntil > record.receivedAt &&
        record.validUntil <= specification?.timestamps?.closesAt,
      'invalid_valid_until',
    );
  const venueAmount = (priceField = 'priceUnits') => {
    add(isSide(record.side), 'invalid_side');
    add(
      isUnits(record[priceField], { positive: true }) &&
        isValidVenuePrice(record[priceField], specification, record.side),
      'invalid_price_increment',
    );
    add(
      isUnits(record.quantityUnits, { positive: true }) &&
        isValidVenueQuantity(record.quantityUnits, specification),
      'invalid_quantity_increment',
    );
  };
  if (record.kind === 'observation') {
    add(
      ['observed', 'locally-missing', 'source-agency-outage'].includes(record.status),
      'invalid_observation_status',
    );
    add(
      ['USD/BTC', 'USDT/BTC', 'USD/contract', 'contracts'].includes(record.unit),
      'invalid_value_unit',
    );
    if (record.status === 'observed')
      add((parseDecimalUnits(record.value, 18) ?? -1n) >= 0n, 'invalid_observation_value');
    else add(record.value === null, 'missing_observation_has_value');
    if (record.status === 'source-agency-outage')
      add(
        ['cf-brti', 'synthetic-fixture'].includes(record.source?.id) &&
          isSourceEvidence(record.sourceEvidence) &&
          record.sourceEvidence.retrievedAt <= record.receivedAt,
        'source_outage_requires_source_evidence',
      );
  } else if (record.kind === 'forecast') {
    add(
      record.probabilityScale === 6 &&
        isUnits(record.probabilityYesUnits) &&
        BigInt(record.probabilityYesUnits) <= 1_000_000n,
      'invalid_probability',
    );
    add(isText(record.modelVersion), 'missing_model_version');
    add(
      isTime(record.inputObservedThroughAt) && record.inputObservedThroughAt <= record.observedAt,
      'future_forecast_input',
    );
    add(['model', 'synthetic'].includes(record.source?.kind), 'invalid_forecast_source');
    validUntil();
  } else if (record.kind === 'quote') {
    venueAmount();
    add(['bid', 'ask'].includes(record.bookSide), 'invalid_book_side');
    validUntil();
  } else if (record.kind === 'order') {
    venueAmount('limitPriceUnits');
    add(['paper', 'demo'].includes(record.mode), 'production_execution_disabled');
    add(
      record.source?.kind === 'synthetic' || record.source?.kind === record.mode,
      'invalid_execution_source',
    );
    add(['BUY', 'SELL'].includes(record.action), 'invalid_order_action');
    const quantity = parseIntegerUnits(record.quantityUnits);
    const filled =
      typeof record.filledQuantityUnits === 'string'
        ? parseIntegerUnits(record.filledQuantityUnits)
        : null;
    add(
      quantity !== null && filled !== null && filled >= 0n && filled <= quantity,
      'invalid_filled_quantity',
    );
    const statusIsConsistent =
      filled !== null &&
      quantity !== null &&
      ((record.status === 'pending' && filled === 0n) ||
        (record.status === 'partially-filled' && filled > 0n && filled < quantity) ||
        (record.status === 'filled' && filled === quantity) ||
        record.status === 'canceled' ||
        (record.status === 'rejected' && filled === 0n));
    add(statusIsConsistent, 'invalid_order_state');
  } else if (record.kind === 'fill') {
    venueAmount();
    add(['paper', 'demo'].includes(record.mode), 'production_execution_disabled');
    add(
      record.source?.kind === 'synthetic' || record.source?.kind === record.mode,
      'invalid_execution_source',
    );
    add(['BUY', 'SELL'].includes(record.action), 'invalid_fill_action');
    add(isText(record.orderId), 'missing_order_id');
    add(isUnits(record.feeUnits), 'invalid_fee');
  } else if (record.kind === 'position') {
    add(isSide(record.side), 'invalid_side');
    add(
      isUnits(record.quantityUnits, { positive: true }) &&
        isValidVenueQuantity(record.quantityUnits, specification),
      'invalid_quantity_increment',
    );
    add(isUnits(record.costBasisUnits), 'invalid_cost_basis');
  } else if (record.kind === 'decision') {
    const held = record.position?.state === 'held';
    const flat = record.position?.state === 'flat';
    add(['BUY', 'HOLD', 'SELL'].includes(record.action), 'invalid_decision_action');
    add(isText(record.reason), 'missing_decision_reason');
    add(
      (flat && record.position.positionId === null && record.position.quantityUnits === '0') ||
        (held &&
          isText(record.position.positionId) &&
          isUnits(record.position.quantityUnits, { positive: true })),
      'invalid_position_context',
    );
    if (record.action === 'HOLD') {
      add(record.quantityUnits === '0' && record.limitPriceUnits === null, 'hold_must_not_order');
      add(flat ? record.side === null : isSide(record.side), 'invalid_side');
    } else {
      venueAmount('limitPriceUnits');
      add(isTradableMarketSpecification(specification), 'market_rules_not_actionable');
      if (record.action === 'SELL')
        add(
          held &&
            isUnits(record.quantityUnits, { positive: true }) &&
            isUnits(record.position?.quantityUnits, { positive: true }) &&
            BigInt(record.quantityUnits) <= BigInt(record.position.quantityUnits),
          'sell_exceeds_position',
        );
    }
    validUntil();
  }
  return errors;
};

/** Validation never throws for an unknown version or malformed external record. */
export const validateTradingDomainRecord = (record, specification) => {
  if (!isObject(record)) return { valid: false, errors: ['invalid_record'] };
  if (!isJsonValue(record)) return { valid: false, errors: ['record_not_json_serializable'] };
  const kind =
    record.kind ??
    (record.version === tradingDomainVersions.marketSpecification ? 'marketSpecification' : null);
  if (!Object.hasOwn(tradingDomainVersions, kind) || record.version !== tradingDomainVersions[kind])
    return { valid: false, errors: ['unsupported_record_version'] };
  const errors =
    kind === 'marketSpecification'
      ? getMarketSpecificationErrors(record)
      : getRecordErrors(record, specification);
  return { valid: errors.length === 0, errors };
};

/** Records are JSON-safe and validated at their boundary, rather than merely annotated. */
export const createTradingDomainRecord = (kind, fields, specification) => {
  const record = {
    ...tradingDomainUnits,
    ...fields,
    kind,
    version: tradingDomainVersions[kind],
  };
  const result = validateTradingDomainRecord(record, specification);
  if (!result.valid) throw new TypeError(`Invalid ${kind} record: ${result.errors.join(', ')}`);
  return record;
};
