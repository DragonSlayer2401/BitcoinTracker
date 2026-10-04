import { Table } from 'react-bootstrap';
import { formatAdvisorMoney } from '../utils/advisorDisplay.utils';

const strategies = {
  standard: 'Standard rules',
  'selective-entry': 'More selective entries',
  'early-exit': 'Earlier exits',
  'cautious-sizing': 'Smaller positions',
};
const phases = {
  'not-started': 'Start collection with the new setup to begin.',
  collecting: 'Collecting future results',
  active: 'A tested strategy is active',
  rejected: 'Standard rules retained: no candidate passed',
  'rolled-back': 'Standard rules restored after deterioration',
};
const reasons = {
  fixed_sample_incomplete: 'Waiting for the fixed event sample',
  minimum_observation_time: 'Needs more elapsed observation time',
  too_few_candidate_trades: 'Too few candidate trades',
  too_few_baseline_trades: 'Too few baseline trades',
  insufficient_observed_fills: 'Too few observed fills',
  candidate_not_profitable: 'Not profitable after costs',
  paired_profit_advantage_unproven: 'Profit improvement is not established',
  additional_drawdown_too_large: 'Larger drawdown than allowed',
};
const percent = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—');

export default function AdvisorStrategyTrials({ trials }) {
  return (
    <section aria-labelledby="advisor-trials-heading" className="border-top pt-3 mt-3">
      <h3 id="advisor-trials-heading" className="h6">
        Are trading decisions improving profits?
      </h3>
      <p className="small mb-1">
        <strong>In use: {strategies[trials?.activeStrategyId] ?? 'Standard rules'}</strong>
      </p>
      <p className="small" role="status">
        {phases[trials?.phase ?? 'not-started'] ?? 'Awaiting trial status'}
      </p>
      {trials?.rules && (
        <>
          <p className="small">
            {trials.resolvedContracts} of {trials.rules.confirmationContracts} fixed future events
            resolved. {trials.enrolledContracts} enrolled. Missing outcomes stay pending.
          </p>
          <Table responsive size="sm" className="small">
            <caption>
              Independent paper strategies, measured after fees and simulated fills.
            </caption>
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Net P&amp;L</th>
                <th scope="col">Vs. standard</th>
                <th scope="col">Events traded</th>
              </tr>
            </thead>
            <tbody>
              {trials.candidates.map((candidate) => (
                <tr key={candidate.strategyId}>
                  <th scope="row" className="fw-normal">
                    {strategies[candidate.strategyId]}
                  </th>
                  <td>{formatAdvisorMoney(candidate.candidateProfit)}</td>
                  <td>{formatAdvisorMoney(candidate.pairedAdvantage)}</td>
                  <td>
                    {candidate.candidateTradedContracts} ({percent(candidate.candidateCallCoverage)}
                    )
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <details className="small mb-2">
            <summary>Why each strategy has or has not qualified</summary>
            <ul className="ps-3 mt-2">
              {trials.candidates.map((candidate) => (
                <li key={candidate.strategyId} className="mb-2">
                  <strong>{strategies[candidate.strategyId]}: </strong>
                  {candidate.eligible
                    ? 'Passed its frozen confirmation checks.'
                    : candidate.reasons
                        .map((reason) => reasons[reason] ?? reason.replaceAll('_', ' '))
                        .join('; ')}{' '}
                  Observed fills: {percent(candidate.candidateFillCoverage)}. Sampled drawdown:{' '}
                  {formatAdvisorMoney(candidate.candidateDrawdown)}.
                </li>
              ))}
            </ul>
          </details>
          <p className="small text-secondary">
            Candidates must be profitable, improve on the baseline, trade enough events, and stay
            within risk limits. Future results are monitored; deterioration restores standard rules
            without resetting this account. Forecast-model learning runs separately.
          </p>
          <p className="small text-secondary mb-0">{trials.statisticalAssumption}</p>
        </>
      )}
    </section>
  );
}
