import { isKalshiContract } from '../../../utils/kalshi/contract.utils';
import { PURCHASE_BOOK_MAX_AGE_MS } from '../../../utils/kalshi/purchaseValue.utils';
import {
  TRADING_ADVISOR_POLICY,
  getTradingExecutionQuote,
  isTradingAdvisorPolicy,
} from './tradingAdvisor.utils';

export const ADVISOR_VALUATION_VERSION = 'advisor-valuation-v1';
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const money = (value) => Math.round(value * 1e8) / 1e8;
const equalMoney = (left, right) => Math.abs(left - right) <= 1e-6;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/** Use the newest archived observation, never a future book or an assumed midprice. */
function getLatestBook(books, ticker, now) {
  return (
    books
      .filter(
        (book) => book?.ticker === ticker && timestamp(book.receivedAt) && book.receivedAt <= now,
      )
      .sort((left, right) => right.receivedAt - left.receivedAt)[0] ?? null
  );
}

/** Reporting only: estimate liquidation of every held contract without changing advice or cash. */
export function getAdvisorValuation({
  portfolio,
  books = [],
  now,
  policy = TRADING_ADVISOR_POLICY,
}) {
  if (!timestamp(now) || !isTradingAdvisorPolicy(policy))
    throw new Error('A valid advisor policy and observation time are required.');
  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const base = {
    version: ADVISOR_VALUATION_VERSION,
    policyId: policy.id,
    observedAt: now,
    validUntil: now + 30000,
    complete: false,
    reason: null,
    executableEquity: null,
    totalMarkedPnl: null,
    unrealizedPnl: null,
    liquidationValue: null,
    availableCash: null,
    reservedCapital: null,
    committedCapitalAtRisk: null,
    worstCaseFinalCash: null,
    positions: positions.map((position) => ({
      positionId: position?.id ?? null,
      quantity: position?.quantity ?? null,
      status: 'portfolio_unavailable',
      netProceeds: null,
      exitFee: null,
      bookReceivedAt: null,
    })),
    unpricedPositionCount: positions.length,
  };
  const invalidPortfolio = () => freeze({ ...base, reason: 'portfolio_unavailable' });
  if (
    !portfolio ||
    !Array.isArray(portfolio.positions) ||
    ![portfolio.cash, portfolio.reservedCapital, portfolio.openRisk, portfolio.realizedPnl].every(
      finite,
    ) ||
    portfolio.cash < 0 ||
    portfolio.reservedCapital < 0 ||
    portfolio.openRisk < 0 ||
    positions.some((position) => !finite(position?.costBasis) || position.costBasis < 0)
  )
    return invalidPortfolio();
  const totalBasis = money(positions.reduce((sum, position) => sum + position.costBasis, 0));
  // Reserved buys remain cash until filled. Entry costs already include fees in this ledger.
  if (
    !equalMoney(portfolio.openRisk, totalBasis + portfolio.reservedCapital) ||
    !equalMoney(
      portfolio.cash + portfolio.reservedCapital + totalBasis,
      policy.initialBankroll + portfolio.realizedPnl,
    )
  )
    return invalidPortfolio();

  base.availableCash = money(portfolio.cash);
  base.reservedCapital = money(portfolio.reservedCapital);
  base.committedCapitalAtRisk = money(portfolio.openRisk);
  // Assume every pending buy fills at its maximum cost and every held BTC position loses.
  // Pending sales are not credited and correlated events receive no diversification discount.
  base.worstCaseFinalCash = money(portfolio.cash);
  const depthUses = new Map();
  for (const position of positions) {
    const key = `${position.contract?.ticker}:${position.side}`;
    depthUses.set(key, (depthUses.get(key) ?? 0) + 1);
  }
  const positionIds = new Set();
  base.positions = positions.map((position) => {
    const item = {
      positionId: position.id ?? null,
      quantity: position.quantity ?? null,
      status: 'unpriced',
      netProceeds: null,
      exitFee: null,
      bookReceivedAt: null,
    };
    if (
      typeof position.id !== 'string' ||
      !position.id ||
      positionIds.has(position.id) ||
      !isKalshiContract(position.contract) ||
      !['yes', 'no'].includes(position.side) ||
      !Number.isSafeInteger(position.quantity) ||
      position.quantity < 1
    )
      return { ...item, status: 'invalid_position' };
    positionIds.add(position.id);
    if (depthUses.get(`${position.contract.ticker}:${position.side}`) > 1)
      return { ...item, status: 'shared_depth_unavailable' };
    if (now >= position.contract.expiresAt) return { ...item, status: 'awaiting_settlement' };
    const book = getLatestBook(Array.isArray(books) ? books : [], position.contract.ticker, now);
    if (!book) return { ...item, status: 'book_unavailable' };
    item.bookReceivedAt = book.receivedAt;
    const quote = getTradingExecutionQuote({
      action: 'sell',
      side: position.side,
      // Include contracts reserved for a pending sale once; they remain owned until filled.
      quantity: position.quantity,
      contract: position.contract,
      book,
      now,
      policy,
    });
    if (!quote.available) return { ...item, status: quote.reason };
    base.validUntil = Math.min(
      base.validUntil,
      book.receivedAt + PURCHASE_BOOK_MAX_AGE_MS,
      book.fee.checkedAt + 30000,
      book.fee.validUntil,
      position.contract.expiresAt,
    );
    return { ...item, status: 'priced', netProceeds: quote.netProceeds, exitFee: quote.fee };
  });
  base.unpricedPositionCount = base.positions.filter(
    (position) => position.status !== 'priced',
  ).length;
  if (base.unpricedPositionCount)
    return freeze({ ...base, reason: 'incomplete_liquidation_prices' });
  const liquidationValue = money(
    base.positions.reduce((sum, position) => sum + position.netProceeds, 0),
  );
  const executableEquity = money(base.availableCash + base.reservedCapital + liquidationValue);
  return freeze({
    ...base,
    complete: true,
    liquidationValue,
    executableEquity,
    totalMarkedPnl: money(executableEquity - policy.initialBankroll),
    unrealizedPnl: money(liquidationValue - totalBasis),
  });
}

/** Track sampled liquidation drawdown from the initial bankroll; unknown marks never become zero. */
export function getAdvisorRiskHistory(previous, valuation, initialBankroll = 100) {
  if (
    !finite(initialBankroll) ||
    initialBankroll <= 0 ||
    valuation?.version !== ADVISOR_VALUATION_VERSION ||
    !timestamp(valuation.observedAt) ||
    typeof valuation.complete !== 'boolean' ||
    (valuation.complete && (!finite(valuation.executableEquity) || valuation.executableEquity < 0))
  )
    throw new Error('A valid valuation and initial bankroll are required.');
  if (
    previous &&
    (!timestamp(previous.startedAt) ||
      !timestamp(previous.lastObservedAt) ||
      previous.startedAt > previous.lastObservedAt ||
      previous.lastObservedAt > valuation.observedAt ||
      ![previous.observationCount, previous.completeCount, previous.incompleteCount].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      ) ||
      previous.observationCount < 1 ||
      previous.observationCount !== previous.completeCount + previous.incompleteCount ||
      !finite(previous.peakEquity) ||
      previous.peakEquity < initialBankroll ||
      !finite(previous.maxDrawdown) ||
      previous.maxDrawdown < 0 ||
      previous.maxDrawdown > previous.peakEquity ||
      (previous.completeCount > 0
        ? !timestamp(previous.lastCompleteAt) ||
          previous.lastCompleteAt < previous.startedAt ||
          previous.lastCompleteAt > previous.lastObservedAt
        : previous.lastCompleteAt !== null))
  )
    throw new Error('Risk observations must follow valid history in chronological order.');
  const peakEquity = valuation.complete
    ? Math.max(previous?.peakEquity ?? initialBankroll, valuation.executableEquity)
    : (previous?.peakEquity ?? initialBankroll);
  const drawdown = valuation.complete ? money(peakEquity - valuation.executableEquity) : null;
  return freeze({
    startedAt: previous?.startedAt ?? valuation.observedAt,
    lastObservedAt: valuation.observedAt,
    lastCompleteAt: valuation.complete ? valuation.observedAt : (previous?.lastCompleteAt ?? null),
    observationCount: (previous?.observationCount ?? 0) + 1,
    completeCount: (previous?.completeCount ?? 0) + Number(valuation.complete),
    incompleteCount: (previous?.incompleteCount ?? 0) + Number(!valuation.complete),
    peakEquity: money(peakEquity),
    maxDrawdown: Math.max(previous?.maxDrawdown ?? 0, drawdown ?? 0),
    drawdown,
  });
}
