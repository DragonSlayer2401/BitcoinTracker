import { formatTime } from '../utils/format.utils';

export default function TrackerHeader({ now, isFeedFresh, feedStatusLabel, hasStreamTicker }) {
  return (
    <div className="monitor-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <h1 className="mb-0">
        Bitcoin monitor <span>Kalshi · BTC 15m</span>
      </h1>
      <div className="feed-indicator d-flex align-items-center flex-wrap gap-3">
        <div className={`feed-status ${isFeedFresh ? 'fresh' : ''}`} role="status">
          <span className="status-dot" />
          {feedStatusLabel}
        </div>
        <span className="small text-secondary">
          Coinbase · {hasStreamTicker ? 'Streaming' : 'REST fallback'}
        </span>
        <span className="local-clock small text-secondary">{formatTime(now)} local</span>
      </div>
    </div>
  );
}
