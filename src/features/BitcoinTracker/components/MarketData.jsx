import { formatPercent, formatPrice, formatTime } from '../utils/format.utils';
import MarketDiagnostics from './MarketDiagnostics';

export default function MarketData({
  ticker,
  quoteAge,
  isQuoteFresh,
  historyAge,
  forecast,
  stream,
  conditions,
}) {
  const flow = stream?.flow?.windows?.[60];
  const depth = stream?.liquidity?.depth?.[10];
  const ratio = conditions?.features?.shortLongVolatilityRatio;
  return (
    <section className="market-data dashboard-panel" aria-labelledby="market-data-heading">
      <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
        <h2 id="market-data-heading" className="section-title mb-0">
          Market data
        </h2>
        <MarketDiagnostics stream={stream} conditions={conditions} forecast={forecast} />
      </div>
      <dl className="market-data-grid mb-0">
        <div>
          <dt>60s buy / sell imbalance</dt>
          <dd>{flow?.available ? formatPercent(flow.imbalance) : 'Warming'}</dd>
        </div>
        <div>
          <dt>Depth within 0.1%</dt>
          <dd>
            {stream?.liquidity?.available && Number.isFinite(depth?.totalBtc)
              ? `${depth.totalBtc.toFixed(1)} BTC`
              : 'Waiting'}
          </dd>
        </div>
        <div>
          <dt>Spread</dt>
          <dd>{ticker ? formatPrice(ticker.ask - ticker.bid) : '—'}</dd>
        </div>
        <div>
          <dt>Quote age</dt>
          <dd>
            {quoteAge === null ? 'Waiting' : `${Math.max(0, Math.floor(quoteAge / 1000))}s`}
            <span className="metric-caption">
              {' '}
              {Math.round((conditions?.features?.maximumQuoteAgeMs ?? 20000) / 1000)}s limit
            </span>
          </dd>
        </div>
        <div>
          <dt>Short / long volatility</dt>
          <dd>{Number.isFinite(ratio) ? `${ratio.toFixed(2)}×` : '—'}</dd>
        </div>
        <div>
          <dt>Live window volatility</dt>
          <dd>{forecast.available ? formatPercent(forecast.volatility) : '—'}</dd>
        </div>
      </dl>
      <p className="data-receipt small text-secondary mb-0">
        {stream?.quality?.available ? 'Stream ready' : `Stream ${stream?.status ?? 'connecting'}`} ·
        Received {formatTime(ticker?.receivedAt)} ·{' '}
        {historyAge === null
          ? 'Waiting for history'
          : `Last close ${Math.floor(historyAge / 1000)}s ago`}
        {!isQuoteFresh && ticker && ' · Quote delayed'}
      </p>
    </section>
  );
}
