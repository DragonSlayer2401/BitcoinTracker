import {
  getKalshiContract,
  isKalshiContract,
  isSameKalshiContract,
} from '../../../utils/kalshi/contract.utils';
import {
  getKalshiPurchaseValue,
  getPurchaseFeeEstimate,
} from '../../../utils/kalshi/purchaseValue.utils';

// A prospective experiment, not fitted or validated trading parameters.
export const TRADING_ADVISOR_POLICY = Object.freeze({
  id: 'kalshi-advisor-v1',
  totalBudget: 100,
  initialBankroll: 100,
  cashReserve: 50,
  maxOpenRisk: 20,
  maxPositionCost: 10,
  maxDailyLoss: 5,
  maxContracts: 20,
  probabilityReserve: 0.05,
  minimumEntryEdge: 0.03,
  slippagePerContract: 0.01,
  minimumExitAdvantage: 0.01,
  cadenceMs: 15000,
  minimumFillDelayMs: 2000,
  maximumFillDelayMs: 15000,
  minimumEntryRemainingMs: 30000,
  limitPriceIncrement: 0.01,
  accountType: 'direct',
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const money = (value) => Math.round(value * 1e6) / 1e6;
const copy = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export function isTradingAdvisorPolicy(policy) {
  return Boolean(
    policy &&
    /^kalshi-advisor-v[1-9]\d*$/.test(policy.id) &&
    policy.totalBudget === 100 &&
    policy.initialBankroll === 100 &&
    finite(policy.cashReserve) &&
    policy.cashReserve >= 0 &&
    policy.cashReserve < policy.totalBudget &&
    finite(policy.maxOpenRisk) &&
    policy.maxOpenRisk > 0 &&
    policy.maxOpenRisk <= policy.totalBudget &&
    finite(policy.maxPositionCost) &&
    policy.maxPositionCost > 0 &&
    policy.maxPositionCost <= policy.maxOpenRisk &&
    finite(policy.maxDailyLoss) &&
    policy.maxDailyLoss > 0 &&
    policy.maxDailyLoss <= policy.totalBudget &&
    Number.isInteger(policy.maxContracts) &&
    policy.maxContracts > 0 &&
    policy.maxContracts <= 10000 &&
    finite(policy.probabilityReserve) &&
    policy.probabilityReserve >= 0 &&
    policy.probabilityReserve < 0.5 &&
    finite(policy.minimumEntryEdge) &&
    policy.minimumEntryEdge > 0 &&
    policy.minimumEntryEdge < 1 &&
    finite(policy.minimumExitAdvantage) &&
    policy.minimumExitAdvantage > 0 &&
    policy.minimumExitAdvantage < 1 &&
    finite(policy.slippagePerContract) &&
    policy.slippagePerContract >= 0 &&
    policy.slippagePerContract < 0.25 &&
    Number.isInteger(policy.cadenceMs) &&
    policy.cadenceMs >= 1000 &&
    Number.isInteger(policy.minimumFillDelayMs) &&
    policy.minimumFillDelayMs >= 1 &&
    Number.isInteger(policy.maximumFillDelayMs) &&
    policy.maximumFillDelayMs > policy.minimumFillDelayMs &&
    policy.maximumFillDelayMs <= 60000 &&
    Number.isInteger(policy.minimumEntryRemainingMs) &&
    policy.minimumEntryRemainingMs >= 30000 &&
    policy.minimumEntryRemainingMs < 900000 &&
    policy.limitPriceIncrement === 0.01 &&
    policy.accountType === 'direct',
  );
}

function getBookProblem({ contract, book, probability = 0.5, now }) {
  if (
    !timestamp(book?.receivedAt) ||
    book.receivedAt > now ||
    (book.requestedAt !== undefined &&
      (!timestamp(book.requestedAt) || book.requestedAt > book.receivedAt))
  )
    return 'book_unavailable_or_noncausal';
  const value = getKalshiPurchaseValue({
    book,
    contract,
    aboveProbability: probability,
    contracts: 1,
    accountType: 'direct',
    now,
  });
  if (!value.available) return 'book_unavailable_or_stale';
  if (
    finite(book.yesAsks[0]?.price) &&
    finite(book.noAsks[0]?.price) &&
    book.yesAsks[0].price + book.noAsks[0].price < 1 - 1e-8
  )
    return 'crossed_book';
  if (getPurchaseFeeEstimate([{ price: 0.5, quantity: 1 }], book.fee, 'direct', now) === null)
    return 'fees_unavailable';
  // The limit search requires monotone fee-inclusive cost/proceeds. Extreme multipliers do not.
  if (book.fee.multiplier > 1 / 0.07) return 'unsupported_fee_schedule';
  return null;
}

function getQuoteAmounts(fills, action, fee, now) {
  const gross = money(fills.reduce((sum, fill) => sum + fill.quantity * fill.price, 0));
  const estimatedFee = getPurchaseFeeEstimate(fills, fee, 'direct', now);
  if (estimatedFee === null) return null;
  // Conservatively round a sale's credited balance down to the direct-account precision.
  const netProceeds = money(Math.floor((gross - estimatedFee + 1e-10) * 10000) / 10000);
  return {
    cost: action === 'buy' ? gross : 0,
    fee: action === 'buy' ? estimatedFee : money(gross - netProceeds),
    totalCost: action === 'buy' ? money(gross + estimatedFee) : 0,
    proceeds: action === 'sell' ? gross : 0,
    netProceeds: action === 'sell' ? netProceeds : 0,
    averagePrice: gross / fills.reduce((sum, fill) => sum + fill.quantity, 0),
  };
}

/** Price a complete quantity from displayed depth; a sell consumes bids, never asks. */
export function getTradingExecutionQuote({
  action,
  side,
  quantity,
  contract,
  book,
  now,
  policy = TRADING_ADVISOR_POLICY,
}) {
  const unavailable = (reason) => ({ available: false, reason, quantity: 0, fullyCovered: false });
  if (
    !isTradingAdvisorPolicy(policy) ||
    !['buy', 'sell'].includes(action) ||
    !['yes', 'no'].includes(side) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > policy.maxContracts
  )
    return unavailable('invalid_execution_request');
  const problem = getBookProblem({ contract, book, now });
  if (problem) return unavailable(problem);
  const levels =
    action === 'buy'
      ? book[`${side}Asks`]
      : book[`${side === 'yes' ? 'no' : 'yes'}Asks`].map((level) => ({
          ...level,
          price: money(1 - level.price),
        }));
  let remaining = quantity;
  const fills = [];
  for (const level of levels) {
    const filled = Math.min(remaining, level.quantity);
    const price =
      action === 'buy'
        ? Math.ceil((level.price + policy.slippagePerContract - 1e-10) * 10000) / 10000
        : Math.floor((level.price - policy.slippagePerContract + 1e-10) * 10000) / 10000;
    if (price <= 0 || price >= 1) break;
    if (filled > 0) fills.push({ price, quantity: filled });
    remaining = money(remaining - filled);
    if (remaining <= 0) break;
  }
  if (remaining > 0) return unavailable('insufficient_execution_depth');
  const amounts = getQuoteAmounts(fills, action, book.fee, now);
  if (!amounts) return unavailable('fees_unavailable');
  if (action === 'sell' && amounts.netProceeds <= 0)
    return unavailable('nonpositive_sale_proceeds');
  return { available: true, quantity, fills, fullyCovered: true, ...amounts };
}

function getPortfolioProblem(portfolio) {
  if (
    !portfolio ||
    ![portfolio.cash, portfolio.openRisk, portfolio.dailyRealizedPnl].every(finite) ||
    portfolio.cash < 0 ||
    portfolio.openRisk < 0 ||
    !Array.isArray(portfolio.positions) ||
    portfolio.positions.some(
      (position) =>
        typeof position?.id !== 'string' ||
        !position.id ||
        !isKalshiContract(position.contract) ||
        !['yes', 'no'].includes(position.side) ||
        !Number.isInteger(position.quantity) ||
        position.quantity < 1 ||
        !Number.isInteger(position.availableQuantity ?? position.quantity) ||
        (position.availableQuantity ?? position.quantity) < 0 ||
        (position.availableQuantity ?? position.quantity) > position.quantity,
    )
  )
    return 'portfolio_unavailable';
  if (
    new Set(portfolio.positions.map((position) => position.id)).size !== portfolio.positions.length
  )
    return 'portfolio_unavailable';
  return null;
}

/** Whole-cent limits are valid across Kalshi price structures; fees apply to the entire order. */
function getOrderLimit({ action, quantity, valuePerContract, costBudget, fee, now }) {
  let lower = 1;
  let upper = 99;
  const qualifies = (units) => {
    const amounts = getQuoteAmounts([{ price: units / 100, quantity }], action, fee, now);
    return Boolean(
      amounts &&
      (action === 'buy'
        ? amounts.totalCost <= Math.min(valuePerContract * quantity, costBudget) + 1e-8
        : amounts.netProceeds >= valuePerContract * quantity - 1e-8),
    );
  };
  if (!qualifies(action === 'buy' ? lower : upper)) return null;
  while (lower < upper) {
    const middle =
      action === 'buy' ? Math.ceil((lower + upper) / 2) : Math.floor((lower + upper) / 2);
    if (qualifies(middle)) {
      if (action === 'buy') lower = middle;
      else upper = middle;
    } else if (action === 'buy') upper = middle - 1;
    else lower = middle + 1;
  }
  return lower / 100;
}

function getExitPlan({ side, quantity, probability, book, now, policy }) {
  const price = getOrderLimit({
    action: 'sell',
    quantity,
    valuePerContract: probability + policy.probabilityReserve + policy.minimumExitAdvantage,
    fee: book.fee,
    now,
  });
  return price === null
    ? null
    : {
        action: 'sell',
        side,
        quantity,
        limitPrice: price,
        type: 'conditional_limit',
        reason: 'fee_adjusted_exit_target',
        expiresAt: now + policy.cadenceMs,
        fillAssumption: 'Not submitted; requires available buyers and fresh reassessment.',
      };
}

/** Recommend an action for the recorded portfolio, with prices and uncertainty kept separate. */
export function getTradingAdvice({
  contract,
  forecast,
  book,
  portfolio,
  now,
  policy = TRADING_ADVISOR_POLICY,
}) {
  if (!isTradingAdvisorPolicy(policy) || !timestamp(now))
    throw new Error('A valid advisor policy and evaluation time are required.');
  const base = {
    action: 'wait',
    side: null,
    quantity: 0,
    limitPrice: null,
    maxCost: null,
    expectedNetValue: null,
    conservativeExpectedNetValue: null,
    quotedCost: null,
    quotedFee: null,
    expectedProceeds: null,
    minimumNetProceeds: null,
    holdExpectedValue: null,
    reason: null,
    positionId: null,
    exitPlan: null,
    evaluatedAt: now,
    policyId: policy.id,
    policy: copy(policy),
    contract: getKalshiContract(contract),
    probability: null,
    forecastCapturedAt: forecast?.capturedAt ?? null,
  };
  const result = (patch) => freeze({ ...base, ...patch });
  if (!base.contract || now < contract.startsAt || now >= contract.expiresAt)
    return result({ reason: 'outside_active_contract' });
  if (
    !forecast?.available ||
    !finite(forecast.aboveProbability) ||
    forecast.aboveProbability < 0 ||
    forecast.aboveProbability > 1 ||
    !timestamp(forecast.capturedAt) ||
    forecast.capturedAt > now ||
    now - forecast.capturedAt > 5000 ||
    typeof forecast.modelVersion !== 'string' ||
    !forecast.modelVersion ||
    (forecast.contract && !isSameKalshiContract(forecast.contract, contract)) ||
    (forecast.marketTicker && forecast.marketTicker !== contract.ticker)
  )
    return result({ reason: 'forecast_unavailable_or_stale' });
  const problem = getBookProblem({ contract, book, probability: forecast.aboveProbability, now });
  if (problem) return result({ reason: problem });
  const portfolioProblem = getPortfolioProblem(portfolio);
  if (portfolioProblem) return result({ reason: portfolioProblem });
  if (portfolio.pendingIntents?.some((intent) => intent.contract?.ticker === contract.ticker))
    return result({ reason: 'pending_execution' });
  const positions = portfolio.positions.filter(
    (position) => position.contract.ticker === contract.ticker,
  );
  if (positions.some((position) => !isSameKalshiContract(position.contract, contract)))
    return result({ reason: 'position_contract_mismatch' });

  // A held position is managed before any new entry; its entry price is a sunk cost.
  if (positions.length) {
    const position = positions.find((item) => (item.availableQuantity ?? item.quantity) > 0);
    if (!position) return result({ reason: 'position_already_reserved' });
    const probability =
      position.side === 'yes' ? forecast.aboveProbability : 1 - forecast.aboveProbability;
    const available = Math.min(
      position.availableQuantity ?? position.quantity,
      policy.maxContracts,
    );
    const positionFields = { side: position.side, positionId: position.id, probability };
    const exitPlan = getExitPlan({
      side: position.side,
      quantity: available,
      probability,
      book,
      now,
      policy,
    });
    let hasExecutableDepth = false;
    let fullSaleQuote = null;
    let selected = null;
    for (let quantity = 1; quantity <= available; quantity += 1) {
      const quote = getTradingExecutionQuote({
        action: 'sell',
        side: position.side,
        quantity,
        contract,
        book,
        now,
        policy,
      });
      if (!quote.available) continue;
      if (quantity === available) fullSaleQuote = quote;
      hasExecutableDepth = true;
      const expectedNetValue = money(quote.netProceeds - probability * quantity);
      const conservativeExpectedNetValue = money(
        quote.netProceeds - (probability + policy.probabilityReserve) * quantity,
      );
      if (conservativeExpectedNetValue < policy.minimumExitAdvantage * quantity - 1e-8) continue;
      const limitPrice = getOrderLimit({
        action: 'sell',
        quantity,
        valuePerContract: probability + policy.probabilityReserve + policy.minimumExitAdvantage,
        fee: book.fee,
        now,
      });
      if (limitPrice === null || quote.fills.some((fill) => fill.price < limitPrice - 1e-8))
        continue;
      if (!selected || expectedNetValue > selected.expectedNetValue)
        selected = {
          action: 'sell',
          quantity,
          limitPrice,
          maxCost: 0,
          expectedNetValue,
          conservativeExpectedNetValue,
          reason:
            quantity < available
              ? 'reduce_at_better_than_hold_value'
              : 'sale_better_than_hold_value',
          expectedProceeds: quote.netProceeds,
          minimumNetProceeds: money(
            (probability + policy.probabilityReserve + policy.minimumExitAdvantage) * quantity,
          ),
          quotedFee: quote.fee,
          holdExpectedValue: money(probability * quantity),
        };
    }
    if (selected) return result({ ...positionFields, ...selected, exitPlan });
    if (!hasExecutableDepth)
      return result({ ...positionFields, reason: 'insufficient_exit_depth', exitPlan });
    return result({
      ...positionFields,
      action: 'hold',
      quantity: available,
      reason: 'hold_value_exceeds_sale',
      holdExpectedValue: money(probability * available),
      expectedProceeds: fullSaleQuote?.netProceeds ?? null,
      quotedFee: fullSaleQuote?.fee ?? null,
      exitPlan,
    });
  }

  if (portfolio.dailyRealizedPnl <= -policy.maxDailyLoss)
    return result({ reason: 'daily_loss_limit' });
  if (contract.expiresAt - now <= policy.minimumEntryRemainingMs)
    return result({ reason: 'too_close_to_settlement' });
  const budget = Math.min(
    portfolio.cash - policy.cashReserve,
    policy.totalBudget - portfolio.openRisk,
    policy.maxOpenRisk - portfolio.openRisk,
    policy.maxPositionCost,
  );
  if (budget <= 0)
    return result({
      reason: portfolio.cash <= policy.cashReserve ? 'cash_reserve_limit' : 'open_risk_limit',
    });
  let selected = null;
  for (const side of ['yes', 'no']) {
    const probability = side === 'yes' ? forecast.aboveProbability : 1 - forecast.aboveProbability;
    const cautiousProbability = Math.max(0, probability - policy.probabilityReserve);
    for (let quantity = 1; quantity <= policy.maxContracts; quantity += 1) {
      const quote = getTradingExecutionQuote({
        action: 'buy',
        side,
        quantity,
        contract,
        book,
        now,
        policy,
      });
      if (!quote.available || quote.totalCost > budget + 1e-8) continue;
      const expectedNetValue = money(probability * quantity - quote.totalCost);
      const conservativeExpectedNetValue = money(cautiousProbability * quantity - quote.totalCost);
      if (conservativeExpectedNetValue < policy.minimumEntryEdge * quantity - 1e-8) continue;
      const limitPrice = getOrderLimit({
        action: 'buy',
        quantity,
        valuePerContract: cautiousProbability - policy.minimumEntryEdge,
        costBudget: budget,
        fee: book.fee,
        now,
      });
      if (limitPrice === null || quote.fills.some((fill) => fill.price > limitPrice + 1e-8))
        continue;
      const maximum = getQuoteAmounts([{ price: limitPrice, quantity }], 'buy', book.fee, now);
      if (!selected || conservativeExpectedNetValue > selected.conservativeExpectedNetValue)
        selected = {
          action: 'buy',
          side,
          quantity,
          probability,
          limitPrice,
          maxCost: maximum.totalCost,
          expectedNetValue,
          conservativeExpectedNetValue,
          quotedCost: quote.totalCost,
          quotedFee: quote.fee,
          reason: 'fee_adjusted_entry_edge',
          exitPlan: getExitPlan({ side, quantity, probability, book, now, policy }),
        };
    }
  }
  return result(selected ?? { reason: 'insufficient_entry_edge_or_depth' });
}

/** One later snapshot executes a saved recommendation; reserved capital/quantity is released only in this input portfolio. */
export function simulateTradingExecution({
  advice,
  contract = advice?.contract,
  book,
  portfolio,
  now,
  decidedAt = advice?.evaluatedAt,
  policy = advice?.policy ?? TRADING_ADVISOR_POLICY,
}) {
  if (
    !isTradingAdvisorPolicy(policy) ||
    !timestamp(now) ||
    !timestamp(decidedAt) ||
    !['buy', 'sell'].includes(advice?.action) ||
    advice.policyId !== policy.id ||
    !isSameKalshiContract(advice.contract, contract)
  )
    return null;
  if (now < decidedAt + policy.minimumFillDelayMs) return null;
  const base = {
    kind: 'no-fill',
    action: advice.action,
    side: advice.side,
    quantity: 0,
    price: null,
    cost: 0,
    fee: 0,
    totalCost: 0,
    proceeds: 0,
    netProceeds: 0,
    positionId: advice.positionId,
    recordedAt: now,
    book: copy(book ?? null),
    fills: [],
  };
  const noFill = (reason) => freeze({ ...base, reason });
  if (now > decidedAt + policy.maximumFillDelayMs || now >= contract.expiresAt)
    return noFill('execution_window_expired');
  if (
    !timestamp(book?.requestedAt) ||
    book.requestedAt < decidedAt + policy.minimumFillDelayMs ||
    !timestamp(book?.receivedAt) ||
    book.receivedAt < book.requestedAt
  )
    return noFill('no_causal_execution_book');
  if (getPortfolioProblem(portfolio)) return noFill('portfolio_unavailable');
  if (advice.action === 'buy') {
    if (contract.expiresAt - now <= policy.minimumEntryRemainingMs)
      return noFill('too_close_to_settlement');
    if (portfolio.dailyRealizedPnl <= -policy.maxDailyLoss) return noFill('daily_loss_limit');
    if (
      !finite(advice.maxCost) ||
      advice.maxCost > policy.maxPositionCost + 1e-8 ||
      portfolio.cash - advice.maxCost < policy.cashReserve - 1e-8 ||
      portfolio.openRisk + advice.maxCost > Math.min(policy.maxOpenRisk, policy.totalBudget) + 1e-8
    )
      return noFill('capital_limit_changed');
    if (portfolio.positions.some((position) => position.contract.ticker === contract.ticker))
      return noFill('position_already_open');
  }
  if (advice.action === 'sell') {
    const position = portfolio.positions.find((item) => item.id === advice.positionId);
    if (
      !position ||
      position.side !== advice.side ||
      !isSameKalshiContract(position.contract, contract) ||
      (position.availableQuantity ?? position.quantity) < advice.quantity
    )
      return noFill('position_unavailable');
  }
  const quote = getTradingExecutionQuote({
    action: advice.action,
    side: advice.side,
    quantity: advice.quantity,
    contract,
    book,
    now,
    policy,
  });
  if (!quote.available) return noFill(quote.reason);
  if (
    !finite(advice.limitPrice) ||
    quote.fills.some((fill) =>
      advice.action === 'buy'
        ? fill.price > advice.limitPrice + 1e-8
        : fill.price < advice.limitPrice - 1e-8,
    )
  )
    return noFill('limit_price_exceeded');
  if (
    advice.action === 'buy' &&
    (!finite(advice.maxCost) ||
      quote.totalCost > advice.maxCost + 1e-8 ||
      quote.totalCost > portfolio.cash + 1e-8)
  )
    return noFill('reserved_capital_exceeded');
  if (
    !finite(advice.probability) ||
    advice.probability < 0 ||
    advice.probability > 1 ||
    (advice.action === 'sell' &&
      (!finite(advice.minimumNetProceeds) ||
        advice.minimumNetProceeds <
          (advice.probability + policy.probabilityReserve + policy.minimumExitAdvantage) *
            advice.quantity -
            1e-8 ||
        quote.netProceeds < advice.minimumNetProceeds - 1e-8))
  )
    return noFill('execution_edge_lost');
  return freeze({
    ...base,
    ...quote,
    kind: 'fill',
    price: quote.averagePrice,
    reason: 'delayed_snapshot_simulation',
  });
}
