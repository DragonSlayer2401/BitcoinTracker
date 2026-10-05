import {
  getTradingAdvice,
  isTradingAdvisorPolicy,
  simulateTradingExecution,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/tradingAdvisor.utils';
import {
  getAdvisorRiskHistory,
  getAdvisorValuation,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorValuation.utils';
import {
  getKalshiContract,
  getKalshiOutcome,
  isSameKalshiContract,
} from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  applyAdvisorAdvice,
  applyAdvisorEvent,
  createAdvisorAccount,
  getAdvisorPortfolio,
  withAdvisorDailyEquity,
} from './tradingAdvisor.ledger';

const copy = (value) => JSON.parse(JSON.stringify(value));
const money = (value) => Math.round(value * 1e8) / 1e8;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;

/** Fixed before collection; these are conservative experiment rules, not proven returns. */
export const TRADING_POLICY_TRIAL_RULES = Object.freeze({
  version: 'trading-profit-trial-v1',
  confirmationContracts: 120,
  minimumCandidateTradedContracts: 24,
  minimumBaselineTradedContracts: 12,
  minimumFillCoverage: 0.25,
  minimumElapsedMs: 24 * 60 * 60 * 1000,
  pairedStandardErrorMultiplier: 2.4,
  maximumAdditionalDrawdownFraction: 0.02,
  monitoringContracts: 40,
  minimumMonitoringContracts: 20,
  rollbackAdvantageLossFraction: 0.02,
});

export const TRADING_POLICY_VARIANTS = Object.freeze([
  { id: 'standard', label: 'Current trading rules', changes: {} },
  {
    id: 'selective-entry',
    label: 'Require a larger entry advantage',
    changes: { minimumEntryEdge: 0.04 },
  },
  {
    id: 'early-exit',
    label: 'Accept a smaller advantage to sell',
    changes: { minimumExitAdvantage: 0.005 },
  },
  {
    id: 'cautious-sizing',
    label: 'Use half the opportunity-based stake',
    changes: { fractionalKelly: 0.125 },
  },
]);

/** Freeze separate paper accounts with identical starting capital and hard risk limits. */
export function createTradingPolicyTrial(policy, registeredAt) {
  if (!timestamp(registeredAt) || !isTradingAdvisorPolicy(policy) || policy.version !== 2)
    throw new Error('Profit trials require a valid version 2 paper policy and registration time.');
  if (policy.strategyId !== 'standard')
    throw new Error('A profit trial must register the unchanged standard policy first.');
  const strategies = Object.fromEntries(
    TRADING_POLICY_VARIANTS.map(({ id, label, changes }) => {
      const strategyPolicy = { ...copy(policy), ...changes, strategyId: id };
      if (!isTradingAdvisorPolicy(strategyPolicy))
        throw new Error('Invalid trial strategy policy.');
      return [
        id,
        {
          id,
          label,
          policy: strategyPolicy,
          account: createAdvisorAccount(strategyPolicy),
          consumedExitBooks: {},
          risk: null,
          latestAdvice: null,
        },
      ];
    }),
  );
  return {
    policyId: policy.id,
    registeredAt,
    rules: copy(TRADING_POLICY_TRIAL_RULES),
    phase: 'collecting',
    activeStrategyId: 'standard',
    lastObservedAt: registeredAt,
    activatedAt: null,
    rolledBackAt: null,
    contracts: [],
    strategies,
    books: [],
    transitions: [],
  };
}

function getContractScores(state, cohort) {
  return state.contracts
    .filter((row) => row.cohort === cohort && row.outcome)
    .sort((left, right) => left.contract.startsAt - right.contract.startsAt);
}

/** Compare whole-contract net dollars, including flat zero-return decisions and all fees. */
export function getTradingPolicyComparison(state, strategyId, cohort = 'confirmation') {
  const rows = getContractScores(state, cohort);
  const selected = cohort === 'monitoring' ? rows.slice(-state.rules.monitoringContracts) : rows;
  const differences = selected.map(
    (row) => row.scores[strategyId].netProfit - row.scores.standard.netProfit,
  );
  const count = differences.length;
  const mean = count ? differences.reduce((sum, value) => sum + value, 0) / count : null;
  const variance =
    count > 1
      ? differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1)
      : null;
  const standardError = variance === null ? null : Math.sqrt(variance / count);
  const sum = (id, key) => selected.reduce((total, row) => total + row.scores[id][key], 0);
  const traded = (id) => selected.filter((row) => row.scores[id].entryFills > 0).length;
  const candidateIntentCount = sum(strategyId, 'orderCount');
  const baselineIntentCount = sum('standard', 'orderCount');
  return {
    strategyId,
    resolvedContracts: count,
    candidateProfit: money(sum(strategyId, 'netProfit')),
    baselineProfit: money(sum('standard', 'netProfit')),
    pairedAdvantage: money(differences.reduce((sum, value) => sum + value, 0)),
    meanPairedAdvantage: mean,
    approximateLowerBound:
      standardError === null
        ? null
        : mean - state.rules.pairedStandardErrorMultiplier * standardError,
    candidateTradedContracts: traded(strategyId),
    baselineTradedContracts: traded('standard'),
    candidateCallCoverage: count ? traded(strategyId) / count : 0,
    baselineCallCoverage: count ? traded('standard') / count : 0,
    candidateFillCoverage: candidateIntentCount
      ? sum(strategyId, 'orderFills') / candidateIntentCount
      : 0,
    baselineFillCoverage: baselineIntentCount
      ? sum('standard', 'orderFills') / baselineIntentCount
      : 0,
    candidateDrawdown: state.strategies[strategyId].risk?.history?.maxDrawdown ?? 0,
    baselineDrawdown: state.strategies.standard.risk?.history?.maxDrawdown ?? 0,
  };
}

export function getTradingPolicyEligibility(state, strategyId, at) {
  const comparison = getTradingPolicyComparison(state, strategyId);
  const rules = state.rules;
  const reasons = [];
  if (comparison.resolvedContracts !== rules.confirmationContracts)
    reasons.push('fixed_sample_incomplete');
  if (at - state.registeredAt < rules.minimumElapsedMs) reasons.push('minimum_observation_time');
  if (comparison.candidateTradedContracts < rules.minimumCandidateTradedContracts)
    reasons.push('too_few_candidate_trades');
  if (comparison.baselineTradedContracts < rules.minimumBaselineTradedContracts)
    reasons.push('too_few_baseline_trades');
  if (
    comparison.candidateFillCoverage < rules.minimumFillCoverage ||
    comparison.baselineFillCoverage < rules.minimumFillCoverage
  )
    reasons.push('insufficient_observed_fills');
  if (!(comparison.candidateProfit > 0)) reasons.push('candidate_not_profitable');
  if (!(comparison.approximateLowerBound > 0)) reasons.push('paired_profit_advantage_unproven');
  if (
    comparison.candidateDrawdown >
    comparison.baselineDrawdown +
      state.strategies.standard.policy.initialBankroll * rules.maximumAdditionalDrawdownFraction
  )
    reasons.push('additional_drawdown_too_large');
  return { ...comparison, eligible: reasons.length === 0, reasons };
}

function considerTransition(state, at) {
  if (state.phase === 'collecting') {
    const rows = getContractScores(state, 'confirmation');
    if (
      rows.length !== state.rules.confirmationContracts ||
      at - state.registeredAt < state.rules.minimumElapsedMs
    )
      return;
    const candidates = TRADING_POLICY_VARIANTS.slice(1)
      .map(({ id }) => getTradingPolicyEligibility(state, id, at))
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => right.approximateLowerBound - left.approximateLowerBound);
    if (candidates.length) {
      state.phase = 'active';
      state.activeStrategyId = candidates[0].strategyId;
      state.activatedAt = at;
      state.transitions.push({
        at,
        kind: 'activated',
        strategyId: state.activeStrategyId,
        reason: 'prospective_profit_confirmation',
        comparison: candidates[0],
      });
    } else {
      state.phase = 'rejected';
      state.transitions.push({
        at,
        kind: 'rejected',
        strategyId: 'standard',
        reason: 'no_candidate_passed_frozen_rules',
      });
    }
  }
  if (state.phase !== 'active') return;
  const comparison = getTradingPolicyComparison(state, state.activeStrategyId, 'monitoring');
  if (comparison.resolvedContracts < state.rules.minimumMonitoringContracts) return;
  const allocation = state.strategies.standard.policy.initialBankroll;
  const worseProfit =
    comparison.pairedAdvantage < -allocation * state.rules.rollbackAdvantageLossFraction;
  const worseDrawdown =
    comparison.candidateDrawdown >
    comparison.baselineDrawdown + allocation * state.rules.maximumAdditionalDrawdownFraction;
  if (!worseProfit && !worseDrawdown) return;
  state.phase = 'rolled-back';
  state.rolledBackAt = at;
  state.activeStrategyId = 'standard';
  state.transitions.push({
    at,
    kind: 'rolled-back',
    strategyId: 'standard',
    reason: worseProfit ? 'prospective_profit_deterioration' : 'prospective_drawdown_deterioration',
    comparison,
  });
}

const emptyScore = () => ({ netProfit: 0, entryFills: 0, orderCount: 0, orderFills: 0, fees: 0 });

/** Include every independent account, even when the selected adviser has no order. */
export function getTradingPolicyPendingExecutions(state) {
  return Object.values(state?.strategies ?? {}).flatMap((strategy) =>
    strategy.account.pendingIntents.map((advice) => ({
      advice,
      attempt: strategy.executionAttempts?.[advice.id] ?? null,
    })),
  );
}

function recordExecution(state, strategy, intent, book, at) {
  const event = simulateTradingExecution({
    advice: intent,
    book: getUnconsumedBook(strategy, book),
    portfolio: markPortfolio(state, strategy, at, intent.id),
    now: at,
    policy: intent.policy,
  });
  if (!event) return;
  const applied = applyAdvisorEvent(strategy.account, { ...event, adviceId: intent.id });
  strategy.account = applied.account;
  if (strategy.executionAttempts) delete strategy.executionAttempts[intent.id];
  const row = state.contracts.find((item) => item.contract.ticker === intent.contract.ticker);
  if (!row) throw new Error('Trial execution is missing its prospectively enrolled contract.');
  const score = row.scores[strategy.id];
  score.netProfit = money(score.netProfit + (applied.realizedPnl ?? 0));
  if (event.kind === 'fill') {
    score.orderFills += 1;
    score.entryFills += Number(event.action === 'buy');
    score.fees = money(score.fees + event.fee);
    if (event.action === 'sell' && book) {
      strategy.consumedExitBooks ??= {};
      strategy.consumedExitBooks[intent.contract.ticker] = book.receivedAt;
    }
  }
}

function getUnconsumedBook(strategy, book) {
  if (!book) return null;
  const consumedAt = strategy.consumedExitBooks?.[book.ticker];
  return consumedAt !== undefined && book.receivedAt <= consumedAt ? null : book;
}

function markPortfolio(state, strategy, at, releasedIntentId = null) {
  const portfolio = getAdvisorPortfolio(strategy.account, at, releasedIntentId);
  const valuation = getAdvisorValuation({
    portfolio,
    books: state.books.filter((book) => getUnconsumedBook(strategy, book)),
    now: at,
    policy: strategy.policy,
  });
  const history = getAdvisorRiskHistory(
    strategy.risk?.history,
    valuation,
    strategy.policy.initialBankroll,
  );
  strategy.account = withAdvisorDailyEquity(strategy.account, valuation, at);
  strategy.risk = { valuation, history, isCurrent: true };
  return {
    ...getAdvisorPortfolio(strategy.account, at, releasedIntentId),
    valuation,
    riskHistory: history,
  };
}

/** Replay only newly captured observations, never reconstruct a trial from old research rows. */
export function advanceTradingPolicyTrial(previous, input) {
  const state = copy(previous);
  const at = input.observedAt;
  if (!timestamp(at) || at < state.registeredAt || at < state.lastObservedAt)
    throw new Error('Trial observations must be recorded in chronological order.');
  state.lastObservedAt = at;
  const contract = getKalshiContract(input.contract ?? input.market);
  if (input.kind === 'execution-request') {
    // Persist request membership before fetching. A lost request may expire, but cannot
    // be replaced with a more favorable observation after a collector restart.
    const eligible = getTradingPolicyPendingExecutions(state).filter(
      ({ advice, attempt }) =>
        !attempt &&
        isSameKalshiContract(advice.contract, contract) &&
        at >= advice.evaluatedAt + advice.policy.minimumFillDelayMs &&
        at <= advice.evaluatedAt + advice.policy.maximumFillDelayMs &&
        at < advice.contract.expiresAt,
    );
    const deadline = Math.min(
      ...eligible.map(({ advice }) =>
        Math.min(
          advice.evaluatedAt + advice.policy.maximumFillDelayMs + 1,
          advice.contract.expiresAt,
        ),
      ),
    );
    const ids = new Set(eligible.map(({ advice }) => advice.id));
    for (const strategy of Object.values(state.strategies)) {
      for (const intent of strategy.account.pendingIntents) {
        if (!ids.has(intent.id)) continue;
        strategy.executionAttempts ??= {};
        strategy.executionAttempts[intent.id] = {
          sourceId: input.sourceId,
          requestedAt: at,
          deadline,
        };
      }
    }
    return state;
  }
  if (input.kind === 'settlement') {
    const outcome = getKalshiOutcome(input.market, at);
    const row = state.contracts.find((item) => isSameKalshiContract(item.contract, contract));
    if (!outcome || !row) return state;
    if (row.outcome) {
      if (row.outcome.result !== outcome.result)
        throw new Error('An official trial outcome cannot change.');
      return state;
    }
    for (const strategy of Object.values(state.strategies)) {
      for (const intent of [...strategy.account.pendingIntents]) {
        if (intent.contract.ticker === contract.ticker)
          recordExecution(state, strategy, intent, null, at);
      }
      for (const position of [...strategy.account.positions]) {
        if (position.contract.ticker !== contract.ticker) continue;
        const applied = applyAdvisorEvent(strategy.account, {
          kind: 'settlement',
          positionId: position.id,
          recordedAt: at,
          quantity: position.quantity,
          payout: position.side === outcome.result ? position.quantity : 0,
          outcome,
        });
        strategy.account = applied.account;
        row.scores[strategy.id].netProfit = money(
          row.scores[strategy.id].netProfit + applied.realizedPnl,
        );
      }
      for (const comparison of [...strategy.account.pendingComparisons]) {
        if (comparison.contract.ticker !== contract.ticker) continue;
        strategy.account = applyAdvisorEvent(strategy.account, {
          kind: 'comparison',
          positionId: comparison.positionId,
          recordedAt: at,
          outcome,
          strategyPnl: money(comparison.actualProceeds - comparison.initialCost),
          holdPnl: money(
            (comparison.side === outcome.result ? comparison.initialQuantity : 0) -
              comparison.initialCost,
          ),
        }).account;
      }
      markPortfolio(state, strategy, at);
    }
    row.outcome = outcome;
    row.resolvedAt = at;
    considerTransition(state, at);
    return state;
  }
  if (input.kind !== 'observation') throw new Error('Unknown trial observation kind.');
  const book = input.book ?? null;
  if (book && timestamp(book.receivedAt) && book.receivedAt <= at) {
    state.books = [...state.books.filter((row) => row.ticker !== book.ticker), copy(book)].slice(
      -8,
    );
  }
  const existingTicker = state.contracts.find((item) => item.contract.ticker === contract?.ticker);
  if (existingTicker && !isSameKalshiContract(existingTicker.contract, contract))
    throw new Error('A prospectively enrolled contract cannot change its settlement identity.');
  let row = existingTicker;
  const confirmationCount = state.contracts.filter((item) => item.cohort === 'confirmation').length;
  const cohort =
    confirmationCount < state.rules.confirmationContracts
      ? 'confirmation'
      : state.phase === 'active' && contract?.startsAt >= state.activatedAt
        ? 'monitoring'
        : null;
  if (
    !row &&
    cohort &&
    input.forecast !== undefined &&
    contract &&
    contract.startsAt >= state.registeredAt &&
    at >= contract.startsAt &&
    at < contract.expiresAt
  ) {
    row = {
      contract,
      cohort,
      enrolledAt: at,
      outcome: null,
      scores: Object.fromEntries(Object.keys(state.strategies).map((id) => [id, emptyScore()])),
    };
    state.contracts.push(row);
  }
  for (const strategy of Object.values(state.strategies)) {
    for (const intent of [...strategy.account.pendingIntents]) {
      if (at < intent.evaluatedAt + intent.policy.minimumFillDelayMs) continue;
      const expired =
        at > intent.evaluatedAt + intent.policy.maximumFillDelayMs ||
        at >= intent.contract.expiresAt;
      const attempt = strategy.executionAttempts?.[intent.id];
      // A shared response belongs only to orders eligible when it was requested.
      // Other observations cannot retry an order whose request was already claimed.
      if (!expired && (attempt || input.sourceId) && attempt?.sourceId !== input.sourceId) continue;
      if (expired || attempt || book?.ticker === intent.contract.ticker)
        recordExecution(state, strategy, intent, expired ? null : book, at);
    }
    const portfolio = markPortfolio(state, strategy, at);
    if (
      !row ||
      row.outcome ||
      input.forecast === undefined ||
      at >= contract.expiresAt ||
      (strategy.account.lastAdviceAt !== null &&
        at - strategy.account.lastAdviceAt < strategy.policy.cadenceMs)
    )
      continue;
    const output = getTradingAdvice({
      contract,
      forecast: input.forecast,
      book: getUnconsumedBook(strategy, book),
      portfolio,
      now: at,
      policy: strategy.policy,
    });
    const advice = {
      ...output,
      id: `${state.policyId}:${strategy.id}:${contract.ticker}:${at}`,
      forecast: copy(input.forecast),
      book: copy(book),
      portfolio,
      accountVersion: strategy.account.version,
    };
    strategy.account = applyAdvisorAdvice(strategy.account, advice);
    strategy.latestAdvice = {
      action: advice.action,
      side: advice.side,
      quantity: advice.quantity,
      reason: advice.reason,
      evaluatedAt: at,
      ticker: contract.ticker,
    };
    if (['buy', 'sell'].includes(advice.action)) row.scores[strategy.id].orderCount += 1;
  }
  considerTransition(state, at);
  // Closed monitoring observations remain immutable in the journal; materialized state keeps
  // only the rolling window plus unresolved contracts. Confirmation membership never changes.
  const monitoring = getContractScores(state, 'monitoring');
  const retained = new Set(
    monitoring.slice(-state.rules.monitoringContracts).map((item) => item.contract.ticker),
  );
  state.contracts = state.contracts.filter(
    (item) => item.cohort === 'confirmation' || !item.outcome || retained.has(item.contract.ticker),
  );
  return state;
}

export function getTradingPolicyTrialReport(state, at) {
  if (!state) return { phase: 'not-started', activeStrategyId: 'standard', simulated: true };
  const cohort = state.contracts.filter((row) => row.cohort === 'confirmation');
  return {
    phase: state.phase,
    policyId: state.policyId,
    registeredAt: state.registeredAt,
    initialBankroll: state.strategies.standard.policy.initialBankroll,
    maxEntryContracts: state.strategies.standard.policy.maxEntryContracts ?? null,
    asOf: at,
    simulated: true,
    activeStrategyId: state.activeStrategyId,
    activatedAt: state.activatedAt,
    rolledBackAt: state.rolledBackAt,
    rules: copy(state.rules),
    enrolledContracts: cohort.length,
    resolvedContracts: cohort.filter((row) => row.outcome).length,
    missingOutcomes: cohort
      .filter((row) => !row.outcome && at >= row.contract.expiresAt)
      .map((row) => row.contract.ticker),
    strategies: Object.values(state.strategies).map((strategy) => ({
      id: strategy.id,
      label: strategy.label,
      accountId: `${state.policyId}:${strategy.id}`,
      cash: strategy.account.cash,
      realizedPnl: strategy.account.realizedPnl,
      fees: strategy.account.feesPaid,
      fillCount: strategy.account.performance.fillCount,
      openPositionCount: strategy.account.positions.length,
      pendingOrderCount: strategy.account.pendingIntents.length,
      pendingComparisonCount: strategy.account.pendingComparisons.length,
    })),
    candidates: TRADING_POLICY_VARIANTS.slice(1).map(({ id, label }) => ({
      label,
      ...getTradingPolicyEligibility(state, id, at),
      monitoring: getTradingPolicyComparison(state, id, 'monitoring'),
    })),
    transitions: copy(state.transitions),
    fillAssumption:
      'Shared delayed observed books; partial available quantity fills and remainder cancels. No queue priority or unobserved fills are assumed.',
    statisticalAssumption:
      'Approximate paired standard-error screen with a fixed 2.4 multiplier for three candidates; serial dependence and changing markets remain limitations.',
    restartRule:
      'Rejected or rolled-back trials cannot retry the same sample; a new configured paper run registers new future evidence.',
  };
}
