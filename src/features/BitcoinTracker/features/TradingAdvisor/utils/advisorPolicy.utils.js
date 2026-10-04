const money = (value) => Math.round(value * 1e6) / 1e6;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;

export const ADVISOR_STRATEGIES = Object.freeze([
  'standard',
  'selective-entry',
  'early-exit',
  'cautious-sizing',
]);

const riskProfiles = Object.freeze({
  conservative: {
    reserve: 0.6,
    position: 0.075,
    total: 0.15,
    daily: 0.05,
    drawdown: 0.1,
    probability: 0.08,
  },
  balanced: {
    reserve: 0.5,
    position: 0.1,
    total: 0.2,
    daily: 0.08,
    drawdown: 0.15,
    probability: 0.05,
  },
});

/** Freeze a prospective paper policy. Allocation is a hard user ceiling, never borrowed capital. */
export function createTradingAdvisorPolicy({
  allocation = 100,
  riskLevel = 'conservative',
  runId = null,
  variant = 'standard',
  dailyLossLimitEnabled = false,
} = {}) {
  if (
    !finite(allocation) ||
    allocation < 1 ||
    allocation > 100 ||
    Math.abs(allocation * 100 - Math.round(allocation * 100)) > 1e-8 ||
    !Object.hasOwn(riskProfiles, riskLevel) ||
    !ADVISOR_STRATEGIES.includes(variant) ||
    typeof dailyLossLimitEnabled !== 'boolean' ||
    (runId !== null && (typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(runId)))
  )
    throw new Error(
      'Choose a cent-denominated allocation from $1 to $100, and a supported risk profile.',
    );
  const risk = riskProfiles[riskLevel];
  return Object.freeze({
    id: `kalshi-advisor-v2${runId ? `-${runId}` : ''}`,
    version: 2,
    riskLevel,
    strategyId: variant,
    dailyLossLimitEnabled,
    totalBudget: allocation,
    initialBankroll: allocation,
    cashReserve: money(allocation * risk.reserve),
    maxOpenRisk: money(allocation * risk.total),
    maxPositionCost: money(allocation * risk.position),
    maxDailyLoss: money(allocation * risk.daily),
    maxDrawdown: money(allocation * risk.drawdown),
    maxContracts: 100,
    probabilityReserve: risk.probability,
    minimumEntryEdge: variant === 'selective-entry' ? 0.04 : 0.03,
    fractionalKelly: variant === 'cautious-sizing' ? 0.125 : 0.25,
    slippagePerContract: 0.01,
    minimumExitAdvantage: variant === 'early-exit' ? 0.005 : 0.01,
    cadenceMs: 15000,
    minimumFillDelayMs: 2000,
    maximumFillDelayMs: 15000,
    minimumEntryRemainingMs: 30000,
    valuationMaxAgeMs: 30000,
    reentryCooldownMs: 120000,
    lossCooldownMs: 300000,
    limitPriceIncrement: 0.01,
    accountType: 'direct',
    fillMode: 'partial-ioc',
  });
}

/** Recognize only the published risk profiles and one-change experiment variants. */
export function isAdvisorV2Policy(policy) {
  if (
    policy?.version !== 2 ||
    typeof policy.id !== 'string' ||
    !/^kalshi-advisor-v2(?:-[a-z0-9][a-z0-9-]{0,79})?$/.test(policy.id)
  )
    return false;
  try {
    const expected = createTradingAdvisorPolicy({
      allocation: policy.totalBudget,
      riskLevel: policy.riskLevel,
      variant: policy.strategyId,
      dailyLossLimitEnabled: policy.dailyLossLimitEnabled ?? true,
      runId:
        policy.id === 'kalshi-advisor-v2' ? null : policy.id.slice('kalshi-advisor-v2-'.length),
    });
    if (
      policy.dailyLossLimitEnabled !== undefined &&
      typeof policy.dailyLossLimitEnabled !== 'boolean'
    )
      return false;
    return Object.entries(expected).every(([key, value]) =>
      key === 'dailyLossLimitEnabled' && policy.dailyLossLimitEnabled === undefined
        ? true
        : policy[key] === value,
    );
  } catch {
    return false;
  }
}

/** All BTC positions share the same loss budget; displayed gains never offset missing prices. */
export function getAdvisorEntryRisk({ portfolio, policy, now }) {
  const mark = portfolio?.valuation;
  const blocked = (reason) => ({ reason, budget: 0, equity: null });
  if (!isAdvisorV2Policy(policy)) return blocked('invalid_risk_policy');
  if (
    !mark?.complete ||
    mark.policyId !== policy.id ||
    !timestamp(mark.observedAt) ||
    mark.observedAt > now ||
    now - mark.observedAt > policy.valuationMaxAgeMs ||
    !timestamp(mark.validUntil) ||
    now >= mark.validUntil ||
    !finite(mark.executableEquity) ||
    mark.executableEquity < 0 ||
    !finite(mark.liquidationValue) ||
    mark.liquidationValue < 0 ||
    (mark.accountVersion !== undefined && mark.accountVersion !== portfolio.accountVersion)
  )
    return blocked('risk_valuation_unavailable_or_stale');
  if (![portfolio.cash, portfolio.openRisk, portfolio.dailyRealizedPnl].every(finite))
    return blocked('portfolio_unavailable');
  const peak = Math.max(
    policy.initialBankroll,
    portfolio.riskHistory?.peakEquity ?? policy.initialBankroll,
    mark.executableEquity,
  );
  if (!finite(peak)) return blocked('risk_history_unavailable');
  const day = new Date(now).toISOString().slice(0, 10);
  const dailyStart =
    portfolio.equityDay === day && finite(portfolio.dailyStartEquity)
      ? portfolio.dailyStartEquity
      : policy.initialBankroll;
  if (peak - mark.executableEquity >= policy.maxDrawdown - 1e-8)
    return blocked('equity_drawdown_limit');
  if (
    policy.dailyLossLimitEnabled !== false &&
    (dailyStart - mark.executableEquity >= policy.maxDailyLoss - 1e-8 ||
      portfolio.dailyRealizedPnl <= -policy.maxDailyLoss)
  )
    return blocked('daily_equity_loss_limit');
  if (timestamp(portfolio.lastLossAt) && now < portfolio.lastLossAt + policy.lossCooldownMs)
    return blocked('loss_cooldown');
  if (timestamp(portfolio.lastExitAt) && now < portfolio.lastExitAt + policy.reentryCooldownMs)
    return blocked('reentry_cooldown');
  const budget = money(
    Math.min(
      portfolio.cash - policy.cashReserve,
      policy.totalBudget - portfolio.openRisk,
      policy.maxOpenRisk - portfolio.openRisk,
      policy.maxPositionCost,
      // Every committed dollar could be lost, including other related BTC events.
      policy.dailyLossLimitEnabled === false
        ? Infinity
        : policy.maxDailyLoss + portfolio.dailyRealizedPnl - portfolio.openRisk,
      policy.dailyLossLimitEnabled === false
        ? Infinity
        : portfolio.cash - (dailyStart - policy.maxDailyLoss),
      portfolio.cash - (peak - policy.maxDrawdown),
    ),
  );
  return {
    reason: budget <= 0 ? 'portfolio_loss_capacity_exhausted' : null,
    budget: Math.max(0, budget),
    equity: mark.executableEquity,
  };
}

/** Fractional Kelly is a cautious sizing experiment, not evidence that probabilities are calibrated. */
export function getAdvisorOpportunityBudget({ probability, priceWithFees, equity, policy }) {
  if (
    ![probability, priceWithFees, equity].every(finite) ||
    priceWithFees <= 0 ||
    priceWithFees >= 1
  )
    return 0;
  const cautiousProbability = Math.max(0, probability - policy.probabilityReserve);
  const fraction = Math.max(0, (cautiousProbability - priceWithFees) / (1 - priceWithFees));
  return money(Math.min(policy.maxPositionCost, equity * fraction * policy.fractionalKelly));
}
