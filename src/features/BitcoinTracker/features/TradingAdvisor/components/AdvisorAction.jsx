import { Alert, Button } from 'react-bootstrap';
import { formatPercent, formatTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorReason,
  getAdvisorSideLabel,
  hasFreshAdvisorAdvice,
} from '../utils/advisorDisplay.utils';

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
  const advice = report?.latestAdvice;
  const isFresh =
    !isError && hasFreshAdvisorAdvice({ advice, collector: report?.collector, market, now });
  const action = isFresh ? advice.action : 'wait';
  const side = isFresh ? getAdvisorSideLabel(advice.side) : '';
  const heading = action === 'wait' ? 'WAIT' : `${action.toUpperCase()} ${side}`;
  const completedFill =
    action === 'wait' && advice?.executionStatus === 'filled'
      ? report?.recentActivity?.find(
          (entry) =>
            entry.kind === 'fill' &&
            entry.adviceId === advice.id &&
            entry.action === advice.action &&
            entry.side === advice.side,
        )
      : null;
  const needsStartup = !report?.startedAt || report?.collector?.status === 'not-started';
  const reason = isError
    ? 'A fresh adviser report or current event is unavailable. Refresh before relying on a suggestion.'
    : isLoading
      ? 'Loading the latest recorded evaluation…'
      : needsStartup
        ? 'The paper adviser has not started collecting decisions yet.'
        : !market
          ? 'Waiting for the next open Kalshi event.'
          : advice?.executionStatus === 'filled'
            ? 'The last suggestion has a recorded simulated fill. Waiting for updated guidance.'
            : advice?.executionStatus === 'no-fill'
              ? 'The last suggestion did not fill. Waiting for a new evaluation.'
              : !isFresh
                ? 'No fresh advice for this event. Waiting for a new collector evaluation.'
                : getAdvisorReason(advice.reason);

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
          {isFresh ? 'Fresh evaluation' : 'Awaiting data'}
        </span>
      </div>
      <div className="advisor-action-call" role="status">
        <h3 className="mb-1">{heading}</h3>
        <p className="small mb-0">{reason}</p>
      </div>
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
            {advice.contract?.ticker} · {formatTime(completedFill.recordedAt)} · Completed paper
            account history. Wait for a new evaluation before considering another action.
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
          {['buy', 'hold'].includes(action) &&
            advice.exitPlan &&
            Number.isFinite(advice.exitPlan.expiresAt) &&
            advice.exitPlan.expiresAt > now && (
              <div className="advisor-exit-plan small">
                <strong className="d-block">Conditional exit plan</strong>
                {action === 'buy' && <span className="d-block">After the entry fills:</span>}
                {Number.isFinite(advice.exitPlan.limitPrice) && (
                  <strong className="d-block">
                    Suggested sell limit:{' '}
                    {formatAdvisorQuantity(advice.exitPlan.quantity ?? advice.quantity)}{' '}
                    {getAdvisorSideLabel(advice.exitPlan.side ?? advice.side)} at{' '}
                    {formatAdvisorMoney(advice.exitPlan.limitPrice)} or better.
                  </strong>
                )}
                <span className="text-secondary d-block">
                  This limit is not placed. Reassess with fresh prices and available buyers; a fill
                  or profit is not guaranteed.
                </span>
              </div>
            )}
        </>
      )}
      {needsStartup && !isLoading && (
        <Alert variant="secondary" className="small mt-3 mb-2">
          Run <code>pnpm research:collect --trading-advisor</code>. Stop an existing collector
          first, then restart with this flag. This page reads its saved results.
        </Alert>
      )}
      <details className="small advisor-assumptions mt-2">
        <summary>Risk limits and assumptions</summary>
        <p className="mb-1 mt-2">
          Keep {formatAdvisorMoney(report?.policy?.cashReserve)} in cash. Cap each position at{' '}
          {formatAdvisorMoney(report?.policy?.maxPositionCost)} and combined open risk at{' '}
          {formatAdvisorMoney(report?.policy?.maxOpenRisk)}.
        </p>
        <p className="mb-1">
          Stop new entries after {formatAdvisorMoney(report?.policy?.maxDailyLoss)} of realized
          losses in a UTC day. Existing positions may add losses.
        </p>
        <p className="text-secondary mb-0">
          Probabilities and expected profit are estimates. Simulated liquidity, fees and slippage
          can differ from real fills. Realized P&amp;L excludes changes in open positions. No
          profitable live strategy has been validated.
        </p>
      </details>
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 small text-secondary mt-auto pt-3">
        <span>Evaluated {formatTime(advice?.evaluatedAt)}</span>
        <Button size="sm" variant="outline-secondary" onClick={onRefresh} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing…' : 'Refresh adviser'}
        </Button>
      </div>
    </section>
  );
}
