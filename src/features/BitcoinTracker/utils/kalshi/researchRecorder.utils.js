import { getEvidenceRow } from '../evidenceStorage.utils';
import { getQualifyingDirection, PRESSURE_POLICY_VERSION } from '../fixedPrediction.utils';
import {
  KALSHI_OUTCOME_DEFINITION,
  getKalshiContract,
  getKalshiOutcome,
  isKalshiContract,
  isSameKalshiContract,
} from './contract.utils';
import { getKalshiQuoteSnapshot } from './marketQuote.utils';
import { getKalshiReferenceQuote } from './marketConditions.utils';
import { hasValidDerivativesMetadata } from '../journal/modelValidation.utils';

export const KALSHI_RESEARCH_COHORT = 'kalshi-background';
export const KALSHI_RESEARCH_POLICY = 'kalshi-checkpoints-v1';
export const KALSHI_RESEARCH_CHECKPOINTS = Object.freeze([12, 9, 6, 3, 1]);
const CHECKPOINT_GRACE_MS = 5000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAXIMUM_MARKETS = 680;
const copy = (value) => JSON.parse(JSON.stringify(value));
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const entryId = (recorderId, ticker, minutes) => `${recorderId}:kalshi:${ticker}:${minutes}m`;

export function getValidatedKalshiRecorderState(state, recorderId) {
  if (
    !validId(recorderId) ||
    state?.version !== 2 ||
    state.recorderId !== recorderId ||
    !Array.isArray(state.markets) ||
    state.markets.length > MAXIMUM_MARKETS ||
    !Array.isArray(state.completed) ||
    state.completed.length > MAXIMUM_MARKETS
  )
    return null;
  const tickers = new Set();
  for (const saved of state.markets) {
    if (
      !isKalshiContract(saved.contract) ||
      tickers.has(saved.contract.ticker) ||
      !Array.isArray(saved.checkpoints) ||
      saved.checkpoints.length !== 5
    )
      return null;
    tickers.add(saved.contract.ticker);
    for (let index = 0; index < saved.checkpoints.length; index++) {
      const entry = saved.checkpoints[index];
      const minutes = KALSHI_RESEARCH_CHECKPOINTS[index];
      if (
        entry?.id !== entryId(recorderId, saved.contract.ticker, minutes) ||
        !isSameKalshiContract(entry.kalshiMarket, saved.contract) ||
        entry.target !== saved.contract.target ||
        entry.expiresAt !== saved.contract.expiresAt ||
        entry.startsAt !== saved.contract.startsAt ||
        entry.checkpointMinutes !== minutes ||
        entry.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
        !['analyzing', 'pending', 'withheld'].includes(entry.status) ||
        entry.analysis?.policyVersion !== KALSHI_RESEARCH_POLICY ||
        entry.analysis.earliestAt !== entry.expiresAt - minutes * 60_000 ||
        entry.analysis.deadline !== entry.analysis.earliestAt + CHECKPOINT_GRACE_MS ||
        !timestamp(entry.createdAt)
      )
        return null;
      if (entry.status === 'pending') {
        if (
          entry.createdAt < entry.analysis.earliestAt ||
          entry.createdAt > entry.analysis.deadline ||
          getQualifyingDirection({ ...entry, available: true }, PRESSURE_POLICY_VERSION) !==
            entry.direction ||
          typeof entry.modelVersion !== 'string' ||
          !entry.modelVersion ||
          !Number.isFinite(entry.price) ||
          entry.price <= 0 ||
          (entry.derivatives !== undefined &&
            !hasValidDerivativesMetadata(entry.derivatives, entry))
        )
          return null;
      } else if (
        entry.direction !== 'neutral' ||
        entry.aboveProbability !== null ||
        entry.belowProbability !== null
      )
        return null;
    }
  }
  for (const completed of state.completed) {
    if (
      typeof completed?.ticker !== 'string' ||
      !/^KXBTC15M-[A-Z0-9-]{1,80}$/.test(completed.ticker) ||
      !timestamp(completed.expiresAt) ||
      tickers.has(completed.ticker)
    )
      return null;
    tickers.add(completed.ticker);
  }
  return copy(state);
}

function isFreshQuote(ticker, now) {
  return (
    Number.isFinite(ticker?.price) &&
    ticker.price > 0 &&
    [ticker.time, ticker.receivedAt].every(
      (time) => timestamp(time) && time <= now && now - time <= 20_000,
    )
  );
}

/** Records actual contracts prospectively. Missing earlier checkpoints are never reconstructed. */
export function createKalshiResearchRecorder({ recorderId, state = null }) {
  if (!validId(recorderId)) throw new Error('A valid research recorder identifier is required.');
  let current = state
    ? getValidatedKalshiRecorderState(state, recorderId)
    : { version: 2, recorderId, markets: [], completed: [] };
  if (!current) throw new Error('Saved Kalshi research state is invalid; recording is paused.');

  function advance({ now, markets = [], ticker, stream, benchmark, getEstimate, getConditions }) {
    if (!timestamp(now) || typeof getEstimate !== 'function')
      throw new Error('A valid observation time and estimate function are required.');
    const next = copy(current);
    const rows = [];
    const available = new Map(
      (Array.isArray(markets) ? markets : [])
        .filter(isKalshiContract)
        .map((market) => [market.ticker, market]),
    );
    next.completed = next.completed.filter((market) => now - market.expiresAt <= RETENTION_MS);
    const known = new Set([
      ...next.markets.map((market) => market.contract.ticker),
      ...next.completed.map((market) => market.ticker),
    ]);
    for (const market of available.values()) {
      if (
        known.has(market.ticker) ||
        now < market.startsAt ||
        now >= market.expiresAt ||
        !['open', 'active'].includes(market.status) ||
        !timestamp(market.receivedAt) ||
        market.receivedAt > now ||
        now - market.receivedAt > 60_000 ||
        next.markets.length >= MAXIMUM_MARKETS
      )
        continue;
      const contract = getKalshiContract(market);
      next.markets.push({
        contract,
        checkpoints: KALSHI_RESEARCH_CHECKPOINTS.map((minutes) => ({
          id: entryId(recorderId, contract.ticker, minutes),
          startsAt: contract.startsAt,
          expiresAt: contract.expiresAt,
          target: contract.target,
          createdAt: now,
          price: null,
          aboveProbability: null,
          belowProbability: null,
          direction: 'neutral',
          status: 'analyzing',
          modelVersion: 'unavailable',
          calculationMode: null,
          outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
          kalshiMarket: contract,
          checkpointMinutes: minutes,
          analysis: {
            policyVersion: KALSHI_RESEARCH_POLICY,
            startedAt: contract.startsAt,
            earliestAt: contract.expiresAt - minutes * 60_000,
            deadline: contract.expiresAt - minutes * 60_000 + CHECKPOINT_GRACE_MS,
          },
        })),
      });
    }
    const unresolved = [];
    for (const saved of next.markets) {
      // Storage accepts atomic batches of at most 100 events. A long offline period must be
      // drained over successive ticks, without dropping old contracts or overflowing the outbox.
      if (rows.length > 90) {
        unresolved.push(saved);
        continue;
      }
      const freshMarket = available.get(saved.contract.ticker);
      const matching = isSameKalshiContract(freshMarket, saved.contract);
      const outcome = matching ? getKalshiOutcome(freshMarket, now) : null;
      for (let index = 0; index < saved.checkpoints.length; index++) {
        let entry = saved.checkpoints[index];
        const evidence = (event, inputs = {}) =>
          getEvidenceRow({ entry, event, now, cohort: KALSHI_RESEARCH_COHORT, ...inputs });
        if (entry.status === 'analyzing' && now >= entry.analysis.earliestAt) {
          const canObserve =
            matching &&
            timestamp(freshMarket.receivedAt) &&
            freshMarket.receivedAt <= now &&
            now - freshMarket.receivedAt <= 60_000 &&
            now <= entry.analysis.deadline;
          const inputs = {
            target: entry.target,
            now,
            expiresAt: entry.expiresAt,
            kalshiMarket: entry.kalshiMarket,
            benchmark,
          };
          const calculated = canObserve ? getEstimate(inputs) : null;
          const estimate = calculated
            ? { ...calculated, kalshiQuote: getKalshiQuoteSnapshot(freshMarket, now) }
            : null;
          const reference = getKalshiReferenceQuote(estimate, ticker);
          const direction = isFreshQuote(reference, now)
            ? getQualifyingDirection(estimate, PRESSURE_POLICY_VERSION)
            : null;
          if (
            direction !== null &&
            estimate.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
            typeof estimate.modelVersion === 'string'
          ) {
            entry = {
              ...entry,
              createdAt: now,
              price: reference.price,
              direction,
              status: 'pending',
              aboveProbability: estimate.aboveProbability,
              belowProbability: estimate.belowProbability,
              modelVersion: estimate.modelVersion,
              kalshi: estimate.kalshi ?? null,
              calculationMode: estimate.learning?.applied
                ? 'outcome-trained'
                : estimate.pressure?.applied || estimate.derivatives?.applied
                  ? 'pressure-adjusted'
                  : 'baseline-fallback',
              ...(estimate.learning ? { learning: estimate.learning } : {}),
              // Keep the exact diagnostics with this checkpoint across collector restarts.
              // Older checkpoints without the feed retain their original absent metadata.
              ...(estimate.derivatives ? { derivatives: copy(estimate.derivatives) } : {}),
            };
            rows.push(
              evidence('decision', {
                entry,
                ticker,
                stream,
                estimate,
                inputObservedAt: now,
                conditions: getConditions?.({ ...inputs, forecast: estimate }),
              }),
            );
          } else if (now >= entry.analysis.deadline) {
            entry = {
              ...entry,
              status: 'withheld',
              withholdingReason:
                now > entry.analysis.deadline ? 'checkpoint-missed' : 'market-data-unavailable',
            };
            rows.push(
              evidence('decision', {
                entry,
                reason:
                  'No valid contemporaneous estimate was captured for this checkpoint; it was not backfilled.',
              }),
            );
          }
        }
        saved.checkpoints[index] = entry;
        if (outcome || now > saved.contract.expiresAt + RETENTION_MS) {
          const resolved = outcome
            ? {
                ...entry,
                status: entry.status === 'pending' ? 'resolved' : entry.status,
                observedAt: outcome.observedAt,
                observedPrice: outcome.observedPrice,
                outcome: outcome.outcome,
                confirmedThrough: outcome.confirmedThrough,
                kalshiOutcome: outcome,
              }
            : { ...entry, status: entry.status === 'pending' ? 'unobserved' : entry.status };
          rows.push(
            evidence('outcome', {
              entry: resolved,
              outcomeStatus: outcome ? 'observed' : 'unobserved',
              reason: outcome
                ? null
                : 'An official Kalshi result was not obtained within seven days.',
            }),
          );
        }
      }
      if (outcome || now > saved.contract.expiresAt + RETENTION_MS)
        next.completed.push({ ticker: saved.contract.ticker, expiresAt: saved.contract.expiresAt });
      else unresolved.push(saved);
    }
    next.markets = unresolved;
    current = next;
    const active = next.markets.find((saved) => saved.contract.expiresAt > now);
    const nextCheckpoint = active?.checkpoints.find((entry) => entry.status === 'analyzing');
    return {
      state: copy(next),
      rows,
      status: {
        phase: active
          ? nextCheckpoint
            ? 'analyzing'
            : 'pending'
          : next.markets.length
            ? 'settling'
            : 'waiting',
        expiresAt: active?.contract.expiresAt ?? null,
        marketTicker: active?.contract.ticker ?? null,
        nextCheckpointAt: nextCheckpoint?.analysis.earliestAt ?? null,
        nextStartAt: active?.contract.expiresAt ?? null,
      },
    };
  }
  return { advance, getState: () => copy(current) };
}
