export const DEADLINE_OUTCOME_DEFINITION = 'coinbase-last-trade-at-deadline-v1';
export const MAXIMUM_DEADLINE_TRADE_AGE_MS = 5000;

export function isVerifiedDeadlineOutcome(outcome, expiresAt, now) {
  return Boolean(
    Number.isSafeInteger(expiresAt) &&
    expiresAt >= 0 &&
    Number.isSafeInteger(now) &&
    now >= 0 &&
    outcome?.status === 'observed' &&
    Number.isFinite(outcome.observedPrice) &&
    outcome.observedPrice > 0 &&
    [
      outcome.observedAt,
      outcome.observedTradeId,
      outcome.confirmedThrough,
      outcome.completeSince,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    outcome.observedAt <= expiresAt &&
    outcome.observedAt >= expiresAt - MAXIMUM_DEADLINE_TRADE_AGE_MS &&
    outcome.completeSince <= outcome.observedAt &&
    outcome.confirmedThrough > expiresAt &&
    outcome.confirmedThrough <= now &&
    now >= expiresAt,
  );
}
