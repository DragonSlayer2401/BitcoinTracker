import { Table } from 'react-bootstrap';
import { formatPercent } from '../../utils/format.utils';

const formatBrierScore = (value) => (Number.isFinite(value) ? value.toFixed(3) : '—');

export default function ResearchAccuracyTable({ rows, caption }) {
  return (
    <Table responsive size="sm" className="small">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Scored</th>
          <th scope="col">Accuracy</th>
          <th scope="col">Current side</th>
          <th scope="col">Brier ↓</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.examples ?? 0}</td>
            <td>
              {formatPercent(row.directionalAccuracy)} ({row.directionalCalls ?? 0})
            </td>
            <td>{formatPercent(row.currentSideAccuracy)}</td>
            <td>{formatBrierScore(row.brier)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
