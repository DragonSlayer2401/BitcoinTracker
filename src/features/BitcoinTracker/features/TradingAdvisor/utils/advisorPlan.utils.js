import {
  formatAdvisorMoney,
  getAdvisorReason,
  getAdvisorSideLabel,
  hasFreshAdvisorAdvice,
} from './advisorDisplay.utils';

const operationalReasons = new Set([
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
]);
const sameContract = (left, right) =>
  left &&
  right &&
  left.ticker === right.ticker &&
  left.target === right.target &&
  left.startsAt === right.startsAt &&
  left.expiresAt === right.expiresAt;
const isTime = (value) => Number.isFinite(value) && value > 0;

export const isAdvisorOperationalWait = (advice) =>
  advice?.action === 'wait' && operationalReasons.has(advice.reason);

/** Persist a bounded plan independently of routine execution messages; never extend its evidence. */
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
    previousPlan?.version === 'advisor-plan-v1' &&
    sameContract(advice.contract, previousPlan.contract) &&
    previousPlan.assessedAt <= advice.evaluatedAt &&
    advice.evaluatedAt < previousPlan.validUntil &&
    advice.evaluatedAt - previousPlan.assessedAt < 30000
  )
    return previousPlan;
  const action =
    advice.action === 'sell'
      ? advice.reason === 'reduce_at_better_than_hold_value'
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
      'This assessment expires when its evidence becomes stale or this event closes.',
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
    unavailable: 'Assessment unavailable',
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
  stale: 'Stale assessment',
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
  const accountChanged =
    Number.isSafeInteger(plan?.accountVersion) &&
    Number.isSafeInteger(report?.portfolio?.accountVersion) &&
    plan.accountVersion !== report.portfolio.accountVersion;
  const open = market && market.startsAt <= now && market.expiresAt > now;
  const fresh =
    !isError &&
    plan &&
    matching &&
    !accountChanged &&
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
  } else if (isError) {
    readiness = 'stale';
    explanation =
      'A fresh adviser report or current event is unavailable. Refresh before relying on a suggestion.';
  } else if (!report?.startedAt || report?.collector?.status === 'not-started') {
    readiness = 'confirmation';
    explanation = 'The paper adviser has not started collecting decisions yet.';
  } else if (!open) {
    readiness = 'closed';
    explanation = 'Waiting for the next open Kalshi event.';
  } else if (filled) {
    readiness = 'filled';
    explanation =
      'The last suggestion has a recorded simulated fill. Reassessing the resulting position before another action.';
  } else if (canceled) {
    readiness = 'canceled';
    explanation =
      'The last suggestion did not fill. Its unfilled quantity was canceled; a new assessment is needed.';
  } else if (!fresh) {
    readiness = 'stale';
    explanation = accountChanged
      ? 'The account changed after this assessment. A new position assessment is needed.'
      : plan && !matching
        ? 'The event or target changed. The previous plan does not apply to this market.'
        : plan && now >= plan.validUntil
          ? 'The evidence behind the previous plan expired. A fresh assessment is needed.'
          : 'No fresh assessment is available from the collector. Its previous plan is historical.';
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
  return {
    current,
    historical: !current && plan ? plan : null,
    advice: current?.advice ?? null,
    heading: getAdvisorPlanHeading(current),
    readiness,
    readinessLabel: readinessLabels[readiness],
    explanation: current ? getAdvisorReason(current.reason) : explanation,
    blocker: ['cooldown', 'pending', 'fresh-quote', 'confirmation'].includes(readiness)
      ? getAdvisorReason(reason)
      : current
        ? null
        : explanation,
    completedFill: activity?.kind === 'fill' ? activity : null,
    assessedAt: plan?.assessedAt ?? latest?.evaluatedAt ?? null,
    reviewAt: current?.reviewAt ?? null,
  };
}
