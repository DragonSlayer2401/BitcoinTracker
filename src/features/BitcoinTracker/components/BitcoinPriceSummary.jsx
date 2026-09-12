import Icon from './Icon';
import { formatPercent, formatPrice, formatTime } from '../utils/format.utils';

export default function BitcoinPriceSummary({ ticker, isQuoteFresh, priceChange }) {
  const isPositive = priceChange !== null && priceChange >= 0;

  return (
    <section className="price-summary" aria-labelledby="bitcoin-heading">
      <div className="d-flex align-items-center gap-2 mb-2">
        <span className="coin-symbol" aria-hidden="true">
          ₿
        </span>
        <div>
          <h2 id="bitcoin-heading" className="section-title mb-1">
            Bitcoin price
          </h2>
          <span className="text-secondary small">BTC / USD · Coinbase</span>
        </div>
        <span className="spot-chip ms-auto">SPOT</span>
      </div>
      <div
        className={`d-flex align-items-baseline flex-wrap gap-3 ${!isQuoteFresh ? 'price-delayed' : ''}`}
      >
        <span className="current-price">{formatPrice(ticker?.price)}</span>
        {priceChange !== null && (
          <span className={`price-change ${isPositive ? 'positive' : 'negative'}`}>
            <Icon name={isPositive ? 'up' : 'down'} size={15} /> {isPositive ? '+' : ''}
            {formatPercent(priceChange)} <span className="text-secondary fw-normal">~15m</span>
          </span>
        )}
      </div>
      <p className="small text-secondary mt-2 mb-0">
        {ticker
          ? `Last trade ${formatTime(ticker.time)}${!isQuoteFresh ? ' · delayed, not a live price' : ''}`
          : 'Connecting to Coinbase’s public market feed…'}
      </p>
    </section>
  );
}
