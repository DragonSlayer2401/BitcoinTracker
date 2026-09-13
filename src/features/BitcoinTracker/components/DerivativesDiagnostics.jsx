import { Table } from 'react-bootstrap';
import { formatPercent } from '../utils/format.utils';

const quantity = (value) => (Number.isFinite(value) ? value.toFixed(3) : '—');

export default function DerivativesDiagnostics({ snapshot, adjustment }) {
  if (!snapshot && !adjustment) return null;
  const hasFreshInputs = adjustment?.available === true;
  return (
    <section aria-labelledby="futures-detail-heading" className="mb-4">
      <h3 id="futures-detail-heading" className="h6">
        Bitcoin futures pressure
      </h3>
      <p className="small">
        Bybit BTCUSDT perpetual · {snapshot?.status ?? 'unavailable'}.{' '}
        {adjustment?.applied
          ? 'Futures activity is influencing this estimate.'
          : (adjustment?.reason ?? 'Gathering futures executions and price response.')}
      </p>
      {adjustment?.applied && (
        <p className="small">
          Before futures Yes: <strong>{formatPercent(adjustment.baselineAboveProbability)}</strong>{' '}
          · After futures Yes: <strong>{formatPercent(adjustment.aboveProbability)}</strong> (
          {adjustment.adjustmentPercentagePoints >= 0 ? '+' : ''}
          {adjustment.adjustmentPercentagePoints.toFixed(2)} percentage points). This adjustment is
          part of the current calculation, before any learned correction.
        </p>
      )}
      <Table responsive size="sm" className="small">
        <caption>
          Executed futures BTC at this venue. Large trades are measured relative to earlier
          activity. Liquidations describe forced position closures reported by Bybit; they are not
          added to executed volume again.
        </caption>
        <thead>
          <tr>
            <th scope="col">Window</th>
            <th scope="col">Buy BTC</th>
            <th scope="col">Sell BTC</th>
            <th scope="col">Large buy BTC</th>
            <th scope="col">Large sell BTC</th>
            <th scope="col">Long liquidations BTC</th>
            <th scope="col">Short liquidations BTC</th>
          </tr>
        </thead>
        <tbody>
          {[15, 60, 180].map((seconds) => {
            const flow = snapshot?.windows?.[seconds];
            const liquidations = snapshot?.liquidations?.windows?.[seconds];
            const canShowFlow = hasFreshInputs && flow?.available;
            const canShowLiquidations =
              hasFreshInputs && snapshot?.liquidations?.available && liquidations?.available;
            return (
              <tr key={seconds}>
                <th scope="row">{seconds}s</th>
                <td>{canShowFlow ? quantity(flow.buyBtc) : '—'}</td>
                <td>{canShowFlow ? quantity(flow.sellBtc) : '—'}</td>
                <td>
                  {canShowFlow && flow.largeTradesAvailable ? quantity(flow.largeBuyBtc) : '—'}
                </td>
                <td>
                  {canShowFlow && flow.largeTradesAvailable ? quantity(flow.largeSellBtc) : '—'}
                </td>
                <td>{canShowLiquidations ? quantity(liquidations.longBtc) : '—'}</td>
                <td>{canShowLiquidations ? quantity(liquidations.shortBtc) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p className="small text-secondary mb-0">
        Futures activity shifts only the unknown part of the settlement average. Selling that prices
        absorb has less directional effect; liquidation stress can widen uncertainty. Kalshi still
        settles using BRTI.
      </p>
    </section>
  );
}
