import { Alert, Table } from 'react-bootstrap';
import { formatDateTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorReason,
} from '../utils/advisorDisplay.utils';

const actionNames = {
  BUY_YES: 'BUY UP',
  BUY_NO: 'BUY DOWN',
  HOLD: 'HOLD',
  REDUCE: 'REDUCE',
  EXIT: 'EXIT',
  NO_TRADE: 'NO TRADE',
};
const outcomeNames = {
  pending: 'Awaiting AI response',
  proposed: 'Proposal recorded; awaiting current market checks',
  accepted: 'Accepted for paper account',
  vetoed: 'Blocked by validation or risk checks',
  fallback: 'Fallback: current rules used',
};

/** Experiments remain visibly separate from the account's current plan and cannot promote themselves. */
export default function AdvisorHistoryTrials({ trials }) {
  const candidates = Array.isArray(trials?.strategies) ? trials.strategies : [];
  const providerDisabled = !trials?.provider || trials.provider.status === 'disabled';
  const hasRecordingProblem = Boolean(trials?.recordingError || trials?.recordingGaps > 0);
  const hasCostDiscrepancy = Boolean(trials?.costDiscrepancy);
  return (
    <section aria-labelledby="advisor-history-trials-heading" className="border-top pt-3 mt-3">
      <h3 id="advisor-history-trials-heading" className="h6">
        Independent paper-trading accounts
      </h3>
      <p className="small mb-2">
        <strong>Simulated trading experiments.</strong> Each policy buys, holds and sells in its own
        paper account. Accepted orders still need a simulated fill; proposals alone do not earn
        money. These accounts do not replace the current adviser. Promotion requires independent
        results and explicit review.
      </p>
      {(hasRecordingProblem || hasCostDiscrepancy) && (
        <Alert variant="warning" className="small py-2 mb-2">
          {hasRecordingProblem && (
            <p className="mb-0">
              Some experiment evidence could not be saved. This comparison is incomplete.
            </p>
          )}
          {hasCostDiscrepancy && (
            <p className="mb-0">
              Inference cost records do not agree. Results need cost reconciliation before review.
            </p>
          )}
        </Alert>
      )}
      <p className="small mb-2" role="status">
        {providerDisabled
          ? 'AI candidate is disabled. It is not being scored as a successful no-trade strategy.'
          : `AI provider: ${trials.provider.model ?? trials.model ?? 'configured model'}. ${getAdvisorReason(trials.provider.reason ?? trials.provider.status)}`}
      </p>
      {Number.isFinite(trials?.contractCount) ? (
        <p className="small text-secondary">
          {formatAdvisorQuantity(trials.settledCount)} of{' '}
          {formatAdvisorQuantity(trials.requiredContracts ?? 120)} required future events settled ·{' '}
          {formatAdvisorQuantity(trials.contractCount)} enrolled. Fewer trades or fewer pauses alone
          do not demonstrate improvement.
        </p>
      ) : (
        <p className="small text-secondary">
          No prospective comparison results are available yet. Restart the paper-adviser collector
          to begin recording the new accounts.
        </p>
      )}
      {candidates.length > 0 && (
        <>
          <Table responsive size="sm" className="small">
            <caption>
              Independent paper accounts with trading fees and inference costs recorded separately.
            </caption>
            <thead>
              <tr>
                <th scope="col">Policy</th>
                <th scope="col">Realized net P&amp;L</th>
                <th scope="col">Drawdown</th>
                <th scope="col">Fills</th>
                <th scope="col">Failures</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((candidate) => {
                const disabled = candidate.id === 'language-model' && providerDisabled;
                return (
                  <tr key={candidate.id}>
                    <th scope="row" className="fw-normal">
                      {candidate.label ?? candidate.id}
                      <span className="d-block small text-secondary">
                        {disabled
                          ? 'Disabled'
                          : (outcomeNames[candidate.latestDecision?.status] ?? 'No decision yet')}
                      </span>
                      {!disabled && (
                        <span className="d-block small text-secondary">
                          {formatAdvisorMoney(candidate.cash)} cash ·{' '}
                          {formatAdvisorQuantity(candidate.openPositionCount)} open ·{' '}
                          {formatAdvisorQuantity(candidate.pendingOrderCount)} pending
                        </span>
                      )}
                    </th>
                    <td>{disabled ? 'Not evaluated' : formatAdvisorMoney(candidate.netProfit)}</td>
                    <td>{disabled ? '—' : formatAdvisorMoney(candidate.drawdown)}</td>
                    <td>{disabled ? '—' : formatAdvisorQuantity(candidate.fillCount)}</td>
                    <td>{disabled ? '—' : formatAdvisorQuantity(candidate.failureCount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {candidates.map((candidate) => {
            const decision = candidate.latestDecision;
            return (
              <details key={candidate.id} className="small mb-2">
                <summary>
                  {candidate.label ?? candidate.id}: evidence and last experimental plan
                </summary>
                <dl className="row g-2 mt-1 mb-2">
                  <div className="col-6">
                    <dt>Trading fees</dt>
                    <dd>{formatAdvisorMoney(candidate.fees)}</dd>
                  </div>
                  <div className="col-6">
                    <dt>Inference cost</dt>
                    <dd>{formatAdvisorMoney(candidate.inferenceCost)}</dd>
                  </div>
                  <div className="col-6">
                    <dt>Turnover</dt>
                    <dd>{formatAdvisorMoney(candidate.turnover)}</dd>
                  </div>
                  <div className="col-6">
                    <dt>Action reversals</dt>
                    <dd>{formatAdvisorQuantity(candidate.actionReversals)}</dd>
                  </div>
                  <div className="col-6">
                    <dt>Average holding time</dt>
                    <dd>
                      {Number.isFinite(candidate.averageHoldMs)
                        ? `${(candidate.averageHoldMs / 60000).toFixed(1)} min`
                        : '—'}
                    </dd>
                  </div>
                  <div className="col-6">
                    <dt>Missed exits</dt>
                    <dd>{formatAdvisorQuantity(candidate.missedExits)}</dd>
                  </div>
                </dl>
                {decision ? (
                  <div className="border rounded p-2">
                    <p className="fw-semibold mb-1">
                      Last recorded experiment:{' '}
                      {actionNames[decision.action] ?? 'No action selected'}
                    </p>
                    <p className="mb-1">
                      {outcomeNames[decision.status] ?? 'Recorded proposal'} ·{' '}
                      {formatDateTime(decision.assessedAt)}
                    </p>
                    <p className="mb-1">
                      {decision.rationale ?? getAdvisorReason(decision.reason)}
                    </p>
                    {decision.fallbackReason && (
                      <p className="mb-1">
                        Why fallback: {getAdvisorReason(decision.fallbackReason)}
                      </p>
                    )}
                    {decision.thesis && (
                      <p className="mb-1">
                        <strong>Trade thesis: </strong>
                        {decision.thesis}
                      </p>
                    )}
                    {Array.isArray(decision.invalidationConditions) &&
                      decision.invalidationConditions.length > 0 && (
                        <p className="mb-1">
                          <strong>Reassess when: </strong>
                          {decision.invalidationConditions.join('; ')}
                        </p>
                      )}
                    <p className="mb-0 text-secondary">
                      Recorded review horizon {formatDateTime(decision.reviewAt)}. Historical
                      experimental output, not a current trade instruction.
                    </p>
                  </div>
                ) : (
                  <p className="text-secondary mb-1">No recorded experimental assessment yet.</p>
                )}
              </details>
            );
          })}
        </>
      )}
    </section>
  );
}
