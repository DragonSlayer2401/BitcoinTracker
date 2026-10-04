import Icon from './Icon';
import { formatPercent, formatPrice, formatTime } from '../utils/format.utils';

export default function BitcoinPriceSummary({ benchmarkData, compact = false }) {
  const { current, isFresh, priceChange, reason } = benchmarkData;
  const hasPriceChange = Number.isFinite(priceChange);
  const isPositive = hasPriceChange && priceChange >= 0;

  return (
    <section
      className={`price-summary${compact ? ' price-summary-compact' : ''}`}
      aria-labelledby="bitcoin-heading"
    >
      <div className={`d-flex align-items-center gap-2 ${compact ? '' : 'mb-2'}`}>
        {!compact && (
          <span className="coin-symbol" aria-hidden="true">
            ₿
          </span>
        )}
        <div>
          <h2 id="bitcoin-heading" className="section-title mb-1">
            Kalshi reference index
          </h2>
          <span className={compact ? 'visually-hidden' : 'text-secondary small'}>
            CF Benchmarks BRTI · via Kalshi
          </span>
        </div>
        {!compact && <span className="spot-chip ms-auto">INDEX</span>}
      </div>
      <div
        className={`d-flex align-items-baseline flex-wrap gap-2 ${!isFresh ? 'price-delayed' : ''}`}
      >
        <span className="current-price">{formatPrice(current?.price)}</span>
        {hasPriceChange && (
          <span className={`price-change ${isPositive ? 'positive' : 'negative'}`}>
            <Icon name={isPositive ? 'up' : 'down'} size={15} /> {isPositive ? '+' : ''}
            {formatPercent(priceChange)} <span className="text-secondary fw-normal">~15m</span>
          </span>
        )}
        <span className="small text-secondary ms-auto">
          {current
            ? `Index reading ${formatTime(current.time)}${!isFresh ? ' · delayed' : ''}`
            : null}
        </span>
      </div>
      {!current && (
        <p className="small text-secondary mt-1 mb-0">
          {reason || 'Waiting for CF Benchmarks BRTI readings…'}
        </p>
      )}
    </section>
  );
}
