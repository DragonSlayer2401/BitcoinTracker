import { Alert, Button } from 'react-bootstrap';
import AdvisorSellLimit from './AdvisorSellLimit';
import { formatPercent, formatTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorReason,
  getAdvisorSideLabel,
} from '../utils/advisorDisplay.utils';
import { createAdvisorPlan, getAdvisorPlanState } from '../utils/advisorPlan.utils';

function ActionMetric({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export default function AdvisorAction({
  report,
  market,
  now,
  isLoading,
  isError,
  onRefresh,
  isRefreshing,
}) {
  const planState = getAdvisorPlanState({ report, market, now, isError, isLoading });
  const advice = planState.advice;
  const activePlan = planState.active;
  const applicationConditions = activePlan ? createAdvisorPlan(activePlan.advice) : null;
  const hasStandingExit = ['buy', 'hold'].includes(activePlan?.advice?.action);
  const sellLimitAdvice = hasStandingExit
    ? activePlan.advice
    : advice?.action === 'sell'
      ? advice
      : null;
  const heldPosition = report?.portfolio?.positions?.find(
    (position) => position.id === activePlan?.advice?.positionId,
  );
  const priceCondition = ['buy', 'reduce', 'exit'].includes(activePlan?.action)
    ? applicationConditions?.conditions?.[0]
    : null;
  const isFresh = planState.executionReady;
  const usesRetiredDailyLossRule =
    isFresh &&
    report?.policy?.dailyLossLimitEnabled !== false &&
    ['daily_loss_limit', 'daily_equity_loss_limit'].includes(advice?.reason);
  const action = activePlan?.advice?.action ?? 'wait';
  const side = isFresh ? getAdvisorSideLabel(advice.side) : '';
  const heading = planState.heading;
  const completedFill = planState.completedFill;
  const source = report?.source;
  const needsStartup = !report?.startedAt || report?.collector?.status === 'not-started';
  const reason = usesRetiredDailyLossRule
    ? 'This collector is still using the removed daily-loss rule. Restart it to apply the update.'
    : planState.explanation;

  return (
    <section
      className={`advisor-action dashboard-panel advisor-${action}`}
      aria-labelledby="advisor-action-heading"
    >
      <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
        <h2 id="advisor-action-heading" className="section-title mb-0">
          Current paper guidance
        </h2>
        <span className="small text-secondary">
          {usesRetiredDailyLossRule
            ? 'Collector update needed'
            : isFresh
              ? 'Fresh evaluation'
              : activePlan
                ? 'Plan maintained'
                : 'Awaiting data'}
        </span>
      </div>
      {source && (
        <div className="small mb-2" aria-label="Assessment source">
          <strong>
            {source.kind === 'ai'
              ? activePlan
                ? 'AI plan'
                : 'Last AI assessment'
              : source.kind === 'numerical-fallback'
                ? 'Numerical fallback'
                : source.kind === 'numerical'
                  ? 'Numerical plan'
                  : 'Awaiting AI assessment'}
          </strong>
          {source.model && source.kind !== 'numerical' && (
            <span className="text-secondary"> · {source.model}</span>
          )}
          {(source.pending || source.latestDecision?.status === 'proposed') && (
            <span className="text-secondary"> · Updating</span>
          )}
          {source.kind === 'numerical-fallback' && (
            <p className="mb-1">
              {getAdvisorReason(source.providerReason ?? source.decision?.fallbackReason)}
            </p>
          )}
          {source.kind === 'ai' && !source.pending && source.providerReason && (
            <p className="mb-1" role="status">
              AI update status: {getAdvisorReason(source.providerReason)}.
            </p>
          )}
          {!source.kind && !source.pending && source.providerReason && (
            <p className="mb-1">{getAdvisorReason(source.providerReason)}</p>
          )}
        </div>
      )}
      <div className="advisor-action-call" role="status">
        <span className="small text-secondary d-block mb-1">
          {activePlan ? 'Current plan' : planState.historical ? 'Recorded plan' : 'Plan status'}
        </span>
        <h3 className="mb-1">{heading}</h3>
        {planState.historical && (
          <p className="small text-secondary mb-1">
            Recorded for {planState.historical.contract.ticker} ·{' '}
            {formatTime(planState.historical.assessedAt)}
          </p>
        )}
        <p className="small mb-0">{reason}</p>
        {priceCondition && <p className="small fw-semibold mt-2 mb-0">{priceCondition}</p>}
      </div>
      {sellLimitAdvice && (
        <AdvisorSellLimit
          advice={sellLimitAdvice}
          now={now}
          isStandingPlan={hasStandingExit}
          availableQuantity={heldPosition?.availableQuantity}
        />
      )}
      {activePlan?.action === 'hold' && (
        <p className="small mt-2 mb-0">
          <strong>Loss exit: model-managed.</strong> The next assessment may say REDUCE or EXIT if
          the outlook weakens. No fixed stop order has been placed.
        </p>
      )}
      {planState.updateMessage && (
        <p className="small text-secondary mt-2 mb-1" role="status">
          {planState.updateMessage}
        </p>
      )}
      {activePlan && (
        <details className="small advisor-assumptions mt-2">
          <summary>Plan conditions</summary>
          {(applicationConditions?.conditions ?? [])
            .slice(priceCondition ? 1 : 0)
            .map((condition, index) => (
              <p key={`condition-${index}`} className="mt-2 mb-1">
                {condition}
              </p>
            ))}
          <p className="fw-semibold mt-2 mb-1">What can change the plan:</p>
          <ul className="ps-3 mb-1">
            {(applicationConditions?.invalidationConditions ?? []).map((condition, index) => (
              <li key={index}>{condition}</li>
            ))}
          </ul>
        </details>
      )}
      {activePlan &&
        ['cooldown', 'pending', 'fresh-quote', 'confirmation'].includes(planState.readiness) && (
          <details className="small advisor-assumptions mt-2">
            <summary>Order details</summary>
            <p className="mt-2 mb-1">{planState.readinessLabel}</p>
            {planState.blocker && planState.blocker !== reason && (
              <p className="mb-1">{planState.blocker}</p>
            )}
          </details>
        )}
      {completedFill && (
        <section className="small border rounded p-2 mt-2" aria-label="Last simulated fill">
          <h4 className="h6 mb-1">Last simulated fill</h4>
          <p className="mb-1">
            <strong>
              Completed {completedFill.action.toUpperCase()}{' '}
              {getAdvisorSideLabel(completedFill.side)} ·{' '}
              {formatAdvisorQuantity(completedFill.quantity)} contracts at{' '}
              {formatAdvisorMoney(completedFill.price)} each
            </strong>
          </p>
          <p className="mb-1">
            {completedFill.action === 'buy'
              ? `Recorded entry cost, including fees: ${formatAdvisorMoney(completedFill.totalCost)}.`
              : `Recorded sale proceeds, after fees: ${formatAdvisorMoney(completedFill.netProceeds)}.`}{' '}
            Estimated fill fee: {formatAdvisorMoney(completedFill.fee)}.
          </p>
          <span className="text-secondary d-block">
            {planState.historical?.contract?.ticker} · {formatTime(completedFill.recordedAt)} ·
            Completed paper account history. Wait for a new evaluation before considering another
            action.
          </span>
        </section>
      )}
      {isFresh && action !== 'wait' && (
        <>
          <p className="small text-secondary mt-2 mb-2">
            {side === 'UP'
              ? 'UP = Kalshi Yes · settles at or above target.'
              : 'DOWN = Kalshi No · settles below target.'}
          </p>
          <dl className="advisor-action-values mb-2">
            <ActionMetric
              label={action === 'hold' ? 'Position size' : 'Quantity'}
              value={`${formatAdvisorQuantity(advice.quantity)} contracts`}
            />
            {action !== 'hold' && (
              <ActionMetric
                label={action === 'buy' ? 'Maximum buy price' : 'Minimum sell price'}
                value={formatAdvisorMoney(advice.limitPrice)}
              />
            )}
            {action === 'buy' && (
              <>
                <ActionMetric
                  label="Maximum total cost"
                  value={formatAdvisorMoney(advice.maxCost)}
                />
                <ActionMetric
                  label="Expected profit if held"
                  value={formatAdvisorMoney(advice.expectedNetValue)}
                />
                <ActionMetric
                  label="Profit after caution margin"
                  value={formatAdvisorMoney(advice.conservativeExpectedNetValue)}
                />
              </>
            )}
            {action === 'sell' && (
              <>
                <ActionMetric
                  label="Estimated sale proceeds, net"
                  value={formatAdvisorMoney(advice.expectedProceeds)}
                />
                <ActionMetric
                  label="Sale advantage after caution margin"
                  value={formatAdvisorMoney(advice.conservativeExpectedNetValue)}
                />
              </>
            )}
            {action !== 'buy' && (
              <ActionMetric
                label="Expected settlement payout"
                value={formatAdvisorMoney(advice.holdExpectedValue)}
              />
            )}
            {action === 'hold' && (
              <ActionMetric
                label="Estimated sale proceeds, net"
                value={formatAdvisorMoney(advice.expectedProceeds)}
              />
            )}
            {action !== 'hold' && (
              <ActionMetric label="Estimated fees" value={formatAdvisorMoney(advice.quotedFee)} />
            )}
            <ActionMetric
              label="Model estimate of a win"
              value={formatPercent(advice.probability)}
            />
          </dl>
          {action === 'sell' && (
            <p className="small text-secondary mb-2">
              Sale advantage compares selling with holding. It is not realized profit on the
              position.
            </p>
          )}
          {advice.sizing && (
            <p className="small text-secondary mt-2 mb-0">
              Position size uses a cautious estimate of the opportunity and your remaining account
              risk budget.
            </p>
          )}
        </>
      )}
      {needsStartup && !isLoading && (
        <Alert variant="secondary" className="small mt-3 mb-2">
          Open <strong>Setup</strong> to choose your paper allocation and start collection.
        </Alert>
      )}
      <details className="small advisor-assumptions mt-2">
        <summary>Risk limits and assumptions</summary>
        <p className="mb-1 mt-2">
          Keep {formatAdvisorMoney(report?.policy?.cashReserve)} in cash. Cap each position at{' '}
          {formatAdvisorMoney(report?.policy?.maxPositionCost)} and combined open risk at{' '}
          {formatAdvisorMoney(report?.policy?.maxOpenRisk)}.
        </p>
        {report?.policy?.version === 2 && (
          <p className="mb-1">
            New entries stop at {formatAdvisorMoney(report.policy.maxDrawdown)} of equity drawdown.
            Open and pending BTC exposure uses the same risk budget. Sales and losing trades trigger
            a reentry cooldown.
          </p>
        )}
        <p className="text-secondary mb-0">
          Probabilities and expected profit are estimates. Simulated liquidity, fees and slippage
          can differ from real fills. Realized P&amp;L excludes changes in open positions. No
          profitable live strategy has been validated.
        </p>
      </details>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 small text-secondary mt-auto pt-3">
        <span>Last reviewed {formatTime(planState.assessedAt)}</span>
        <Button size="sm" variant="outline-secondary" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh adviser'}
        </Button>
      </div>
    </section>
  );
}
