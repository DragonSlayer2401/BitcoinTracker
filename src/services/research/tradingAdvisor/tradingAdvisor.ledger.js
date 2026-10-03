import { ResearchDataError } from '../research.validation';

const money = (value) => Math.round(value * 1e8) / 1e8;
const copy = (value) => JSON.parse(JSON.stringify(value));
const day = (time) => new Date(time).toISOString().slice(0, 10);
const fail = (message) => {
  throw new ResearchDataError(message, 409);
};

/** Materialized account, updated in the same transaction as its immutable evidence. */
export function createAdvisorAccount(policy) {
  return {
    cash: policy.initialBankroll,
    positions: [],
    pendingIntents: [],
    pendingComparisons: [],
    realizedPnl: 0,
    realizedDay: null,
    dailyRealizedPnl: 0,
    feesPaid: 0,
    lastAdviceAt: null,
    lastRecordedAt: null,
    version: 0,
    performance: {
      adviceCount: 0,
      buyCount: 0,
      sellCount: 0,
      holdCount: 0,
      waitCount: 0,
      fillCount: 0,
      noFillCount: 0,
      entryCount: 0,
      exitCount: 0,
      settledCount: 0,
      realizationCount: 0,
      winCount: 0,
      lossCount: 0,
      grossProfits: 0,
      grossLosses: 0,
      realizedPeak: 0,
      maxRealizedDrawdown: 0,
      pairedPositionCount: 0,
      pairedStrategyPnl: 0,
      pairedHoldPnl: 0,
      pairedWinCount: 0,
      pairedLossCount: 0,
    },
  };
}

export function getAdvisorPortfolio(account, now, releasedIntentId = null) {
  const pending = account.pendingIntents.filter((intent) => intent.id !== releasedIntentId);
  const released = account.pendingIntents.find((intent) => intent.id === releasedIntentId);
  const reservedCapital = money(
    pending.reduce((sum, intent) => sum + (intent.action === 'buy' ? intent.maxCost : 0), 0),
  );
  return {
    cash: money(account.cash + (released?.action === 'buy' ? released.maxCost : 0)),
    reservedCapital,
    openRisk: money(
      account.positions.reduce((sum, position) => sum + position.costBasis, 0) + reservedCapital,
    ),
    realizedPnl: account.realizedPnl,
    dailyRealizedPnl: account.realizedDay === day(now) ? account.dailyRealizedPnl : 0,
    feesPaid: account.feesPaid,
    pendingIntents: copy(pending),
    positions: account.positions.map((position) => ({
      ...copy(position),
      availableQuantity:
        position.quantity -
        pending
          .filter((intent) => intent.action === 'sell' && intent.positionId === position.id)
          .reduce((sum, intent) => sum + intent.quantity, 0),
    })),
  };
}

export function applyAdvisorAdvice(account, advice) {
  const next = copy(account);
  if (next.lastRecordedAt !== null && advice.evaluatedAt < next.lastRecordedAt)
    fail('Advice cannot precede the last account mutation.');
  if (advice.action === 'buy') {
    if (
      !Number.isFinite(advice.maxCost) ||
      advice.maxCost <= 0 ||
      advice.maxCost > next.cash + 1e-8 ||
      next.positions.some((position) => position.contract.ticker === advice.contract.ticker) ||
      next.pendingIntents.some((intent) => intent.contract.ticker === advice.contract.ticker)
    )
      fail('The entry cannot reserve this account capital or duplicate a position.');
    next.cash = money(next.cash - advice.maxCost);
  }
  if (advice.action === 'sell') {
    const portfolio = getAdvisorPortfolio(next, advice.evaluatedAt);
    const position = portfolio.positions.find((row) => row.id === advice.positionId);
    if (
      !position ||
      position.side !== advice.side ||
      position.contract.ticker !== advice.contract.ticker ||
      !Number.isSafeInteger(advice.quantity) ||
      advice.quantity <= 0 ||
      advice.quantity > position.availableQuantity
    )
      fail('The exit cannot reserve more contracts than the simulated account owns.');
  }
  if (['buy', 'sell'].includes(advice.action)) {
    const { forecast, book, ...intent } = advice;
    next.pendingIntents.push(intent);
  }
  next.lastAdviceAt = advice.evaluatedAt;
  next.lastRecordedAt = advice.evaluatedAt;
  next.performance.adviceCount += 1;
  next.performance[`${advice.action}Count`] += 1;
  next.version += 1;
  return next;
}

function recognizeProfit(account, amount, time) {
  const value = money(amount);
  account.realizedPnl = money(account.realizedPnl + value);
  if (account.realizedDay !== day(time)) {
    account.realizedDay = day(time);
    account.dailyRealizedPnl = 0;
  }
  account.dailyRealizedPnl = money(account.dailyRealizedPnl + value);
  const performance = account.performance;
  performance.realizationCount += 1;
  if (value > 0) {
    performance.winCount += 1;
    performance.grossProfits = money(performance.grossProfits + value);
  } else if (value < 0) {
    performance.lossCount += 1;
    performance.grossLosses = money(performance.grossLosses - value);
  }
  performance.realizedPeak = Math.max(performance.realizedPeak, account.realizedPnl);
  performance.maxRealizedDrawdown = money(
    Math.max(performance.maxRealizedDrawdown, performance.realizedPeak - account.realizedPnl),
  );
  return value;
}

/** Realize proportional entry costs on partial exits; never spend an exit twice. */
export function applyAdvisorEvent(account, event) {
  const next = copy(account);
  if (next.lastRecordedAt !== null && event.recordedAt < next.lastRecordedAt)
    fail('Account results must be recorded in chronological order.');
  let realizedPnl = null;
  if (event.kind === 'comparison') {
    const comparison = next.pendingComparisons.find((row) => row.positionId === event.positionId);
    if (!comparison || next.positions.some((row) => row.id === comparison.positionId))
      fail('A paired comparison requires a fully closed position and its official outcome.');
    const actual = money(comparison.actualProceeds - comparison.initialCost);
    const held = money(
      (comparison.side === event.outcome.result ? comparison.initialQuantity : 0) -
        comparison.initialCost,
    );
    if (event.strategyPnl !== actual || event.holdPnl !== held)
      fail('Comparison must use the original entry and all realized exit proceeds.');
    next.performance.pairedPositionCount += 1;
    if (actual > 0) next.performance.pairedWinCount += 1;
    else if (actual < 0) next.performance.pairedLossCount += 1;
    next.performance.pairedStrategyPnl = money(next.performance.pairedStrategyPnl + actual);
    next.performance.pairedHoldPnl = money(next.performance.pairedHoldPnl + held);
    next.pendingComparisons = next.pendingComparisons.filter(
      (row) => row.positionId !== event.positionId,
    );
  } else if (event.kind === 'settlement') {
    const position = next.positions.find((row) => row.id === event.positionId);
    if (
      !position ||
      next.pendingIntents.some((intent) => intent.positionId === position.id) ||
      event.quantity !== position.quantity ||
      event.payout !== (position.side === event.outcome.result ? position.quantity : 0)
    )
      fail('A settlement must resolve the exact remaining unreserved position.');
    next.cash = money(next.cash + event.payout);
    const comparison = next.pendingComparisons.find((row) => row.positionId === position.id);
    if (!comparison) fail('The entry comparison record is missing.');
    comparison.actualProceeds = money(comparison.actualProceeds + event.payout);
    realizedPnl = recognizeProfit(next, event.payout - position.costBasis, event.recordedAt);
    next.positions = next.positions.filter((row) => row.id !== position.id);
    next.performance.settledCount += 1;
  } else {
    const intent = next.pendingIntents.find((row) => row.id === event.adviceId);
    if (!intent || !['fill', 'no-fill'].includes(event.kind))
      fail('An execution needs its unconsumed saved intention.');
    next.pendingIntents = next.pendingIntents.filter((row) => row.id !== intent.id);
    if (intent.action === 'buy') next.cash = money(next.cash + intent.maxCost);
    if (event.kind === 'no-fill') next.performance.noFillCount += 1;
    else {
      if (
        event.action !== intent.action ||
        event.side !== intent.side ||
        event.quantity !== intent.quantity ||
        !Number.isFinite(event.fee) ||
        event.fee < 0
      )
        fail('The fill does not match the saved intention.');
      next.feesPaid = money(next.feesPaid + event.fee);
      next.performance.fillCount += 1;
      if (intent.action === 'buy') {
        if (
          !Number.isFinite(event.totalCost) ||
          event.totalCost <= 0 ||
          event.totalCost > intent.maxCost + 1e-8 ||
          next.positions.some((row) => row.contract.ticker === intent.contract.ticker)
        )
          fail('The fill exceeds reserved capital or duplicates a position.');
        next.cash = money(next.cash - event.totalCost);
        next.positions.push({
          id: `${intent.id}:position`,
          contract: intent.contract,
          side: intent.side,
          quantity: event.quantity,
          costBasis: event.totalCost,
          entryFees: event.fee,
          averagePrice: event.averagePrice ?? event.price,
          openedAt: event.recordedAt,
          entryAdviceId: intent.id,
        });
        next.pendingComparisons.push({
          positionId: `${intent.id}:position`,
          entryAdviceId: intent.id,
          contract: intent.contract,
          side: intent.side,
          initialQuantity: event.quantity,
          initialCost: event.totalCost,
          initialEntryFee: event.fee,
          actualProceeds: 0,
        });
        next.performance.entryCount += 1;
      } else {
        const position = next.positions.find((row) => row.id === intent.positionId);
        if (
          !position ||
          event.quantity > position.quantity ||
          !Number.isFinite(event.netProceeds) ||
          event.netProceeds < 0
        )
          fail('The fill cannot sell missing contracts or invent proceeds.');
        const fraction = event.quantity / position.quantity;
        const basis = money(position.costBasis * fraction);
        next.cash = money(next.cash + event.netProceeds);
        const comparison = next.pendingComparisons.find((row) => row.positionId === position.id);
        if (!comparison) fail('The entry comparison record is missing.');
        comparison.actualProceeds = money(comparison.actualProceeds + event.netProceeds);
        realizedPnl = recognizeProfit(next, event.netProceeds - basis, event.recordedAt);
        position.quantity -= event.quantity;
        position.costBasis = money(position.costBasis - basis);
        position.entryFees = money(position.entryFees * (1 - fraction));
        next.positions = next.positions.filter((row) => row.quantity > 0);
        next.performance.exitCount += 1;
      }
    }
  }
  if (!Number.isFinite(next.cash) || next.cash < -1e-8)
    fail('Simulated account cash cannot become negative.');
  next.version += 1;
  next.lastRecordedAt = event.recordedAt;
  return { account: next, realizedPnl };
}
