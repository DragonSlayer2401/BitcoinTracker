import {
  formatAdvisorMoney,
  getAdvisorReason,
  getAdvisorSideLabel,
  hasFreshAdvisorAdvice,
} from './advisorDisplay.utils';

export const ADVISOR_OPERATIONAL_REASONS = [
  'pending_execution',
  'position_already_reserved',
  'loss_cooldown',
  'reentry_cooldown',
  'forecast_unavailable_or_stale',
  'book_unavailable_or_noncausal',
  'book_unavailable_or_stale',
  'crossed_book',
  'fees_unavailable',
  'risk_valuation_unavailable_or_stale',
  'portfolio_unavailable',
  'observing_confirmation',
  'outside_active_contract',
];
const operationalReasons = new Set(ADVISOR_OPERATIONAL_REASONS);
const sameContract = (left, right) =>
  left &&
  right &&
  left.ticker === right.ticker &&
  left.target === right.target &&
  left.startsAt === right.startsAt &&
  left.expiresAt === right.expiresAt;
const isTime = (value) => Number.isFinite(value) && value > 0;
const planReviewCondition =
  'Keep this plan until a new assessment replaces it, an order completes, the position changes or this event ends. Prices are checked again before an order.';

export const isAdvisorOperationalWait = (advice) =>
  advice?.action === 'wait' && operationalReasons.has(advice.reason);

export const isMeaningfulAdvisorPlan = (plan) =>
  plan?.version === 'advisor-plan-v1' &&
  ['buy', 'hold', 'reduce', 'exit', 'no-trade'].includes(plan.action);

/** Preserve the strategy through routine waits without renewing its original order evidence. */
export function createAdvisorPlan(advice, previousPlan = null) {
  if (
    !advice ||
    !['buy', 'sell', 'hold', 'wait'].includes(advice.action) ||
    !isTime(advice.evaluatedAt) ||
    !advice.contract
  )
    return null;
  if (
    isAdvisorOperationalWait(advice) &&
    isMeaningfulAdvisorPlan(previousPlan) &&
    previousPlan.assessedAt <= advice.evaluatedAt
  )
    return previousPlan;
  const action =
    advice.action === 'sell'
      ? ['reduce_at_better_than_hold_value', 'candidate_reduce_thesis'].includes(advice.reason)
        ? 'reduce'
        : 'exit'
      : advice.action === 'wait'
        ? isAdvisorOperationalWait(advice)
          ? 'unavailable'
          : 'no-trade'
        : advice.action;
  const validUntil = Math.min(
    advice.evaluatedAt + 30000,
    isTime(advice.validUntil) ? advice.validUntil : advice.evaluatedAt + 30000,
    advice.contract.expiresAt,
  );
  const fields = [
    'id',
    'contract',
    'action',
    'side',
    'quantity',
    'positionId',
    'accountVersion',
    'evaluatedAt',
    'validUntil',
    'reason',
    'limitPrice',
    'maxCost',
    'expectedNetValue',
    'conservativeExpectedNetValue',
    'quotedFee',
    'probability',
    'expectedProceeds',
    'holdExpectedValue',
    'exitPlan',
    'sizing',
  ];
  const conditions =
    advice.action === 'buy' && Number.isFinite(advice.limitPrice)
      ? [
          `Buy ${getAdvisorSideLabel(advice.side)} only at ${formatAdvisorMoney(advice.limitPrice)} or less, with fresh prices and unchanged risk checks.`,
        ]
      : advice.action === 'sell' && Number.isFinite(advice.limitPrice)
        ? [
            `Sell only at ${formatAdvisorMoney(advice.limitPrice)} or better while the sale still improves the expected result after costs.`,
          ]
        : advice.action === 'hold'
          ? ['Keep holding while the updated evidence still supports this position after costs.']
          : [];
  return {
    version: 'advisor-plan-v1',
    policyId: advice.policyId ?? null,
    adviceId: advice.id,
    contract: advice.contract,
    action,
    side: advice.side ?? null,
    reason: advice.reason,
    assessedAt: advice.evaluatedAt,
    validUntil,
    reviewAt: Math.min(validUntil, advice.evaluatedAt + 15000),
    conditions,
    invalidationConditions: [
      'Reassess if the probability, executable price, fees or available position changes.',
      planReviewCondition,
    ],
    advice: Object.fromEntries(
      fields.filter((field) => advice[field] !== undefined).map((field) => [field, advice[field]]),
    ),
  };
}

export function getAdvisorPlanHeading(plan) {
  const side = getAdvisorSideLabel(plan?.side);
  const names = {
    buy: 'BUY',
    'conditional-buy': 'BUY IF',
    hold: 'HOLD',
    reduce: 'REDUCE',
    exit: 'EXIT',
    'no-trade': 'NO TRADE',
    unavailable: 'Awaiting first assessment',
  };
  const name = names[plan?.action] ?? names.unavailable;
  if (plan?.action === 'conditional-buy') return `BUY ${side} IF…`;
  return side && !['no-trade', 'unavailable'].includes(plan?.action) ? `${name} ${side}` : name;
}

const readinessLabels = {
  ready: 'Ready',
  'fresh-quote': 'Awaiting fresh quote',
  confirmation: 'Observing confirmation',
  pending: 'Pending paper order',
  cooldown: 'Cooldown',
  filled: 'Filled',
  canceled: 'Canceled',
  stale: 'Checking current prices',
  closed: 'Event closed',
};

/** Display states are not order permissions. The collector still owns execution and all limits. */
export function getAdvisorPlanState({ report, market, now, isError = false, isLoading = false }) {
  const latest = report?.latestAdvice;
  const plan =
    report?.currentPlan?.version === 'advisor-plan-v1'
      ? report.currentPlan
      : createAdvisorPlan(latest);
  const advice = plan?.advice ?? latest;
  const sourceId = plan?.adviceId ?? latest?.id;
  const activity = report?.recentActivity?.find(
    (item) =>
      Boolean(sourceId) &&
      item.adviceId === sourceId &&
      ['fill', 'no-fill'].includes(item.kind) &&
      item.recordedAt <= now,
  );
  const executionStatus = latest?.id === sourceId ? latest?.executionStatus : null;
  const filled =
    activity?.kind === 'fill' ||
    executionStatus === 'filled' ||
    (Boolean(sourceId) &&
      report?.portfolio?.positions?.some((position) => position.entryAdviceId === sourceId));
  const canceled = activity?.kind === 'no-fill' || executionStatus === 'no-fill';
  const matching = sameContract(plan?.contract, market);
  const assessedAccountVersion = plan?.accountVersion ?? advice?.accountVersion;
  const accountChanged =
    Number.isSafeInteger(assessedAccountVersion) &&
    Number.isSafeInteger(report?.portfolio?.accountVersion) &&
    assessedAccountVersion !== report.portfolio.accountVersion;
  const policyChanged = Boolean(
    plan?.policyId && report?.policy?.id && plan.policyId !== report.policy.id,
  );
  const open = market && market.startsAt <= now && market.expiresAt > now;
  const position = report?.portfolio?.positions?.find((item) => item.id === advice?.positionId);
  const positionChanged = Boolean(
    advice?.positionId &&
    Array.isArray(report?.portfolio?.positions) &&
    (!position ||
      position.quantity <= 0 ||
      position.side !== plan.side ||
      (Number.isFinite(advice.quantity) && position.quantity < advice.quantity)),
  );
  const fresh =
    !isError &&
    plan &&
    matching &&
    !accountChanged &&
    !policyChanged &&
    !positionChanged &&
    !plan.historicalOnly &&
    now < plan.validUntil &&
    hasFreshAdvisorAdvice({
      advice: { ...advice, executionStatus: null },
      collector: report?.collector,
      market,
      now,
    });
  const reason = latest?.reason;
  const cooldown =
    ['loss_cooldown', 'reentry_cooldown'].includes(reason) ||
    (isTime(report?.cooldownUntil) && now < report.cooldownUntil);
  let readiness = 'ready';
  let explanation = getAdvisorReason(plan?.reason ?? reason);
  if (isLoading) {
    readiness = 'confirmation';
    explanation = 'Loading the latest recorded assessment.';
  } else if (!report?.startedAt || report?.collector?.status === 'not-started') {
    readiness = 'confirmation';
    explanation = 'The paper adviser has not started collecting decisions yet.';
  } else if (market && !open) {
    readiness = 'closed';
    explanation = 'Waiting for the next open Kalshi event.';
  } else if (filled) {
    readiness = 'filled';
    explanation = 'The paper order filled. Reviewing the resulting position for the next plan.';
  } else if (canceled) {
    readiness = 'canceled';
    explanation =
      'The paper order did not fill. Its remaining quantity was canceled; reviewing the next opportunity.';
  } else if (!fresh) {
    readiness = 'stale';
    explanation =
      policyChanged || positionChanged
        ? 'Reviewing the changed account before choosing the next plan.'
        : plan && market && !matching
          ? 'Reviewing the new event and its target.'
          : 'Checking current prices and account limits before another paper order.';
  } else if (cooldown) {
    readiness = 'cooldown';
  } else if (
    executionStatus === 'pending' ||
    report?.portfolio?.pendingIntents?.some((intent) => intent.id === sourceId) ||
    reason === 'pending_execution' ||
    reason === 'position_already_reserved'
  ) {
    readiness = 'pending';
  } else if (reason === 'observing_confirmation') {
    readiness = 'confirmation';
  } else if (isAdvisorOperationalWait(latest)) {
    readiness = 'fresh-quote';
  }
  let current =
    fresh && !isLoading && !filled && !canceled && plan.action !== 'unavailable' ? plan : null;
  if (current?.action === 'buy' && ['fresh-quote', 'confirmation'].includes(readiness)) {
    current = { ...current, action: 'conditional-buy' };
  }
  const recorded = isMeaningfulAdvisorPlan(plan) && plan.assessedAt <= now ? plan : null;
  // A quote timeout is an execution boundary, not a change of strategy. Account
  // versions also advance on routine WAIT/HOLD writes, so only changed positions
  // or configuration invalidate the ongoing plan here. Exact versions still gate orders.
  let lifecycle = 'awaiting';
  if (recorded) {
    if (market && !matching) lifecycle = 'changed-event';
    else if (now >= recorded.contract.expiresAt) lifecycle = 'closed';
    else if (filled) lifecycle = 'filled';
    else if (canceled) lifecycle = 'canceled';
    else if (policyChanged || positionChanged) lifecycle = 'changed-account';
    else if (now >= recorded.contract.startsAt) lifecycle = 'active';
  }
  const active =
    lifecycle === 'active'
      ? {
          ...recorded,
          // Apply updated wording to older saved plans without rewriting their evidence.
          invalidationConditions: (recorded.invalidationConditions ?? []).map((condition) =>
            condition ===
            'This assessment expires when its evidence becomes stale or this event closes.'
              ? planReviewCondition
              : condition,
          ),
        }
      : null;
  const displayed = active ?? recorded;
  const side = getAdvisorSideLabel(recorded?.side);
  const completionHeading =
    recorded?.action === 'buy'
      ? `${side} PURCHASED`
      : recorded?.action === 'reduce'
        ? `${side} REDUCED`
        : `${side} SOLD`;
  const lifecycleHeadings = {
    filled: completionHeading,
    canceled: 'ORDER NOT FILLED',
    closed: 'EVENT ENDED',
    'changed-event': 'REVIEWING NEW EVENT',
    'changed-account': 'REVIEWING ACCOUNT',
    awaiting: 'Awaiting first assessment',
  };
  const lifecycleExplanations = {
    filled: 'The paper order filled. Reviewing the resulting position for the next plan.',
    canceled:
      'The paper order did not fill. Its remaining quantity was canceled; reviewing the next opportunity.',
    closed: 'This event has ended. Waiting for its official result and the next event.',
    'changed-event': 'Reviewing the new event and its target.',
    'changed-account': 'The position or account settings changed. Reviewing the next plan.',
  };
  const interrupted =
    isError ||
    !market ||
    report?.collector?.status !== 'running' ||
    !isTime(report?.collector?.heartbeatAt) ||
    report.collector.heartbeatAt > now ||
    now - report.collector.heartbeatAt >= 30000;
  const updateMessage = active
    ? interrupted
      ? 'Updates interrupted · keeping the current plan'
      : isLoading
        ? 'Updating prices · plan unchanged'
        : !current
          ? 'Plan unchanged · checking current prices'
          : null
    : null;
  return {
    active,
    lifecycle,
    executionReady: Boolean(current),
    updateMessage,
    current,
    displayed,
    historical: !active ? displayed : null,
    previousEvent: Boolean(displayed && market && !matching),
    advice: current?.advice ?? null,
    heading: active ? getAdvisorPlanHeading(active) : lifecycleHeadings[lifecycle],
    readiness,
    readinessLabel: readinessLabels[readiness],
    explanation: active
      ? getAdvisorReason(active.reason)
      : (lifecycleExplanations[lifecycle] ?? explanation),
    blocker: ['cooldown', 'pending', 'fresh-quote', 'confirmation'].includes(readiness)
      ? getAdvisorReason(reason)
      : current
        ? null
        : explanation,
    completedFill: activity?.kind === 'fill' ? activity : null,
    assessedAt: displayed?.assessedAt ?? null,
    reviewAt: active?.reviewAt ?? null,
  };
}
