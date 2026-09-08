import { formatPercent, formatPrice, formatTime } from '../utils/format.utils';

export default function MarketData({ ticker, quoteAge, isQuoteFresh, historyAge, forecast }) {
  return (
    <section className="market-data dashboard-panel" aria-labelledby="market-data-heading">
      <h2 id="market-data-heading" className="section-title mb-2">
        Market data
      </h2>
      <dl className="market-data-grid mb-0">
        <div>
          <dt>Best bid</dt>
          <dd>{formatPrice(ticker?.bid)}</dd>
        </div>
        <div>
          <dt>Best ask</dt>
          <dd>{formatPrice(ticker?.ask)}</dd>
        </div>
        <div>
          <dt>Spread</dt>
          <dd>{ticker ? formatPrice(ticker.ask - ticker.bid) : '—'}</dd>
        </div>
        <div>
          <dt>Quote age</dt>
          <dd>
            {quoteAge === null ? 'Waiting' : `${Math.max(0, Math.floor(quoteAge / 1000))}s`}
            <span className="metric-caption"> 20s limit</span>
          </dd>
        </div>
        <div>
          <dt>Model history</dt>
          <dd>
            {forecast.sampleCount || '—'}
            <span className="metric-caption"> 1m returns</span>
          </dd>
        </div>
        <div>
          <dt>Window volatility</dt>
          <dd>{forecast.available ? formatPercent(forecast.volatility) : '—'}</dd>
        </div>
      </dl>
      <p className="data-receipt small text-secondary mb-0">
        Received {formatTime(ticker?.receivedAt)} ·{' '}
        {historyAge === null
          ? 'Waiting for history'
          : `Last close ${Math.floor(historyAge / 1000)}s ago`}
        {!isQuoteFresh && ticker && ' · Quote delayed'}
      </p>
    </section>
  );
}
