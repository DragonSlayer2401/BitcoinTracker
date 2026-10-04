import { Table } from 'react-bootstrap';
import { formatDateTime, formatTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorSideLabel,
  getAdvisorReason,
} from '../utils/advisorDisplay.utils';

const activityLabels = {
  advice: 'Suggestion',
  fill: 'Simulated fill',
  'no-fill': 'No simulated fill',
  settlement: 'Official settlement',
  comparison: 'Hold comparison complete',
};

const activityDescriptions = {
  advice: 'Saved paper suggestion.',
  fill: 'Estimated execution saved.',
  'no-fill': 'The suggestion did not produce a simulated execution.',
  settlement: 'Closed against the official Kalshi result.',
  comparison: 'Completed comparison with holding to settlement.',
};

export default function AdvisorPositions({ portfolio, recentActivity, isStale = false, asOf }) {
  const positions = portfolio?.positions;
  return (
    <section
      className="advisor-positions dashboard-panel"
      aria-labelledby="advisor-positions-heading"
    >
      <div className="d-flex align-items-baseline justify-content-between flex-wrap gap-2 mb-2">
        <h2 id="advisor-positions-heading" className="section-title mb-0">
          Paper positions
        </h2>
        <span className="small text-secondary">
          Automatic experiment · not your Kalshi holdings
        </span>
      </div>
      {isStale && (
        <p className="small text-warning mb-2">
          Last known positions from {formatDateTime(asOf)}. Current quantities may differ.
        </p>
      )}
      {!Array.isArray(positions) ? (
        <p className="small text-secondary mb-0">Position data is unavailable.</p>
      ) : !positions.length ? (
        <p className="small text-secondary mb-0">
          {isStale
            ? 'No open positions were recorded in that snapshot.'
            : 'No open simulated positions. Cash stays available while the adviser waits for a suitable opportunity.'}
        </p>
      ) : (
        <div
          className="advisor-position-scroll"
          role="region"
          aria-label="Open simulated positions"
          tabIndex={0}
        >
          <Table responsive size="sm" className="advisor-position-table small mb-0">
            <caption className="visually-hidden">
              Open paper positions with estimated entry cost and fees
            </caption>
            <thead>
              <tr>
                <th scope="col">Kalshi event</th>
                <th scope="col">Side</th>
                <th scope="col">Quantity</th>
                <th scope="col">{isStale ? 'Last known available' : 'Available to sell'}</th>
                <th scope="col">Average entry</th>
                <th scope="col">Cost incl. fees</th>
                <th scope="col">Entry fees</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => (
                <tr key={position.id}>
                  <th scope="row" className="fw-normal">
                    {position.contract?.ticker ?? 'Unknown event'}
                  </th>
                  <td>{getAdvisorSideLabel(position.side)}</td>
                  <td>{formatAdvisorQuantity(position.quantity)}</td>
                  <td>{formatAdvisorQuantity(position.availableQuantity)}</td>
                  <td>{formatAdvisorMoney(position.averagePrice)}</td>
                  <td>{formatAdvisorMoney(position.costBasis)}</td>
                  <td>{formatAdvisorMoney(position.entryFees)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {recentActivity?.length > 0 && (
        <details className="small mt-2">
          <summary>Recent paper activity</summary>
          <ul className="advisor-activity-list list-unstyled mb-0 mt-2">
            {recentActivity.slice(0, 10).map((entry) => (
              <li key={entry.id} className="py-1 border-top">
                <span className="text-secondary">{formatTime(entry.recordedAt)} · </span>
                <strong>
                  {activityLabels[entry.kind] ?? 'Recorded activity'}
                  {entry.action ? ` · ${entry.action.toUpperCase()}` : ''}{' '}
                  {getAdvisorSideLabel(entry.side)}
                </strong>{' '}
                {Number.isFinite(entry.quantity)
                  ? `· ${formatAdvisorQuantity(entry.quantity)} contracts · `
                  : ''}
                {entry.reason
                  ? getAdvisorReason(entry.reason)
                  : (activityDescriptions[entry.kind] ?? 'Saved in the paper ledger.')}
                {Number.isFinite(entry.realizedPnl) && (
                  <span className="d-block">
                    Realized net P&amp;L: {formatAdvisorMoney(entry.realizedPnl)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
