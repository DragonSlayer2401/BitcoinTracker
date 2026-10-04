const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export const formatAdvisorMoney = (value) => (Number.isFinite(value) ? money.format(value) : '—');
export const formatAdvisorQuantity = (value) =>
  Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
export const getAdvisorSideLabel = (side) => (side === 'yes' ? 'UP' : side === 'no' ? 'DOWN' : '');

const reasons = {
  risk_valuation_unavailable_or_stale:
    'New entries need a fresh estimate of the account’s sale value.',
  equity_drawdown_limit:
    'The account drawdown stop has paused new entries. Existing positions can still be sold.',
  daily_equity_loss_limit: 'The daily account-loss limit has paused new entries.',
  portfolio_loss_capacity_exhausted: 'Existing BTC exposure uses the remaining loss budget.',
  loss_cooldown: 'Waiting after a losing trade before considering another entry.',
  reentry_cooldown: 'Waiting after the last sale before considering another entry.',
  partial_delayed_snapshot_simulation:
    'Available contracts filled; the unfilled remainder was canceled.',
  outside_active_contract: 'Wait for an open Kalshi event before considering a trade.',
  forecast_unavailable_or_stale: 'A fresh, matching probability estimate is unavailable.',
  book_unavailable_or_noncausal: 'A fresh order book is needed before estimating a fill.',
  book_unavailable_or_stale: 'The order book is missing or stale.',
  crossed_book: 'The order book is inconsistent. Wait for a fresh reading.',
  fees_unavailable: 'Current trading fees could not be verified.',
  portfolio_unavailable: 'Available paper capital or positions could not be verified.',
  position_contract_mismatch: 'The saved position does not match this event.',
  position_already_reserved: 'An existing position is reserved for a pending sale.',
  reduce_at_better_than_hold_value:
    'Selling part of this position is estimated to be worth more than holding it.',
  sale_better_than_hold_value:
    'Selling now is estimated to be worth more than holding to settlement, after costs and uncertainty.',
  insufficient_exit_depth: 'There are not enough displayed buyers for an estimated exit.',
  hold_value_exceeds_sale: 'Selling does not clear the required fees and uncertainty margin.',
  daily_loss_limit: 'The daily realized loss threshold has stopped new entries.',
  cash_reserve_limit: 'Keep the remaining cash reserve available.',
  open_risk_limit: 'The account has reached its open risk limit.',
  fee_adjusted_entry_edge:
    'The estimated settlement value exceeds the purchase cost after fees, slippage and a caution margin.',
  insufficient_entry_edge_or_depth:
    'No suitable entry: the estimated advantage or available liquidity is too small.',
  fee_adjusted_exit_target:
    'Reassess selling if buyers reach this fee-adjusted price and the probability estimate still supports it.',
  delayed_snapshot_simulation: 'Simulated fill using a later order book.',
  execution_window_expired: 'The allowed fill window elapsed without a simulated fill.',
  no_causal_execution_book: 'No new order book was available for the fill attempt.',
  pending_execution: 'An earlier paper order is still waiting for its fill attempt.',
  too_close_to_settlement: 'The event is too close to settlement for a new entry.',
  unsupported_fee_schedule: 'The current fee schedule is not supported by this experiment.',
};

export const getAdvisorReason = (reason) =>
  typeof reason === 'string' && reason
    ? (reasons[reason] ?? reason.replaceAll('_', ' '))
    : 'Waiting for the next recorded evaluation.';

/** Cached ledger balances are current only while their successful snapshot is recent. */
export function hasFreshAdvisorReport(report, now) {
  return Boolean(
    Number.isFinite(now) &&
    Number.isFinite(report?.asOf) &&
    report.asOf > 0 &&
    report.asOf <= now &&
    now - report.asOf < 30_000,
  );
}

/** A stored suggestion is actionable only for this open contract and a recent collector cycle. */
export function hasFreshAdvisorAdvice({ advice, collector, market, now }) {
  return Boolean(
    Number.isFinite(now) &&
    advice &&
    ['buy', 'sell', 'hold', 'wait'].includes(advice.action) &&
    (advice.action === 'wait' || ['yes', 'no'].includes(advice.side)) &&
    Number.isFinite(advice.evaluatedAt) &&
    advice.evaluatedAt <= now &&
    now - advice.evaluatedAt < 30_000 &&
    (!Number.isFinite(advice.validUntil) || now < advice.validUntil) &&
    !['filled', 'no-fill'].includes(advice.executionStatus) &&
    collector?.status === 'running' &&
    Number.isFinite(collector.heartbeatAt) &&
    collector.heartbeatAt <= now &&
    now - collector.heartbeatAt < 30_000 &&
    market &&
    market.startsAt <= now &&
    market.expiresAt > now &&
    advice.contract?.ticker === market.ticker &&
    advice.contract?.target === market.target &&
    advice.contract?.expiresAt === market.expiresAt,
  );
}
