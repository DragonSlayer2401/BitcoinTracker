import { Alert, Table } from 'react-bootstrap';
import useClock from '../../../hooks/useClock';
import { formatDateTime, formatPercent } from '../../../utils/format.utils';

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const formatMoney = (value) => (Number.isFinite(value) ? moneyFormatter.format(value) : '—');
const formatCount = (value) => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');

const decisionLabels = {
  skipped: 'No trade',
  pending: 'Awaiting fill',
  filled: 'Open position',
  'no-fill': 'Not filled',
  settled: 'Settled',
};

const reasonLabels = {
  outside_capture_window: 'The entry checkpoint was missed.',
  forecast_unavailable_or_stale: 'A fresh forecast was unavailable.',
  book_unavailable_or_noncausal: 'A valid order book was unavailable at the decision time.',
  book_unavailable_or_stale: 'The order book was missing or stale.',
  fees_unavailable: 'Current fees could not be verified.',
  portfolio_unavailable: 'Available paper capital could not be verified.',
  daily_loss_limit: 'The daily loss threshold stopped new entries.',
  insufficient_conservative_edge_or_depth: 'Expected profit or displayed liquidity was too low.',
  insufficient_cash: 'Not enough available paper cash.',
  open_risk_limit: 'The trade would exceed the open risk limit.',
  conservative_edge: 'Expected profit met the experiment requirements.',
  execution_window_expired: 'The allowed fill window elapsed.',
  no_causal_execution_book: 'A new order book was unavailable for the fill attempt.',
  execution_book_unavailable: 'The fill attempt had no usable order book.',
  insufficient_execution_depth: 'Not enough displayed liquidity to fill the entire order.',
  limit_price_exceeded: 'The estimated fill price exceeded the saved limit.',
  execution_fees_unavailable: 'Fees could not be verified at the fill attempt.',
  reserved_capital_exceeded: 'The estimated fill cost exceeded reserved paper capital.',
  delayed_snapshot_simulation: 'Estimated fill using a later order book.',
};

function Metric({ label, children }) {
  return (
    <div className="col-6 col-md-4">
      <dt className="small text-secondary fw-normal">{label}</dt>
      <dd className="mb-0 fw-semibold">{children}</dd>
    </div>
  );
}

function PaperPolicy({ policy }) {
  if (!policy) return null;

  return (
    <details className="small mb-3">
      <summary>Experiment assumptions and limits</summary>
      <p className="mt-2 mb-2">
        Policy {policy.id}: one decision per event with {formatCount(policy.checkpointMinutes)}{' '}
        minutes remaining, up to {formatCount(policy.contracts)} contract per trade, held to
        official settlement. Starting simulated bankroll: {formatMoney(policy.initialBankroll)}.
      </p>
      <ul className="mb-2">
        <li>
          Reduce the estimated win probability by{' '}
          {Number.isFinite(policy.probabilityReserve)
            ? (policy.probabilityReserve * 100).toFixed(1)
            : '—'}{' '}
          percentage points before requiring at least {formatMoney(policy.minimumNetEdge)} of
          expected profit per contract after estimated fees and slippage.
        </li>
        <li>
          Check a later order book {formatCount(policy.minimumFillDelayMs / 1000)}–
          {formatCount(policy.maximumFillDelayMs / 1000)} seconds after the decision. Add{' '}
          {formatMoney(policy.slippagePerContract)} per filled contract for slippage. Insufficient
          liquidity or a worse price can leave the order unfilled.
        </li>
        <li>
          Limit open risk to {formatMoney(policy.maxOpenRisk)}. Stop new entries once realized
          losses reach {formatMoney(policy.maxDailyLoss)} in a UTC day; existing positions can add
          further losses. Fees assume a direct Kalshi account; funding and intermediary charges are
          excluded.
        </li>
      </ul>
      <p className="text-secondary mb-0">
        These are fixed experiment settings, not proven optimal thresholds. The probability reserve
        is a caution margin, not a statistically validated confidence bound. This phase measures
        entry and holding to settlement; it does not simulate early exits.
      </p>
    </details>
  );
}

function RecentDecisions({ decisions }) {
  if (!decisions?.length) return null;

  return (
    <section aria-labelledby="paper-decisions-heading">
      <h3 id="paper-decisions-heading" className="h6">
        Recent decisions
      </h3>
      <Table responsive size="sm" className="small align-middle mb-0">
        <caption className="visually-hidden">
          Recent paper trade decisions, estimated fills and realized results in US dollars
        </caption>
        <thead>
          <tr>
            <th scope="col">Event / decision</th>
            <th scope="col">Status</th>
            <th scope="col">Side</th>
            <th scope="col">Filled / requested</th>
            <th scope="col">Average fill</th>
            <th scope="col">Fees</th>
            <th scope="col">Expected net</th>
            <th scope="col">Realized net</th>
          </tr>
        </thead>
        <tbody>
          {decisions.map((decision) => (
            <tr key={decision.id}>
              <th scope="row" className="fw-normal text-break">
                {decision.marketTicker}
                <span className="d-block text-secondary">{formatDateTime(decision.decidedAt)}</span>
              </th>
              <td>
                {decisionLabels[decision.status] ?? 'Unknown'}
                {decision.reason && (
                  <span className="d-block text-secondary">
                    {reasonLabels[decision.reason] ?? decision.reason.replaceAll('_', ' ')}
                  </span>
                )}
              </td>
              <td>{decision.side ? decision.side.toUpperCase() : '—'}</td>
              <td>
                {formatCount(decision.filledQuantity)} / {formatCount(decision.quantity)}
              </td>
              <td>{formatMoney(decision.averageFillPrice)}</td>
              <td>{formatMoney(decision.fees)}</td>
              <td>{formatMoney(decision.expectedNetValue)}</td>
              <td>{formatMoney(decision.realizedPnl)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

export default function PaperTradingReport({ report }) {
  const now = useClock();
  const { summary, collector, policy } = report;
  const heartbeatAt = collector?.heartbeatAt;
  const hasRecentHeartbeat =
    Number.isFinite(heartbeatAt) &&
    Number.isFinite(now) &&
    heartbeatAt <= now &&
    now - heartbeatAt <= 30_000;
  const collectorLabel =
    collector?.status === 'running'
      ? hasRecentHeartbeat
        ? 'Collecting paper decisions · recent heartbeat'
        : 'Collector heartbeat stale · collection not confirmed'
      : collector?.status === 'error'
        ? 'Collector reported an error'
        : collector?.status === 'stopped'
          ? 'Collector stopped'
          : 'Paper collection not started';
  const hasSettledTrades = Number.isFinite(summary?.settledCount) && summary.settledCount > 0;

  return (
    <>
      <p role="status" className="small mb-1">
        {collectorLabel}
      </p>
      <p className="small text-secondary mb-3">
        Last collector heartbeat: {formatDateTime(heartbeatAt)}. Report as of{' '}
        {formatDateTime(report.asOf)}. Experiment started {formatDateTime(report.startedAt)}.
      </p>
      {collector?.status !== 'running' || !hasRecentHeartbeat ? (
        <Alert variant="secondary" className="small">
          To collect prospective paper trades, run{' '}
          <code>pnpm research:collect --paper-trading</code> from the project folder. If a research
          collector is already running, stop it first and restart with this flag. Opening this
          report does not start collection.
        </Alert>
      ) : null}
      {summary ? (
        <>
          <section aria-labelledby="paper-bankroll-heading" className="mb-3">
            <h3 id="paper-bankroll-heading" className="h6">
              Simulated bankroll
            </h3>
            <dl className="row g-3 mb-2">
              <Metric label="Starting bankroll">{formatMoney(summary.initialBankroll)}</Metric>
              <Metric label="Available cash">{formatMoney(summary.cash)}</Metric>
              <Metric label="Reserved capital">{formatMoney(summary.reservedCapital)}</Metric>
              <Metric label="Open risk">{formatMoney(summary.openRisk)}</Metric>
              <Metric label="Realized net profit / loss">{formatMoney(summary.realizedPnl)}</Metric>
              <Metric label="Daily realized profit / loss (UTC)">
                {formatMoney(summary.dailyRealizedPnl)}
              </Metric>
              <Metric label="Return on starting capital">
                {hasSettledTrades ? formatPercent(summary.returnOnInitialCapital) : '—'}
              </Metric>
              <Metric label="Largest realized drawdown">
                {hasSettledTrades ? formatMoney(summary.maxRealizedDrawdown) : '—'}
              </Metric>
              <Metric label="Average net profit per settled trade">
                {hasSettledTrades ? formatMoney(summary.averageProfit) : '—'}
              </Metric>
            </dl>
            <p className="small text-secondary mb-0">
              Realized results and drawdown exclude changes in the market value of open positions.
              {summary.equityLimitation ? ` ${summary.equityLimitation}` : ''}
            </p>
          </section>
          <section aria-labelledby="paper-evaluation-heading" className="mb-3">
            <h3 id="paper-evaluation-heading" className="h6">
              Prospective results
            </h3>
            <dl className="row g-3 mb-2">
              <Metric label="Decisions">{formatCount(summary.decisionCount)}</Metric>
              <Metric label="No trade decisions">{formatCount(summary.skippedCount)}</Metric>
              <Metric label="Trade intents">{formatCount(summary.intentCount)}</Metric>
              <Metric label="Filled trades">{formatCount(summary.fillCount)}</Metric>
              <Metric label="Unfilled trades">{formatCount(summary.noFillCount)}</Metric>
              <Metric label="Awaiting fill">{formatCount(summary.pendingIntentCount)}</Metric>
              <Metric label="Open positions awaiting settlement">
                {formatCount(summary.openPositionCount)}
              </Metric>
              <Metric label="Settled trades">{formatCount(summary.settledCount)}</Metric>
              <Metric label="Trade coverage">{formatPercent(summary.tradeCoverage)}</Metric>
              <Metric label="Settled wins / losses">
                {formatCount(summary.winCount)} / {formatCount(summary.lossCount)}
              </Metric>
              <Metric label="Settled win rate">
                {hasSettledTrades ? formatPercent(summary.winRate) : '—'}
              </Metric>
              <Metric label="Profit factor">
                {hasSettledTrades && Number.isFinite(summary.profitFactor)
                  ? summary.profitFactor.toFixed(2)
                  : '—'}
              </Metric>
            </dl>
            <p className="small text-secondary mb-2">
              Coverage is the share of recorded decisions that filled. Profit factor compares
              realized gains with realized losses; it is unavailable until there are losses.
            </p>
            {!hasSettledTrades ? (
              <p className="small mb-0">
                No settled trades yet. Profitability has not been measured.
              </p>
            ) : (
              <p className="small mb-0">
                For the same {formatCount(summary.settledCount)} settled trades: expected net{' '}
                {formatMoney(summary.expectedNetValue)}, cautious expected net{' '}
                {formatMoney(summary.conservativeExpectedNetValue)}, realized net{' '}
                {formatMoney(summary.actualNetPnl)}. These paper results do not establish a
                profitable live strategy.
              </p>
            )}
          </section>
          {summary.decisionCount === 0 && (
            <p className="small">
              No paper decisions recorded yet. Earlier forecast research is not treated as simulated
              trade history.
            </p>
          )}
        </>
      ) : (
        <Alert variant="warning">Paper trading totals are unavailable.</Alert>
      )}
      <PaperPolicy policy={policy} />
      <RecentDecisions decisions={summary?.recentDecisions} />
    </>
  );
}
