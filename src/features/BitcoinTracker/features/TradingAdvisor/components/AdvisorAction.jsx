import { Alert, Button } from 'react-bootstrap';
import AdvisorSellLimit from './AdvisorSellLimit';
import { formatPercent, formatTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorSideLabel,
} from '../utils/advisorDisplay.utils';
import { getAdvisorPlanHeading, getAdvisorPlanState } from '../utils/advisorPlan.utils';

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
  const isFresh = Boolean(planState.current);
  const usesRetiredDailyLossRule =
    isFresh &&
    report?.policy?.dailyLossLimitEnabled !== false &&
    ['daily_loss_limit', 'daily_equity_loss_limit'].includes(advice?.reason);
  const action = isFresh ? advice.action : 'wait';
  const side = isFresh ? getAdvisorSideLabel(advice.side) : '';
  const heading = planState.heading;
  const completedFill = planState.completedFill;
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
              : 'Awaiting data'}
        </span>
      </div>
      <div className="advisor-action-call" role="status">
        <span className="small text-secondary d-block mb-1">Current plan</span>
        <h3 className="mb-1">{heading}</h3>
        <p className="small mb-0">{reason}</p>
      </div>
      <div className="advisor-readiness d-flex align-items-baseline flex-wrap gap-2 small mt-2">
        <span className="text-secondary">Execution status</span>
        <strong>{planState.readinessLabel}</strong>
      </div>
      {planState.blocker && planState.blocker !== reason && (
        <p className="small mt-1 mb-1">
          <strong>Waiting on: </strong>
          {planState.blocker}
        </p>
      )}
      {planState.historical && (
        <p className="small text-secondary mt-2 mb-1">
          Previous plan (historical): <strong>{getAdvisorPlanHeading(planState.historical)}</strong>
          {' · '}
          {formatTime(planState.historical.assessedAt)}. This is not a current instruction.
        </p>
      )}
      {planState.current?.action === 'conditional-buy' && (
        <p className="small mt-2 mb-1">{planState.current.conditions[0]}</p>
      )}
      {planState.current && (
        <details className="small advisor-assumptions mt-2">
          <summary>Plan conditions and invalidation</summary>
          {planState.current.conditions
            .slice(planState.current.action === 'conditional-buy' ? 1 : 0)
            .map((condition, index) => (
              <p key={`condition-${index}`} className="mt-2 mb-1">
                {condition}
              </p>
            ))}
          <p className="fw-semibold mt-2 mb-1">Reassess this plan when:</p>
          <ul className="ps-3 mb-1">
            {planState.current.invalidationConditions.map((condition, index) => (
              <li key={index}>{condition}</li>
            ))}
          </ul>
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
          <AdvisorSellLimit advice={advice} now={now} />
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
        <span>
          Last assessment {formatTime(planState.assessedAt)}
          <span className="d-block">
            Next review{' '}
            {planState.reviewAt ? formatTime(planState.reviewAt) : 'awaiting fresh assessment'}
          </span>
        </span>
        <Button size="sm" variant="outline-secondary" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh adviser'}
        </Button>
      </div>
    </section>
  );
}
