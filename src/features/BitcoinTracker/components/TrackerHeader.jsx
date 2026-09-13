import { formatTime } from '../utils/format.utils';

export default function TrackerHeader({ now, benchmarkData, hasStreamTicker }) {
  const feedStatusLabel = benchmarkData.isFresh
    ? 'BRTI live'
    : benchmarkData.current
      ? 'BRTI delayed'
      : 'BRTI unavailable';
  return (
    <div className="monitor-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <h1 className="mb-0">
        Bitcoin monitor <span>Kalshi · BTC 15m</span>
      </h1>
      <div className="feed-indicator d-flex align-items-center flex-wrap gap-3">
        <div className={`feed-status ${benchmarkData.isFresh ? 'fresh' : ''}`} role="status">
          <span className="status-dot" />
          {feedStatusLabel}
        </div>
        <span className="small text-secondary">
          Coinbase input · {hasStreamTicker ? 'Streaming' : 'REST fallback'}
        </span>
        <span className="local-clock small text-secondary">{formatTime(now)} local</span>
      </div>
    </div>
  );
}
