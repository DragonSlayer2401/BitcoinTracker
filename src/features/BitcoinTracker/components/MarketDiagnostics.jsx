import { useState } from 'react';
import { Button, Modal, Table } from 'react-bootstrap';
import { formatPercent, formatPrice } from '../utils/format.utils';

const number = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

export default function MarketDiagnostics({ stream, conditions, forecast }) {
  const [show, setShow] = useState(false);
  const features = conditions?.features;
  const largeTrades = stream?.flow?.largeTrades;
  const depthChange = stream?.liquidity?.depthChange60;

  return (
    <>
      <Button size="sm" variant="outline-secondary" onClick={() => setShow(true)}>
        Market detail
      </Button>
      <Modal
        show={show}
        onHide={() => setShow(false)}
        className="tracker-modal"
        centered
        scrollable
        size="lg"
        aria-labelledby="market-detail-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="market-detail-heading" as="h2" className="h5">
            Market conditions and trade flow
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Coinbase stream: {stream?.status ?? 'connecting'}. {stream?.quality?.reason} Executed
            buying and selling can shift the probability calculation. New fixed calls do not require
            all these signals to agree.
          </p>
          {forecast?.pressure && (
            <>
              <h3 className="h6">Pressure in the live calculation</h3>
              <p className="small text-secondary">
                {forecast.pressure.applied
                  ? `Trade pressure changes Above by ${number(forecast.pressure.adjustmentPercentagePoints)} percentage points, after adjusting price uncertainty. The fit uses ${forecast.pressure.impactSampleCount} completed 15-second samples.`
                  : forecast.pressure.reason}
              </p>
              <p className="small text-secondary">
                Price-only Above: {formatPercent(forecast.pressure.unshiftedAboveProbability)} ·
                Current Above: {formatPercent(forecast.aboveProbability)}. This is an experimental
                adjustment, not a measured improvement in accuracy.
              </p>
            </>
          )}
          <h3 className="h6">Executed buying and selling</h3>
          <Table responsive size="sm" className="small">
            <caption>
              BTC taken by aggressive buyers and sellers. Positive imbalance means more buying.
            </caption>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Buy BTC</th>
                <th scope="col">Sell BTC</th>
                <th scope="col">Imbalance</th>
                <th scope="col">Trades</th>
              </tr>
            </thead>
            <tbody>
              {[15, 60, 180].map((seconds) => {
                const flow = stream?.flow?.windows?.[seconds];
                return (
                  <tr key={seconds}>
                    <th scope="row">
                      {seconds}s{!flow?.available && ' · warming'}
                    </th>
                    <td>{number(flow?.buyBtc, 3)}</td>
                    <td>{number(flow?.sellBtc, 3)}</td>
                    <td>{formatPercent(flow?.imbalance)}</td>
                    <td>{flow?.tradeCount ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="small text-secondary">
            {largeTrades?.available
              ? `Large-buy threshold: ${number(largeTrades.buyThresholdBtc, 3)} BTC; large-sell threshold: ${number(largeTrades.sellThresholdBtc, 3)} BTC · ${largeTrades.count60} large executions in 60s · ${largeTrades.burstCount60} bursts.`
              : 'Large-trade baseline is warming.'}{' '}
            Thresholds adapt to recent trades and nearby liquidity. This identifies activity, not a
            trader or wallet.
          </p>
          <h3 className="h6">Available liquidity</h3>
          <p className="small mb-2">
            Best bid {formatPrice(stream?.liquidity?.bid)} · Best ask{' '}
            {formatPrice(stream?.liquidity?.ask)}
          </p>
          <p className="small text-secondary mb-2">{stream?.liquidity?.reason}</p>
          <Table responsive size="sm" className="small">
            <caption>
              Displayed BTC within each distance from the midpoint. 10 basis points = 0.1%.
            </caption>
            <thead>
              <tr>
                <th scope="col">Distance</th>
                <th scope="col">Bid BTC</th>
                <th scope="col">Ask BTC</th>
                <th scope="col">Imbalance</th>
              </tr>
            </thead>
            <tbody>
              {[5, 10, 25].map((basisPoints) => {
                const depth = stream?.liquidity?.depth?.[basisPoints];
                return (
                  <tr key={basisPoints}>
                    <th scope="row">{basisPoints} bps</th>
                    <td>{number(depth?.bidBtc, 3)}</td>
                    <td>{number(depth?.askBtc, 3)}</td>
                    <td>{formatPercent(depth?.imbalance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="small text-secondary">
            60s depth change:{' '}
            {depthChange?.available ? formatPercent(depthChange.totalFraction) : 'warming'}. Orders
            can be canceled; displayed liquidity is not a directional promise or proof of
            manipulation.
          </p>
          <h3 className="h6">Price and volatility context</h3>
          <dl className="market-data-grid small">
            <div>
              <dt>1m / 3m return</dt>
              <dd>
                {formatPercent(features?.logReturn1Minute, 3)} /{' '}
                {formatPercent(features?.logReturn3Minutes, 3)}
              </dd>
            </div>
            <div>
              <dt>5m / 15m return</dt>
              <dd>
                {formatPercent(features?.logReturn5Minutes, 3)} /{' '}
                {formatPercent(features?.logReturn15Minutes, 3)}
              </dd>
            </div>
            <div>
              <dt>Recent / usual volume</dt>
              <dd>{number(features?.relativeVolume5To30Minutes)}×</dd>
            </div>
            <div>
              <dt>Short / long volatility</dt>
              <dd>{number(features?.shortLongVolatilityRatio)}×</dd>
            </div>
            <div>
              <dt>Current move / expected</dt>
              <dd>{number(features?.currentJumpStandardDeviations)}σ</dd>
            </div>
            <div>
              <dt>Weighted minute volatility</dt>
              <dd>{formatPercent(features?.ewmaMinuteVolatility, 3)}</dd>
            </div>
            <div>
              <dt>Close position in range</dt>
              <dd>{formatPercent(features?.closePosition)}</dd>
            </div>
            <div>
              <dt>Midpoint / spread</dt>
              <dd>
                {formatPrice(features?.midpoint)} / {formatPrice(features?.spread)}
              </dd>
            </div>
          </dl>
          <h3 className="h6">Market context for the live target</h3>
          {conditions?.riskFlags?.length ? (
            <ul className="small">
              {conditions.riskFlags.map((flag) => (
                <li key={flag.code}>{flag.reason}</li>
              ))}
            </ul>
          ) : (
            <p className="small text-secondary">
              {conditions?.available
                ? 'No unusual price condition is flagged.'
                : conditions?.reason || 'Waiting for market data.'}
            </p>
          )}
          <p className="small text-secondary mb-0">
            New fixed calls use these market observations as context, not automatic vetoes. The
            pressure model can favor the other side of the target. Fixed calls use their saved
            target; probabilities remain uncalibrated.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShow(false)}>
            Close market detail
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
