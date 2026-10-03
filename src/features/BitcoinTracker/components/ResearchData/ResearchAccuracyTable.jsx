import { Table } from 'react-bootstrap';
import { formatPercent } from '../../utils/format.utils';

const formatBrierScore = (value) => (Number.isFinite(value) ? value.toFixed(3) : '—');
const formatExtraCorrect = (value) =>
  Number.isInteger(value) ? `${value > 0 ? '+' : ''}${value}` : '—';
const formatCount = (count, total) =>
  Number.isInteger(count) && Number.isInteger(total) ? `${count} / ${total}` : '—';

export default function ResearchAccuracyTable({ rows, caption }) {
  return (
    <Table responsive size="sm" className="small">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Scored</th>
          <th scope="col">Accuracy</th>
          <th scope="col">Current side, same calls</th>
          <th scope="col">Extra correct calls</th>
          <th scope="col">Reversals caught</th>
          <th scope="col">False reversal warnings</th>
          <th scope="col">Brier ↓</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const paired = row.currentSideComparison;
          return (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.examples ?? 0}</td>
              <td>
                {formatPercent(paired ? paired.modelAccuracy : row.directionalAccuracy)} (
                {paired?.examples ?? row.directionalCalls ?? 0})
              </td>
              <td>
                {formatPercent(paired?.currentSideAccuracy)} ({paired?.examples ?? 0})
              </td>
              <td>{formatExtraCorrect(paired?.additionalCorrect)}</td>
              <td>{formatCount(row.reversalsCaught, row.reversals)}</td>
              <td>{formatCount(row.falseReversalWarnings, row.reversalAlerts)}</td>
              <td>{formatBrierScore(row.brier)}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
