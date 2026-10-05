import {
  createAdvisorAccount,
  getAdvisorPortfolio,
  applyAdvisorAdvice,
  applyAdvisorEvent,
  withAdvisorDailyEquity,
} from './tradingAdvisor.ledger';
import {
  getTradingAdvice,
  simulateTradingExecution,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/tradingAdvisor.utils';
import {
  getAdvisorValuation,
  getAdvisorRiskHistory,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorValuation.utils';
import {
  getAdvisorCandidateEvidence,
  getHistoryRulesDecision,
  validateAdvisorCandidateDecision,
  simulateAdvisorCandidateExecution,
} from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorCandidate.utils';
import { createAdvisorPlan } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorPlan.utils';
import {
  getKalshiContract,
  getKalshiOutcome,
  isSameKalshiContract,
} from '@/features/BitcoinTracker/utils/kalshi/contract.utils';

const copy = (value) => JSON.parse(JSON.stringify(value));
const money = (value) => Math.round(value * 1e8) / 1e8;
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
export const ADVISOR_HISTORY_TRIAL_VERSION = 'advisor-history-trial-v1';
export const ADVISOR_HISTORY_TRIAL_RULES = Object.freeze({
  confirmationContracts: 120,
  minimumElapsedMs: 86400000,
  minimumTradedContracts: 24,
  requiredPairedProfitLowerBound: 0,
  maximumAdditionalDrawdownFraction: 0.02,
  automaticPromotion: false,
  fallback: 'incumbent-at-current-time',
});

/** Start three independent, equal-capital accounts before enrolling future contracts. */
export function createAdvisorHistoryTrial({ id, policy, provider, registeredAt }) {
  return {
    id,
    policy: copy(policy),
    provider: copy(provider),
    registeredAt,
    version: ADVISOR_HISTORY_TRIAL_VERSION,
    rules: copy(ADVISOR_HISTORY_TRIAL_RULES),
    lastObservedAt: registeredAt,
    lastMarketObservedAt: null,
    contracts: [],
    books: [],
    modelIdentity: null,
    recordingGaps: 0,
    strategies: Object.fromEntries(
      ['incumbent', 'history-rules', 'language-model'].map((id) => [
        id,
        {
          id,
          account: createAdvisorAccount(policy),
          history: [],
          plan: null,
          currentPlan: null,
          latestAdvice: null,
          recentActivity: [],
          guidanceDecision: null,
          risk: null,
          latestDecision: null,
          pendingRequest: null,
          lastRequestAt: null,
          consumedBooks: {},
          inferenceCost: 0,
          turnover: 0,
          actionReversals: 0,
          heldMilliseconds: 0,
          exitedQuantity: 0,
          missedExits: 0,
          failureCount: 0,
          vetoCount: 0,
          lastAction: null,
          netPeakEquity: policy.initialBankroll,
          netDrawdown: 0,
          decisions: [],
          completedRequestIds: [],
        },
      ]),
    ),
    hypotheses: [
      'A brief pullback need not invalidate a still-supported entry thesis.',
      'Sustained deterioration and approaching expiry can justify an earlier exit after costs.',
      'An LLM must improve net outcomes beyond a simpler history-based policy after inference costs.',
    ],
  };
}

function usableBook(strategy, book) {
  return book && book.receivedAt > (strategy.consumedBooks[book.ticker] ?? 0) ? book : null;
}

function mark(state, strategy, at, releasedIntentId = null) {
  const portfolio = getAdvisorPortfolio(strategy.account, at, releasedIntentId);
  const valuation = {
    ...getAdvisorValuation({
      portfolio,
      books: state.books.map((book) => usableBook(strategy, book)).filter(Boolean),
      now: at,
      policy: state.policy,
    }),
    accountVersion: strategy.account.version,
  };
  const history = getAdvisorRiskHistory(
    strategy.risk?.history,
    valuation,
    state.policy.initialBankroll,
  );
  strategy.account = withAdvisorDailyEquity(strategy.account, valuation, at);
  strategy.risk = { valuation, history };
  if (valuation.complete) {
    const netEquity = valuation.executableEquity - strategy.inferenceCost;
    strategy.netPeakEquity = Math.max(strategy.netPeakEquity, netEquity);
    strategy.netDrawdown = Math.max(strategy.netDrawdown, strategy.netPeakEquity - netEquity);
  }
  return {
    ...getAdvisorPortfolio(strategy.account, at, releasedIntentId),
    accountVersion: strategy.account.version,
    valuation,
    riskHistory: history,
  };
}

function recordDecision(strategy, value) {
  strategy.latestDecision = value;
  strategy.decisions = [...strategy.decisions, value].slice(-24);
}

function recordActivity(strategy, value) {
  strategy.recentActivity = [
    {
      id: `${strategy.id}:${value.kind}:${value.adviceId ?? value.positionId ?? ''}:${value.recordedAt}`,
      ...value,
    },
    ...(strategy.recentActivity ?? []),
  ].slice(0, 50);
}

function applyAdvice(state, strategy, output, input, portfolio, status, extra = {}) {
  const at = input.observedAt;
  const advice = {
    ...output,
    id: `${state.id}:${strategy.id}:${input.id}`,
    forecast: copy(input.forecast),
    book: copy(input.book ?? null),
    portfolio,
    accountVersion: strategy.account.version,
    validUntil: Math.min(at + state.policy.cadenceMs, input.contract.expiresAt),
  };
  strategy.account = applyAdvisorAdvice(strategy.account, advice);
  const action =
    extra.action ??
    (advice.action === 'sell'
      ? 'EXIT'
      : advice.action === 'buy'
        ? `BUY_${advice.side.toUpperCase()}`
        : advice.action === 'wait'
          ? 'NO_TRADE'
          : advice.action.toUpperCase());
  if (['buy', 'sell'].includes(advice.action)) {
    if (
      strategy.lastAction &&
      strategy.lastAction.action !== advice.action &&
      at - strategy.lastAction.at <= 60000
    )
      strategy.actionReversals += 1;
    strategy.lastAction = { action: advice.action, at };
    const row = state.contracts.find((row) => row.contract.ticker === input.contract.ticker);
    row.scores[strategy.id].orders += 1;
  }
  recordDecision(strategy, {
    action,
    side: advice.side,
    reason: advice.reason,
    assessedAt: at,
    snapshotId: input.id,
    ...extra,
    reviewAt: extra.nextReviewAt ?? Math.min(at + state.policy.cadenceMs, input.contract.expiresAt),
    status,
  });
  // Market snapshots already live in observation evidence. The dashboard needs
  // only the recommendation, not another copy of books and nested portfolios.
  const { forecast: _forecast, book: _book, portfolio: _portfolio, ...displayAdvice } = advice;
  strategy.latestAdvice = displayAdvice;
  recordActivity(strategy, { ...displayAdvice, kind: 'advice', recordedAt: at });
  const previousPlan = strategy.currentPlan ?? null;
  const currentPlan = createAdvisorPlan(advice, previousPlan);
  // The reservation above is part of this assessment. Subsequent fills, waits or
  // provider responses must never extend the plan or relabel its account version.
  if (currentPlan && currentPlan !== previousPlan) {
    strategy.currentPlan = {
      ...currentPlan,
      policyId: state.policy.id,
      accountVersion: strategy.account.version,
      ...(status === 'accepted' && extra.invalidationConditions
        ? { invalidationConditions: copy(extra.invalidationConditions) }
        : {}),
      ...(extra.action === 'REDUCE' ? { action: 'reduce' } : {}),
    };
    strategy.guidanceDecision = copy(strategy.latestDecision);
  }
  return advice;
}

function execute(state, strategy, intent, book, at) {
  const simulator = intent.candidatePolicyVersion
    ? simulateAdvisorCandidateExecution
    : simulateTradingExecution;
  const priorPosition = strategy.account.positions.find((row) => row.id === intent.positionId);
  const event = simulator({
    advice: intent,
    book: usableBook(strategy, book),
    now: at,
    portfolio: mark(state, strategy, at, intent.id),
    policy: intent.policy,
  });
  if (!event) return;
  const applied = applyAdvisorEvent(strategy.account, { ...event, adviceId: intent.id });
  strategy.account = applied.account;
  recordActivity(strategy, { ...event, adviceId: intent.id, realizedPnl: applied.realizedPnl });
  const row = state.contracts.find((row) => row.contract.ticker === intent.contract.ticker);
  if (!row) throw new Error('A shadow order requires its original prospective contract.');
  const score = row.scores[strategy.id];
  score.netProfit = money(score.netProfit + (applied.realizedPnl ?? 0));
  if (event.kind === 'fill') {
    score.fills += 1;
    score.traded = true;
    strategy.turnover = money(strategy.turnover + event.price * event.quantity);
    if (event.action === 'buy') {
      const position = strategy.account.positions.find((item) => item.entryAdviceId === intent.id);
      if (position) {
        position.entryRationale = intent.candidatePlan?.rationale ?? intent.reason;
        position.entryProbability = intent.probability;
        position.entryThesis = intent.candidatePlan?.thesis ?? null;
      }
    }
    if (event.action === 'sell') {
      strategy.consumedBooks[intent.contract.ticker] = book?.receivedAt ?? at;
      strategy.heldMilliseconds +=
        Math.max(0, at - (priorPosition?.openedAt ?? priorPosition?.enteredAt ?? at)) *
        event.quantity;
      strategy.exitedQuantity += event.quantity;
    }
  } else if (intent.action === 'sell') strategy.missedExits += 1;
}

function settle(state, input) {
  const at = input.observedAt;
  const contract = getKalshiContract(input.market);
  const row = state.contracts.find((row) => isSameKalshiContract(row.contract, contract));
  const outcome = getKalshiOutcome(input.market, at);
  if (!row || !outcome) return;
  if (row.outcome) {
    if (row.outcome.result !== outcome.result)
      throw new Error('A shadow trial outcome cannot change.');
    return;
  }
  for (const strategy of Object.values(state.strategies)) {
    for (const intent of [...strategy.account.pendingIntents])
      if (intent.contract.ticker === contract.ticker) execute(state, strategy, intent, null, at);
    for (const position of [...strategy.account.positions]) {
      if (position.contract.ticker !== contract.ticker) continue;
      const settlement = {
        kind: 'settlement',
        positionId: position.id,
        recordedAt: at,
        quantity: position.quantity,
        payout: position.side === outcome.result ? position.quantity : 0,
        outcome,
      };
      const applied = applyAdvisorEvent(strategy.account, settlement);
      strategy.account = applied.account;
      recordActivity(strategy, { ...settlement, realizedPnl: applied.realizedPnl });
      row.scores[strategy.id].netProfit = money(
        row.scores[strategy.id].netProfit + applied.realizedPnl,
      );
      strategy.heldMilliseconds +=
        Math.max(0, at - (position.openedAt ?? position.enteredAt ?? at)) * position.quantity;
      strategy.exitedQuantity += position.quantity;
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
    mark(state, strategy, at);
  }
  row.outcome = outcome;
}

/** Record a returned proposal only. Accepting it requires a later fresh market observation. */
export function recordAdvisorLanguageModelResult(
  previous,
  { requestId, result, observedAt, evidence },
) {
  const state = copy(previous);
  const strategy = state.strategies['language-model'];
  const pending = strategy.pendingRequest;
  if (strategy.completedRequestIds.includes(requestId)) return state;
  const source = evidence ?? (pending?.requestId === requestId ? pending.evidence : null);
  if (
    !source ||
    !timestamp(observedAt) ||
    observedAt < source.observedAt ||
    observedAt < state.lastObservedAt ||
    !timestamp(result.respondedAt) ||
    result.respondedAt > observedAt
  )
    throw new Error('An AI response cannot be backdated.');
  state.lastObservedAt = observedAt;
  strategy.completedRequestIds.push(requestId);
  const cost =
    Number.isFinite(result.inferenceCostUsd) && result.inferenceCostUsd >= 0
      ? result.inferenceCostUsd
      : 0;
  strategy.inferenceCost = money(strategy.inferenceCost + cost);
  // A final response can arrive after settlement and be the last observation in
  // the cohort. Its cost still belongs in the net equity and drawdown record.
  mark(state, strategy, observedAt);
  const row = state.contracts.find((row) => row.contract.ticker === source.contract.ticker);
  if (row)
    row.scores['language-model'].inferenceCost = money(
      row.scores['language-model'].inferenceCost + cost,
    );
  if (pending?.requestId === requestId && !pending.result) pending.result = copy(result);
  recordDecision(strategy, {
    status: 'proposed',
    action: result.output?.action ?? null,
    reason: pending?.requestId === requestId ? result.status : 'superseded_response',
    assessedAt: observedAt,
    snapshotId: source.snapshotId,
    requestId,
    rationale: result.output?.rationale ?? null,
  });
  return state;
}

/** Replay forward observations under frozen rules; no historical sample substitution or promotion. */
export function advanceAdvisorHistoryTrial(previous, input, { executionClaims = {} } = {}) {
  const state = copy(previous);
  const at = input.observedAt;
  if (!timestamp(at) || at < state.registeredAt || at < state.lastObservedAt)
    throw new Error('Shadow observations must be chronological.');
  state.lastObservedAt = at;
  if (input.kind === 'gap') {
    state.recordingGaps += 1;
    return state;
  }
  if (input.kind === 'settlement') {
    settle(state, input);
    return state;
  }
  if (input.kind !== 'observation') throw new Error('Unknown shadow observation.');
  state.lastMarketObservedAt = at;
  const contract = getKalshiContract(input.contract);
  const book = input.book ?? null;
  if (book && timestamp(book.receivedAt) && book.receivedAt <= at)
    state.books = [...state.books.filter((row) => row.ticker !== book.ticker), copy(book)].slice(
      -8,
    );
  let row = state.contracts.find((row) => row.contract.ticker === contract?.ticker);
  if (row && !isSameKalshiContract(row.contract, contract))
    throw new Error('A shadow contract changed its target or deadline.');
  if (
    !row &&
    contract &&
    input.forecast &&
    contract.startsAt >= state.registeredAt &&
    at >= contract.startsAt &&
    at < contract.expiresAt &&
    state.contracts.length < state.rules.confirmationContracts
  ) {
    row = {
      contract,
      enrolledAt: at,
      outcome: null,
      scores: Object.fromEntries(
        Object.keys(state.strategies).map((id) => [
          id,
          { netProfit: 0, inferenceCost: 0, orders: 0, fills: 0, traded: false },
        ]),
      ),
    };
    state.contracts.push(row);
  }
  for (const strategy of Object.values(state.strategies)) {
    for (const intent of [...strategy.account.pendingIntents]) {
      if (at < intent.evaluatedAt + state.policy.minimumFillDelayMs) continue;
      const expired =
        at > intent.evaluatedAt + state.policy.maximumFillDelayMs ||
        at >= intent.contract.expiresAt;
      const claim = executionClaims[intent.id];
      // Once requested, an order gets that one shared execution observation.
      // A lost request cannot get a more favorable retry from unrelated books.
      // Orders that became eligible during the request wait for their own claim.
      if (!expired && (claim || input.executionObservation) && claim?.sourceId !== input.sourceId)
        continue;
      if (expired || claim || book?.ticker === intent.contract.ticker)
        execute(state, strategy, intent, expired ? null : book, at);
    }
    const portfolio = mark(state, strategy, at);
    if (
      !row ||
      row.outcome ||
      !input.forecast ||
      at >= contract.expiresAt ||
      (strategy.account.lastAdviceAt !== null &&
        at - strategy.account.lastAdviceAt < state.policy.cadenceMs)
    )
      continue;
    const currentInput = {
      snapshotId: input.id,
      contract,
      forecast: input.forecast,
      book: usableBook(strategy, book),
      portfolio,
      now: at,
      policy: state.policy,
      history: strategy.history,
      lastPlan: strategy.plan,
    };
    const evidence = getAdvisorCandidateEvidence(currentInput);
    const baseline = () => getTradingAdvice({ ...currentInput });
    if (strategy.id === 'incumbent')
      applyAdvice(state, strategy, baseline(), { ...input, contract }, portfolio, 'accepted');
    else if (strategy.id === 'history-rules') {
      const decision = getHistoryRulesDecision(evidence);
      const accepted = validateAdvisorCandidateDecision({
        decision,
        evidence,
        currentInput,
        candidatePolicyVersion: 'history-rules-v1',
        receivedAt: at,
        now: at,
      });
      if (accepted.accepted) {
        strategy.plan = accepted.plan;
        applyAdvice(
          state,
          strategy,
          accepted.advice,
          { ...input, contract },
          portfolio,
          'accepted',
          { ...accepted.plan, action: decision.action },
        );
      } else {
        strategy.vetoCount += 1;
        recordDecision(strategy, {
          status: 'vetoed',
          reason: accepted.reason,
          action: decision?.action,
          assessedAt: at,
        });
        applyAdvice(state, strategy, baseline(), { ...input, contract }, portfolio, 'fallback', {
          fallbackReason: accepted.reason,
        });
      }
    } else if (state.provider.enabled) {
      const pending = strategy.pendingRequest;
      if (
        pending &&
        ((pending.result && pending.result.respondedAt <= at) || at >= pending.evidence.expiresAt)
      ) {
        const result = pending.result;
        const modelChanged =
          result?.model && state.modelIdentity && result.model !== state.modelIdentity;
        const validated =
          result?.status === 'completed' && !modelChanged
            ? validateAdvisorCandidateDecision({
                decision: result.output,
                evidence: pending.evidence,
                currentInput,
                candidatePolicyVersion: 'history-llm-v1',
                receivedAt: result.respondedAt,
                now: at,
              })
            : {
                accepted: false,
                reason: modelChanged
                  ? 'model_identity_changed'
                  : (result?.reason ?? result?.status ?? 'response_expired'),
              };
        if (validated.accepted) {
          state.modelIdentity ??= result.model;
          strategy.plan = validated.plan;
          applyAdvice(
            state,
            strategy,
            validated.advice,
            { ...input, contract },
            portfolio,
            'accepted',
            { ...validated.plan, action: result.output.action, requestId: pending.requestId },
          );
        } else {
          strategy.failureCount += Number(result?.status !== 'completed');
          strategy.vetoCount += Number(result?.status === 'completed');
          recordDecision(strategy, {
            status: 'vetoed',
            action: result?.output?.action ?? null,
            reason: validated.reason,
            assessedAt: at,
            requestId: pending.requestId,
          });
          applyAdvice(state, strategy, baseline(), { ...input, contract }, portfolio, 'fallback', {
            fallbackReason: validated.reason,
          });
        }
        strategy.pendingRequest = null;
      } else if (
        !pending &&
        evidence.available &&
        !evidence.position &&
        evidence.options.length === 1 &&
        evidence.options[0].action === 'NO_TRADE'
      ) {
        // The model cannot change this result. Record the current local plan
        // without paying for a response or consuming the next request interval.
        applyAdvice(
          state,
          strategy,
          evidence.options[0].advice,
          { ...input, contract },
          portfolio,
          'local',
        );
      } else if (
        !pending &&
        evidence.available &&
        evidence.options.length > 0 &&
        (strategy.lastRequestAt === null ||
          at - strategy.lastRequestAt >= state.provider.minimumRequestIntervalMs)
      ) {
        strategy.pendingRequest = {
          requestId: `${state.id}:${input.id}`,
          requestedAt: at,
          evidence,
          result: null,
        };
        strategy.lastRequestAt = at;
        recordDecision(strategy, {
          status: 'pending',
          action: null,
          reason: 'observing_confirmation',
          assessedAt: at,
          snapshotId: input.id,
        });
      } else if (!pending && !evidence.available) {
        // Missing market evidence is resolved locally, without paying for a
        // response that cannot select an executable option.
        applyAdvice(state, strategy, baseline(), { ...input, contract }, portfolio, 'fallback', {
          fallbackReason: evidence.reason,
        });
      }
    }
    strategy.history = [
      ...strategy.history,
      {
        snapshotId: input.id,
        contract,
        forecast: copy(input.forecast),
        book: copy(book),
        portfolio,
        observedAt: at,
        advice: strategy.latestDecision,
        plan: strategy.plan,
      },
    ]
      .filter(
        (item) => isSameKalshiContract(item.contract, contract) && at - item.observedAt <= 180000,
      )
      .slice(-12);
  }
  return state;
}

/** The displayed recommendation and account must come from the same simulated strategy. */
function getStrategyGuidance(state, strategy) {
  const asOf = state.lastObservedAt;
  const account = strategy.account;
  const portfolio = { ...getAdvisorPortfolio(account, asOf), accountVersion: account.version };
  const latest = strategy.latestAdvice ?? null;
  const activity = strategy.recentActivity ?? [];
  const execution =
    latest &&
    activity.find((item) => item.adviceId === latest.id && ['fill', 'no-fill'].includes(item.kind));
  const valuation = strategy.risk?.valuation ?? null;
  const performance = account.performance;
  const decision = strategy.guidanceDecision ?? null;
  const pending = strategy.pendingRequest;
  return {
    accountId: `${state.id}:${strategy.id}`,
    asOf,
    startedAt: state.registeredAt,
    simulated: true,
    experimental: true,
    policy: copy(state.policy),
    portfolio,
    currentPlan: strategy.currentPlan ?? null,
    latestAdvice: latest
      ? {
          ...latest,
          executionStatus: account.pendingIntents.some((intent) => intent.id === latest.id)
            ? 'pending'
            : execution?.kind === 'fill'
              ? 'filled'
              : (execution?.kind ?? null),
        }
      : null,
    recentActivity: activity,
    collector: {
      status: state.lastMarketObservedAt ? 'running' : 'not-started',
      heartbeatAt: state.lastMarketObservedAt ?? null,
    },
    risk: {
      valuation,
      history: strategy.risk?.history ?? null,
      isCurrent: Boolean(
        valuation &&
        valuation.accountVersion === account.version &&
        Number.isFinite(valuation.validUntil) &&
        asOf < valuation.validUntil &&
        valuation.observedAt <= asOf &&
        asOf - valuation.observedAt < 30000,
      ),
    },
    source: {
      kind: decision
        ? decision.status === 'accepted'
          ? 'ai'
          : decision.status === 'local'
            ? 'numerical'
            : 'numerical-fallback'
        : null,
      status: decision?.status ?? null,
      pending: Boolean(pending && !pending.result),
      providerStatus: !state.provider.enabled
        ? 'disabled'
        : (pending?.result?.status ??
          (pending ? 'pending' : (strategy.latestDecision?.status ?? 'configured'))),
      providerReason:
        pending?.result?.reason ??
        strategy.latestDecision?.fallbackReason ??
        state.provider.disabledReason ??
        null,
      decision,
      latestDecision: strategy.latestDecision,
      model: state.modelIdentity ?? state.provider.model,
    },
    performance: {
      ...performance,
      realizationWinCount: performance.winCount,
      realizationLossCount: performance.lossCount,
      realizedPnl: account.realizedPnl,
      totalFees: account.feesPaid,
      inferenceCost: strategy.inferenceCost,
      netProfit: money(account.realizedPnl - strategy.inferenceCost),
      returnOnInitialCapital: account.realizedPnl / state.policy.initialBankroll,
      profitFactor:
        performance.grossLosses > 0 ? performance.grossProfits / performance.grossLosses : null,
      pairedAdvantage: performance.pairedStrategyPnl - performance.pairedHoldPnl,
      pendingComparisonCount: account.pendingComparisons.length,
      adviceAgeMs: latest ? Math.max(0, asOf - latest.evaluatedAt) : null,
    },
  };
}

export function getAdvisorHistoryTrialReport(state) {
  if (!state)
    return {
      status: 'not-started',
      experimental: true,
      requiresExplicitReview: true,
      strategies: [],
    };
  const settled = state.contracts.filter((row) => row.outcome);
  const complete = settled.length === state.rules.confirmationContracts;
  return {
    id: state.id,
    policyId: state.policy.id,
    initialBankroll: state.policy.initialBankroll,
    maxEntryContracts: state.policy.maxEntryContracts ?? null,
    status: complete ? 'awaiting-review' : 'collecting',
    experimental: true,
    enabled: state.provider.enabled,
    provider: {
      enabled: state.provider.enabled,
      status: state.provider.enabled ? 'configured' : 'disabled',
      model: state.provider.model,
      reason: state.provider.disabledReason ?? state.provider.reason ?? null,
    },
    model: state.provider.model,
    promptVersion: state.provider.promptVersion,
    registeredAt: state.registeredAt,
    contractCount: state.contracts.length,
    settledCount: settled.length,
    requiredContracts: state.rules.confirmationContracts,
    requiresExplicitReview: true,
    automaticPromotion: false,
    hypotheses: state.hypotheses,
    recordingGaps: state.recordingGaps,
    strategies: Object.values(state.strategies).map((strategy) => {
      const differences = settled.map(
        (row) =>
          row.scores[strategy.id].netProfit -
          row.scores[strategy.id].inferenceCost -
          row.scores.incumbent.netProfit,
      );
      const mean = differences.length
        ? differences.reduce((sum, value) => sum + value, 0) / differences.length
        : null;
      const standardError =
        differences.length > 1
          ? Math.sqrt(
              differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
                (differences.length - 1) /
                differences.length,
            )
          : null;
      const tradedContracts = settled.filter((row) => row.scores[strategy.id].traded).length;
      const lowerBound = standardError === null ? null : mean - 2.4 * standardError;
      return {
        id: strategy.id,
        accountId: `${state.id}:${strategy.id}`,
        label: {
          incumbent: 'Numerical trial',
          'history-rules': 'History rules',
          'language-model': 'AI candidate',
        }[strategy.id],
        enabled: strategy.id !== 'language-model' || state.provider.enabled,
        cash: strategy.account.cash,
        openPositionCount: strategy.account.positions.length,
        pendingOrderCount: strategy.account.pendingIntents.length,
        pendingComparisonCount: strategy.account.pendingComparisons.length,
        netProfit: money(strategy.account.realizedPnl - strategy.inferenceCost),
        realizedPnl: strategy.account.realizedPnl,
        inferenceCost: strategy.inferenceCost,
        drawdown: strategy.netDrawdown,
        tradingDrawdown: strategy.risk?.history?.maxDrawdown ?? null,
        turnover: strategy.turnover,
        fees: strategy.account.feesPaid,
        actionReversals: strategy.actionReversals,
        averageHoldMs: strategy.exitedQuantity
          ? strategy.heldMilliseconds / strategy.exitedQuantity
          : null,
        missedExits: strategy.missedExits,
        failureCount: strategy.failureCount,
        vetoCount: strategy.vetoCount,
        fillCount: strategy.account.performance.fillCount,
        latestDecision: strategy.latestDecision,
        ...(strategy.id === 'language-model'
          ? { guidance: getStrategyGuidance(state, strategy) }
          : {}),
        tradedContracts,
        pairedProfitLowerBound: lowerBound,
        readyForReview:
          complete &&
          state.recordingGaps === 0 &&
          state.lastObservedAt - state.registeredAt >= state.rules.minimumElapsedMs &&
          tradedContracts >= state.rules.minimumTradedContracts &&
          lowerBound > 0 &&
          strategy.account.realizedPnl > strategy.inferenceCost &&
          strategy.netDrawdown <=
            state.strategies.incumbent.netDrawdown +
              state.policy.initialBankroll * state.rules.maximumAdditionalDrawdownFraction &&
          (strategy.id !== 'language-model' || state.provider.enabled),
      };
    }),
  };
}
