import { createHash } from 'node:crypto';
import { parseKalshiMarket, parseKalshiSeries } from '../kalshi.validation';
import { parseKalshiUtcTimestamp } from '@/features/MarketData/utils/kalshi/marketSpecification.utils';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Immutable evidence identity, not a claim that the venue assigns this rule version. */
export const normalizeKalshiMarketEvidence = (payload, seriesPayload, receivedAt) => {
  const raw = payload?.market ?? payload;
  const series = parseKalshiSeries(seriesPayload);
  const market = parseKalshiMarket(raw, series, receivedAt);
  const ruleEvidence = {
    series: series.specificationMetadata,
    primary: raw.rules_primary ?? null,
    secondary: raw.rules_secondary ?? null,
    strikeType: raw.strike_type ?? null,
    customStrike: raw.custom_strike ?? null,
    priceRanges: raw.price_ranges ?? null,
    fractionalTradingEnabled: raw.fractional_trading_enabled ?? null,
  };
  const final = ['finalized', 'settled'].includes(raw.status) && ['yes', 'no'].includes(raw.result);
  return {
    schemaVersion: 'kalshi-market-evidence-v1',
    sourceId: 'kalshi-trade-api-v2',
    ticker: market.ticker,
    eventTicker: market.eventTicker,
    seriesTicker: market.seriesTicker,
    exchangeIndex: market.exchangeIndex,
    ruleVersion: `sha256:${hash(ruleEvidence)}`,
    ruleVersionKind: 'local-content-fingerprint',
    ruleEvidence,
    specification: market.specification,
    reference: {
      sourceId: 'cf-brti',
      sourceKind: 'official',
      instrument: 'BRTI',
      currency: 'USD',
      openingLevel: raw.floor_strike == null ? null : String(raw.floor_strike),
      provenance: 'kalshi-market-floor_strike',
    },
    lifecycle: {
      state: raw.status ?? 'unknown',
      opensAt: parseKalshiUtcTimestamp(raw.open_time),
      tradingClosesAt: parseKalshiUtcTimestamp(raw.close_time),
      expiresAt: parseKalshiUtcTimestamp(raw.expiration_time),
      expectedExpirationAt: parseKalshiUtcTimestamp(raw.expected_expiration_time),
      settlementAt: parseKalshiUtcTimestamp(raw.settlement_ts),
      providerUpdatedAt: parseKalshiUtcTimestamp(raw.updated_time),
      observedAt: receivedAt,
    },
    finalOutcome: final
      ? {
          sourceId: 'kalshi-trade-api-v2',
          authoritative: true,
          result: raw.result.toUpperCase(),
          settlementIndexValue: raw.expiration_value == null ? null : String(raw.expiration_value),
          payoutDollars: raw.settlement_value_dollars ?? null,
          settlementAt: parseKalshiUtcTimestamp(raw.settlement_ts),
          observedAt: receivedAt,
        }
      : null,
    reportedResult: raw.result || null,
    receivedAt,
  };
};

/** Polling records observed transitions; it cannot reconstruct missed intermediate states. */
export const createKalshiMarketHistory = () => {
  const markets = new Map();
  const apply = (capture, seriesPayload) => {
    const market = normalizeKalshiMarketEvidence(
      capture.rawPayload,
      seriesPayload,
      capture.receivedAt,
    );
    const previous = markets.get(market.ticker);
    const firstSeenAt = previous?.firstSeenAt ?? capture.receivedAt;
    const previousFinal = previous?.finalOutcome;
    const unchangedFinal =
      previousFinal &&
      market.finalOutcome &&
      previousFinal.result === market.finalOutcome.result &&
      previousFinal.settlementIndexValue === market.finalOutcome.settlementIndexValue &&
      previousFinal.payoutDollars === market.finalOutcome.payoutDollars &&
      previousFinal.settlementAt === market.finalOutcome.settlementAt;
    const evidence = {
      ...market,
      firstSeenAt,
      finalOutcome: unchangedFinal ? previousFinal : market.finalOutcome,
    };
    markets.set(market.ticker, evidence);
    return {
      market: evidence,
      stateChange:
        previous?.lifecycle.state === market.lifecycle.state
          ? null
          : {
              ticker: market.ticker,
              from: previous?.lifecycle.state ?? null,
              to: market.lifecycle.state,
              observedAt: capture.receivedAt,
              sourceEventAt: market.lifecycle.providerUpdatedAt,
              provenance: 'rest-poll-observed',
            },
    };
  };
  return { apply, getMarkets: () => [...markets.values()] };
};
