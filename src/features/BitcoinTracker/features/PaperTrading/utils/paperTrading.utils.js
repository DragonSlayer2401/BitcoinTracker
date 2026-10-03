import {
  getKalshiContract,
  getKalshiOutcome,
  isKalshiContract,
  isSameKalshiContract,
} from '../../../utils/kalshi/contract.utils';
import {
  getKalshiPurchaseValue,
  getPurchaseFeeEstimate,
} from '../../../utils/kalshi/purchaseValue.utils';

// These are experimental paper-account defaults, not fitted trading parameters.
export const PAPER_TRADING_POLICY = Object.freeze({
  id: 'kalshi-paper-v1',
  initialBankroll: 100,
  checkpointMinutes: 6,
  captureGraceMs: 5000,
  contracts: 1,
  accountType: 'direct',
  probabilityReserve: 0.05,
  minimumNetEdge: 0.03,
  slippagePerContract: 0.01,
  minimumFillDelayMs: 2000,
  maximumFillDelayMs: 15000,
  maxOpenRisk: 5,
  maxDailyLoss: 5,
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const money = (value) => Math.round(value * 1_000_000) / 1_000_000;
const copy = (value) => JSON.parse(JSON.stringify(value ?? null));
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const same = (left, right) => canonical(left) === canonical(right);

export function isPaperTradingPolicy(policy) {
  return Boolean(
    policy &&
    /^kalshi-paper-v[1-9]\d*$/.test(policy.id) &&
    finite(policy.initialBankroll) &&
    policy.initialBankroll > 0 &&
    policy.initialBankroll <= 1e6 &&
    Number.isInteger(policy.checkpointMinutes) &&
    policy.checkpointMinutes >= 1 &&
    policy.checkpointMinutes <= 14 &&
    Number.isInteger(policy.captureGraceMs) &&
    policy.captureGraceMs >= 0 &&
    policy.captureGraceMs <= 60000 &&
    policy.contracts === 1 &&
    policy.accountType === 'direct' &&
    finite(policy.probabilityReserve) &&
    policy.probabilityReserve >= 0 &&
    policy.probabilityReserve < 0.5 &&
    finite(policy.minimumNetEdge) &&
    policy.minimumNetEdge >= 0 &&
    policy.minimumNetEdge < 1 &&
    finite(policy.slippagePerContract) &&
    policy.slippagePerContract >= 0 &&
    policy.slippagePerContract <= 0.25 &&
    Number.isInteger(policy.minimumFillDelayMs) &&
    policy.minimumFillDelayMs >= 1 &&
    Number.isInteger(policy.maximumFillDelayMs) &&
    policy.maximumFillDelayMs > policy.minimumFillDelayMs &&
    policy.maximumFillDelayMs <= 60000 &&
    finite(policy.maxOpenRisk) &&
    policy.maxOpenRisk > 0 &&
    policy.maxOpenRisk <= policy.initialBankroll &&
    finite(policy.maxDailyLoss) &&
    policy.maxDailyLoss > 0 &&
    policy.maxDailyLoss <= policy.initialBankroll,
  );
}

function getForecastSnapshot(forecast) {
  return copy({
    available: forecast?.available === true,
    aboveProbability: forecast?.aboveProbability ?? null,
    capturedAt: forecast?.capturedAt ?? null,
    modelVersion: forecast?.modelVersion ?? null,
    modelId: forecast?.modelId ?? null,
    ...(forecast?.researchInputSnapshot
      ? { researchInputSnapshot: forecast.researchInputSnapshot }
      : {}),
  });
}

function getBookSnapshot(book) {
  if (!book || typeof book !== 'object') return null;
  return copy({
    ticker: book.ticker ?? null,
    receivedAt: book.receivedAt ?? null,
    ...(book.requestedAt !== undefined ? { requestedAt: book.requestedAt } : {}),
    yesAsks: book.yesAsks ?? null,
    noAsks: book.noAsks ?? null,
    fee: book.fee ?? null,
    depthLimit: book.depthLimit ?? null,
  });
}

function isCausalBook(book, now) {
  return Boolean(
    book &&
    timestamp(book.receivedAt) &&
    book.receivedAt <= now &&
    (book.requestedAt === undefined ||
      (timestamp(book.requestedAt) && book.requestedAt <= book.receivedAt)),
  );
}

function hasCrossedBook(book) {
  const yesAsk = book?.yesAsks?.[0]?.price;
  const noAsk = book?.noAsks?.[0]?.price;
  return finite(yesAsk) && finite(noAsk) && yesAsk + noAsk < 1 - 1e-8;
}

function getAdverseFills(asks, quantity, slippage) {
  const fills = [];
  let remaining = quantity;
  for (const level of asks) {
    const filled = Math.min(remaining, level.quantity);
    const price = Math.ceil((level.price + slippage - 1e-10) * 10000) / 10000;
    if (price >= 1) return null;
    if (filled > 0) fills.push({ price, quantity: filled });
    remaining = money(remaining - filled);
    if (remaining <= 0) return fills;
  }
  return null;
}

function getFillCost(fills, fee, now) {
  const cost = money(fills.reduce((total, fill) => total + fill.price * fill.quantity, 0));
  const exchangeFee = getPurchaseFeeEstimate(fills, fee, 'direct', now);
  return exchangeFee === null
    ? null
    : { cost, fee: exchangeFee, totalCost: money(cost + exchangeFee) };
}

/** Largest four-decimal limit whose complete fee-inclusive loss fits the conservative edge. */
function getLimitPrice(probability, policy, fee, now) {
  let lower = 0;
  let upper = 9999;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const result = getFillCost([{ price: middle / 10000, quantity: policy.contracts }], fee, now);
    if (result && probability * policy.contracts - result.totalCost >= policy.minimumNetEdge - 1e-8)
      lower = middle;
    else upper = middle - 1;
  }
  return lower / 10000;
}

/** Immutable, causal opportunity record. Missing data is a recorded skip, never invented input. */
export function createPaperDecision({
  contract,
  forecast,
  book,
  now,
  portfolio,
  policy = PAPER_TRADING_POLICY,
}) {
  if (!isKalshiContract(contract) || !isPaperTradingPolicy(policy) || !timestamp(now)) {
    throw new Error('A verified contract, valid paper policy, and decision time are required.');
  }
  const savedForecast = getForecastSnapshot(forecast);
  const savedBook = getBookSnapshot(book);
  const savedPortfolio = copy({
    cash: portfolio?.cash,
    openRisk: portfolio?.openRisk,
    dailyRealizedPnl: portfolio?.dailyRealizedPnl,
  });
  const decision = {
    id: `${policy.id}:${contract.ticker}`,
    policyId: policy.id,
    contract: getKalshiContract(contract),
    decidedAt: now,
    policy: copy(policy),
    forecast: savedForecast,
    book: savedBook,
    portfolio: savedPortfolio,
    status: 'skipped',
    reason: null,
    side: null,
    quantity: policy.contracts,
    limitPrice: null,
    maxCost: null,
    reservedCapital: 0,
    expectedNetValue: null,
    conservativeExpectedNetValue: null,
  };
  const skip = (reason) => deepFreeze({ ...decision, reason });
  const checkpointAt = contract.expiresAt - policy.checkpointMinutes * 60000;
  if (now < checkpointAt || now > checkpointAt + policy.captureGraceMs)
    return skip('outside_capture_window');
  if (
    !savedForecast.available ||
    !finite(savedForecast.aboveProbability) ||
    savedForecast.aboveProbability < 0 ||
    savedForecast.aboveProbability > 1 ||
    !timestamp(savedForecast.capturedAt) ||
    savedForecast.capturedAt > now ||
    now - savedForecast.capturedAt > 5000 ||
    typeof savedForecast.modelVersion !== 'string' ||
    !savedForecast.modelVersion ||
    savedForecast.modelVersion.length > 120 ||
    (savedForecast.modelId !== null &&
      (typeof savedForecast.modelId !== 'string' ||
        !savedForecast.modelId ||
        savedForecast.modelId.length > 200))
  )
    return skip('forecast_unavailable_or_stale');
  if (!isCausalBook(savedBook, now)) return skip('book_unavailable_or_noncausal');
  const value = getKalshiPurchaseValue({
    book: savedBook,
    contract,
    aboveProbability: savedForecast.aboveProbability,
    contracts: policy.contracts,
    accountType: policy.accountType,
    now,
  });
  if (!value.available || hasCrossedBook(savedBook)) return skip('book_unavailable_or_stale');
  if (
    !savedBook.fee?.available ||
    getPurchaseFeeEstimate([{ price: 0.5, quantity: 1 }], savedBook.fee, 'direct', now) === null
  )
    return skip('fees_unavailable');
  if (
    !savedPortfolio ||
    ![savedPortfolio.cash, savedPortfolio.openRisk, savedPortfolio.dailyRealizedPnl].every(
      finite,
    ) ||
    savedPortfolio.cash < 0 ||
    savedPortfolio.openRisk < 0
  )
    return skip('portfolio_unavailable');
  if (savedPortfolio.dailyRealizedPnl <= -policy.maxDailyLoss) return skip('daily_loss_limit');
  const candidates = ['yes', 'no']
    .flatMap((side) => {
      if (!value[side].isFullyCovered) return [];
      const probability = value[side].probability;
      const conservativeProbability = Math.max(0, probability - policy.probabilityReserve);
      const fills = getAdverseFills(
        savedBook[`${side}Asks`],
        policy.contracts,
        policy.slippagePerContract,
      );
      if (!fills) return [];
      const purchase = getFillCost(fills, savedBook.fee, now);
      if (!purchase) return [];
      const expectedNetValue = money(probability * policy.contracts - purchase.totalCost);
      const conservativeExpectedNetValue = money(
        conservativeProbability * policy.contracts - purchase.totalCost,
      );
      if (conservativeExpectedNetValue < policy.minimumNetEdge - 1e-8) return [];
      const limitPrice = getLimitPrice(conservativeProbability, policy, savedBook.fee, now);
      if (fills.some((fill) => fill.price > limitPrice + 1e-8)) return [];
      const maximum = getFillCost(
        [{ price: limitPrice, quantity: policy.contracts }],
        savedBook.fee,
        now,
      );
      return [
        {
          side,
          limitPrice,
          maxCost: maximum.totalCost,
          reservedCapital: maximum.totalCost,
          expectedNetValue,
          conservativeExpectedNetValue,
        },
      ];
    })
    .sort((left, right) => right.conservativeExpectedNetValue - left.conservativeExpectedNetValue);
  if (!candidates.length) return skip('insufficient_conservative_edge_or_depth');
  const selected = candidates[0];
  if (savedPortfolio.cash + 1e-8 < selected.reservedCapital) return skip('insufficient_cash');
  if (savedPortfolio.openRisk + selected.reservedCapital > policy.maxOpenRisk + 1e-8)
    return skip('open_risk_limit');
  return deepFreeze({ ...decision, ...selected, status: 'intent', reason: 'conservative_edge' });
}

export function isPaperDecision(decision) {
  try {
    return same(
      decision,
      createPaperDecision({
        contract: decision.contract,
        forecast: decision.forecast,
        book: decision.book,
        now: decision.decidedAt,
        portfolio: decision.portfolio,
        policy: decision.policy,
      }),
    );
  } catch {
    return false;
  }
}

/** A delayed snapshot simulation, not a claim that an exchange would fill this order. */
export function simulatePaperFill({ decision, book, now }) {
  if (
    !isPaperDecision(decision) ||
    decision.status !== 'intent' ||
    !timestamp(now) ||
    now < decision.decidedAt
  )
    return null;
  const policy = decision.policy;
  const earliest = decision.decidedAt + policy.minimumFillDelayMs;
  const latest = decision.decidedAt + policy.maximumFillDelayMs;
  if (now < earliest) return null;
  const savedBook = getBookSnapshot(book);
  const base = {
    id: `${decision.id}:execution`,
    decisionId: decision.id,
    kind: 'no-fill',
    recordedAt: now,
    reason: null,
    side: decision.side,
    quantity: 0,
    price: null,
    cost: null,
    fee: null,
    totalCost: null,
    bookReceivedAt: savedBook?.receivedAt ?? null,
    book: savedBook,
  };
  const noFill = (reason) => deepFreeze({ ...base, reason });
  if (now > latest || now >= decision.contract.expiresAt) return noFill('execution_window_expired');
  if (
    !isCausalBook(savedBook, now) ||
    savedBook.receivedAt < earliest ||
    (savedBook.requestedAt !== undefined && savedBook.requestedAt < earliest)
  ) {
    return noFill('no_causal_execution_book');
  }
  const value = getKalshiPurchaseValue({
    book: savedBook,
    contract: decision.contract,
    aboveProbability: decision.forecast.aboveProbability,
    contracts: decision.quantity,
    accountType: policy.accountType,
    now,
  });
  if (!value.available || hasCrossedBook(savedBook)) return noFill('execution_book_unavailable');
  if (!value[decision.side].isFullyCovered) return noFill('insufficient_execution_depth');
  const fills = getAdverseFills(
    savedBook[`${decision.side}Asks`],
    decision.quantity,
    policy.slippagePerContract,
  );
  if (!fills || fills.some((fill) => fill.price > decision.limitPrice + 1e-8))
    return noFill('limit_price_exceeded');
  const purchase = getFillCost(fills, savedBook.fee, now);
  if (!purchase) return noFill('execution_fees_unavailable');
  if (purchase.totalCost > decision.reservedCapital + 1e-8)
    return noFill('reserved_capital_exceeded');
  const probability =
    decision.side === 'yes'
      ? decision.forecast.aboveProbability
      : 1 - decision.forecast.aboveProbability;
  return deepFreeze({
    ...base,
    ...purchase,
    kind: 'fill',
    reason: 'delayed_snapshot_simulation',
    quantity: decision.quantity,
    price: purchase.cost / decision.quantity,
    expectedNetValue: money(probability * decision.quantity - purchase.totalCost),
    conservativeExpectedNetValue: money(
      Math.max(0, probability - policy.probabilityReserve) * decision.quantity - purchase.totalCost,
    ),
    fills,
  });
}

export function isPaperExecutionEvent(event, decision) {
  try {
    return Boolean(
      event &&
      ['fill', 'no-fill'].includes(event.kind) &&
      same(event, simulatePaperFill({ decision, book: event.book, now: event.recordedAt })),
    );
  } catch {
    return false;
  }
}

export function settlePaperPosition({ decision, fill, market, now }) {
  if (
    !isPaperExecutionEvent(fill, decision) ||
    fill.kind !== 'fill' ||
    !timestamp(now) ||
    now < fill.recordedAt ||
    !isSameKalshiContract(decision.contract, market)
  )
    return null;
  const kalshiOutcome = getKalshiOutcome(market, now);
  if (!kalshiOutcome) return null;
  const payout = market.result === fill.side ? fill.quantity : 0;
  return deepFreeze({
    id: `${decision.id}:settlement`,
    decisionId: decision.id,
    kind: 'settlement',
    recordedAt: now,
    outcome: market.result,
    settledAt: kalshiOutcome.settledAt,
    payout,
    cost: fill.cost,
    fee: fill.fee,
    totalCost: fill.totalCost,
    netPnl: money(payout - fill.totalCost),
    marketTicker: market.ticker,
    kalshiOutcome,
    market: copy(market),
  });
}

export function isPaperSettlementEvent(event, decision, fill) {
  try {
    return Boolean(
      event?.kind === 'settlement' &&
      same(
        event,
        settlePaperPosition({ decision, fill, market: event.market, now: event.recordedAt }),
      ),
    );
  } catch {
    return false;
  }
}

function getLedger({ policy, decisions, events, now }) {
  const corrupt = () => {
    throw new Error('Invalid paper ledger: capital cannot be reconstructed safely.');
  };
  if (!Array.isArray(decisions) || !Array.isArray(events)) corrupt();
  const unique = new Map();
  for (const decision of decisions) {
    if (typeof decision?.policyId !== 'string') corrupt();
    if (decision.policyId !== policy.id) {
      if (decision.id?.startsWith(`${policy.id}:`)) corrupt();
      continue;
    }
    if (!same(decision.policy, policy) || !isPaperDecision(decision)) corrupt();
    if (unique.has(decision.id) && !same(unique.get(decision.id), decision)) corrupt();
    unique.set(decision.id, decision);
  }
  const executions = new Map();
  const settlements = new Map();
  const uniqueEvents = new Map();
  for (const event of events) {
    if (typeof event?.decisionId !== 'string') corrupt();
    const decision = unique.get(event.decisionId);
    if (!decision) {
      if (event.decisionId.startsWith(`${policy.id}:`)) corrupt();
      continue;
    }
    if (uniqueEvents.has(event.id) && !same(uniqueEvents.get(event.id), event)) corrupt();
    uniqueEvents.set(event.id, event);
    if (event.kind === 'settlement') {
      if (settlements.has(event.decisionId) && !same(settlements.get(event.decisionId), event))
        corrupt();
      settlements.set(event.decisionId, event);
    } else {
      if (!isPaperExecutionEvent(event, decision)) corrupt();
      if (executions.has(event.decisionId) && !same(executions.get(event.decisionId), event))
        corrupt();
      executions.set(event.decisionId, event);
    }
  }
  for (const [id, settlement] of settlements) {
    if (!isPaperSettlementEvent(settlement, unique.get(id), executions.get(id))) corrupt();
  }
  return [...unique.values()]
    .filter((decision) => decision.decidedAt <= now)
    .sort((left, right) => left.decidedAt - right.decidedAt || left.id.localeCompare(right.id))
    .map((decision) => {
      const savedExecution = executions.get(decision.id);
      const savedSettlement = settlements.get(decision.id);
      const execution = savedExecution?.recordedAt <= now ? savedExecution : null;
      const settlement = savedSettlement?.recordedAt <= now ? savedSettlement : null;
      return { decision, execution, settlement };
    });
}

/** Cash excludes intent reservations and money spent on open positions; there is no mark-to-market. */
export function getPaperPortfolio({
  policy = PAPER_TRADING_POLICY,
  decisions = [],
  events = [],
  now,
}) {
  if (!isPaperTradingPolicy(policy) || !timestamp(now))
    throw new Error('A valid paper policy and time are required.');
  const ledger = getLedger({ policy, decisions, events, now });
  const dayStart = Math.floor(now / 86400000) * 86400000;
  let cash = policy.initialBankroll;
  let reservedCapital = 0;
  let openRisk = 0;
  let realizedPnl = 0;
  let dailyRealizedPnl = 0;
  let settledCount = 0;
  let pendingIntentCount = 0;
  let openPositionCount = 0;
  for (const { decision, execution, settlement } of ledger) {
    if (decision.status !== 'intent') continue;
    if (!execution) {
      reservedCapital += decision.reservedCapital;
      openRisk += decision.reservedCapital;
      cash -= decision.reservedCapital;
      pendingIntentCount += 1;
    } else if (execution.kind === 'fill') {
      cash -= execution.totalCost;
      if (settlement) {
        cash += settlement.payout;
        realizedPnl += settlement.netPnl;
        if (settlement.recordedAt >= dayStart) dailyRealizedPnl += settlement.netPnl;
        settledCount += 1;
      } else {
        openRisk += execution.totalCost;
        openPositionCount += 1;
      }
    }
  }
  return {
    initialBankroll: policy.initialBankroll,
    cash: money(cash),
    reservedCapital: money(reservedCapital),
    openRisk: money(openRisk),
    dailyRealizedPnl: money(dailyRealizedPnl),
    realizedPnl: money(realizedPnl),
    settledCount,
    openPositionCount,
    pendingIntentCount,
  };
}

function getPerformance(rows) {
  const settled = rows
    .filter((row) => row.settlement)
    .sort(
      (left, right) =>
        left.settlement.recordedAt - right.settlement.recordedAt ||
        left.settlement.id.localeCompare(right.settlement.id),
    );
  let peak = 0;
  let cumulative = 0;
  let maxRealizedDrawdown = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const { settlement } of settled) {
    cumulative += settlement.netPnl;
    peak = Math.max(peak, cumulative);
    maxRealizedDrawdown = Math.max(maxRealizedDrawdown, peak - cumulative);
    grossProfit += Math.max(0, settlement.netPnl);
    grossLoss += Math.max(0, -settlement.netPnl);
  }
  const winCount = settled.filter((row) => row.settlement.netPnl > 0).length;
  return {
    settledCount: settled.length,
    winCount,
    lossCount: settled.filter((row) => row.settlement.netPnl < 0).length,
    winRate: settled.length ? winCount / settled.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxRealizedDrawdown: money(maxRealizedDrawdown),
    actualNetPnl: money(cumulative),
    averageProfit: settled.length ? money(cumulative / settled.length) : null,
    expectedNetValue: settled.length
      ? money(settled.reduce((sum, row) => sum + row.execution.expectedNetValue, 0))
      : null,
    conservativeExpectedNetValue: settled.length
      ? money(settled.reduce((sum, row) => sum + row.execution.conservativeExpectedNetValue, 0))
      : null,
    intentExpectedNetValue: settled.length
      ? money(settled.reduce((sum, row) => sum + row.decision.expectedNetValue, 0))
      : null,
    intentConservativeExpectedNetValue: settled.length
      ? money(settled.reduce((sum, row) => sum + row.decision.conservativeExpectedNetValue, 0))
      : null,
    fees: money(settled.reduce((sum, row) => sum + row.settlement.fee, 0)),
  };
}

export function getPaperTradingReport({
  policy = PAPER_TRADING_POLICY,
  decisions = [],
  events = [],
  now,
}) {
  const portfolio = getPaperPortfolio({ policy, decisions, events, now });
  const ledger = getLedger({ policy, decisions, events, now });
  const performance = getPerformance(ledger);
  const fillCount = ledger.filter((row) => row.execution?.kind === 'fill').length;
  const byModel = [
    ...new Set(
      ledger.map((row) => row.decision.forecast.modelId ?? row.decision.forecast.modelVersion),
    ),
  ]
    .filter(Boolean)
    .map((model) => ({
      model,
      ...getPerformance(
        ledger.filter(
          (row) => (row.decision.forecast.modelId ?? row.decision.forecast.modelVersion) === model,
        ),
      ),
    }));
  return {
    policy: copy(policy),
    ...portfolio,
    ...performance,
    decisionCount: ledger.length,
    intentCount: ledger.filter((row) => row.decision.status === 'intent').length,
    skippedCount: ledger.filter((row) => row.decision.status === 'skipped').length,
    fillCount,
    noFillCount: ledger.filter((row) => row.execution?.kind === 'no-fill').length,
    tradeCoverage: ledger.length ? fillCount / ledger.length : null,
    returnOnInitialCapital: portfolio.realizedPnl / policy.initialBankroll,
    byModel,
    bySide: ['yes', 'no'].map((side) => ({
      side,
      ...getPerformance(ledger.filter((row) => row.decision.side === side)),
    })),
    recentDecisions: [...ledger]
      .reverse()
      .slice(0, 50)
      .map(({ decision, execution, settlement }) => ({
        id: decision.id,
        decidedAt: decision.decidedAt,
        marketTicker: decision.contract.ticker,
        side: decision.side,
        quantity: decision.quantity,
        status:
          decision.status === 'skipped'
            ? 'skipped'
            : settlement
              ? 'settled'
              : execution?.kind === 'fill'
                ? 'filled'
                : execution?.kind === 'no-fill'
                  ? 'no-fill'
                  : 'pending',
        reason: execution?.reason ?? decision.reason,
        filledQuantity: execution?.kind === 'fill' ? execution.quantity : 0,
        averageFillPrice: execution?.price ?? null,
        fees: execution?.fee ?? null,
        expectedNetValue: execution?.expectedNetValue ?? decision.expectedNetValue,
        conservativeExpectedNetValue:
          execution?.conservativeExpectedNetValue ?? decision.conservativeExpectedNetValue,
        intentExpectedNetValue: decision.expectedNetValue,
        intentConservativeExpectedNetValue: decision.conservativeExpectedNetValue,
        realizedPnl: settlement?.netPnl ?? null,
      })),
    equityLimitation:
      'Paper results use delayed all-or-none book snapshots with assumed adverse slippage, not exchange executions. Cash excludes reserved capital and open positions; realized drawdown excludes changes in their market value. Default risk reserves and thresholds are experimental.',
  };
}
