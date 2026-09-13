import jStat from 'jstat';

const SYMBOL = 'BTCUSDT';
const RETENTION_MS = 240_000;
const MAXIMUM_TRADES = 50_000;
const MAXIMUM_LIQUIDATIONS = 10_000;
const BUCKET_MS = 15_000;
const FRESHNESS_MS = 5000;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const WINDOWS = [15, 60, 180];

function getNumber(value, allowZero = false) {
  const number = typeof value === 'string' && DECIMAL.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0))
    throw new Error('Invalid futures market number.');
  return number;
}

function validateTime(time, now) {
  if (!Number.isSafeInteger(time) || time <= 0 || time > now + 2000 || now - time > FRESHNESS_MS)
    throw new Error('Futures messages are delayed or have invalid timestamps.');
}

function parseExecution(entry, now, isLiquidation = false) {
  if (!entry || entry.s !== SYMBOL || !['Buy', 'Sell'].includes(entry.S))
    throw new Error('Invalid futures execution symbol or side.');
  validateTime(entry.T, now);
  const price = getNumber(entry.p);
  const size = getNumber(entry.v);
  if (!isLiquidation && (typeof entry.i !== 'string' || !entry.i || entry.i.length > 128))
    throw new Error('Invalid futures trade identifier.');
  if (entry.seq !== undefined && (!Number.isSafeInteger(entry.seq) || entry.seq < 0))
    throw new Error('Invalid futures cross sequence.');
  if (entry.BT !== undefined && typeof entry.BT !== 'boolean')
    throw new Error('Invalid futures block trade marker.');
  return {
    id: isLiquidation ? null : entry.i,
    time: entry.T,
    price,
    size,
    side: entry.S === 'Buy' ? 'buy' : 'sell',
    sequence: entry.seq ?? null,
  };
}

/** Bounded venue observations; a connected public feed cannot prove market-wide completeness. */
export function createDerivativesMarket() {
  let trades = [];
  let tradeIds = new Map();
  let liquidations = [];
  let liquidationFrames = new Map();
  let completeSince = null;
  let lastTradeAt = null;
  let lastSequence = null;
  let lastLiquidationAt = null;
  let ticker = null;
  let threshold = null;
  let thresholdBucket = null;
  let classifiedSince = null;

  function reset(timestamp = null) {
    trades = [];
    tradeIds = new Map();
    liquidations = [];
    liquidationFrames = new Map();
    completeSince = timestamp;
    lastTradeAt = null;
    lastSequence = null;
    lastLiquidationAt = null;
    ticker = null;
    threshold = null;
    thresholdBucket = null;
    classifiedSince = null;
  }

  function prune(now) {
    let removed = 0;
    while (removed < trades.length && trades[removed].time < now - RETENTION_MS) {
      tradeIds.delete(trades[removed].id);
      removed += 1;
    }
    if (removed) trades = trades.slice(removed);
    liquidations = liquidations.filter((entry) => entry.time >= now - RETENTION_MS);
    for (const [key, time] of liquidationFrames) {
      if (time < now - RETENTION_MS) liquidationFrames.delete(key);
    }
  }

  function updateLargeThreshold(now) {
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    if (thresholdBucket === bucket) return;
    thresholdBucket = bucket;
    // Exclude this interval and the preceding one so a burst cannot define its own threshold.
    const referenceEnd = bucket - BUCKET_MS;
    const reference = trades.filter(
      (trade) => trade.time <= referenceEnd && trade.time > referenceEnd - 180_000,
    );
    if (completeSince === null || referenceEnd - completeSince < 60_000 || reference.length < 100) {
      threshold = null;
      classifiedSince = null;
      return;
    }
    const [median, percentile95] = jStat.quantiles(
      reference.map((trade) => trade.size),
      [0.5, 0.95],
    );
    threshold = Math.max(median * 4, percentile95);
    if (classifiedSince === null) classifiedSince = now;
  }

  function applyTrades(message, now) {
    if (!Array.isArray(message.data) || !message.data.length || message.data.length > 1024)
      throw new Error('Invalid futures trade batch.');
    updateLargeThreshold(now);
    for (const entry of message.data) {
      const trade = parseExecution(entry, now);
      // Off-book negotiated blocks do not establish aggressive order-book buying or selling.
      if (entry.BT === true) continue;
      const duplicate = tradeIds.get(trade.id);
      if (duplicate) {
        if (
          !['time', 'price', 'size', 'side', 'sequence'].every(
            (key) => duplicate[key] === trade[key],
          )
        )
          throw new Error('Conflicting futures trade identifier.');
        continue;
      }
      if (trade.time < completeSince) continue;
      if (
        (lastTradeAt !== null &&
          trade.time < lastTradeAt &&
          (trade.sequence === null || trade.sequence !== lastSequence)) ||
        (lastSequence !== null && trade.sequence !== null && trade.sequence < lastSequence)
      )
        throw new Error('Futures trades arrived out of order.');
      // seq is a cross sequence, not a contiguous trade ID; repeated sequences contain new trades.
      if (trades.length >= MAXIMUM_TRADES)
        throw new Error('Futures trade activity exceeds the supported buffer.');
      trade.isLarge = threshold === null ? null : trade.size >= threshold;
      trades.push(trade);
      if (lastTradeAt !== null && trade.time < lastTradeAt)
        trades.sort((first, second) => first.time - second.time);
      tradeIds.set(trade.id, trade);
      lastTradeAt = Math.max(lastTradeAt ?? trade.time, trade.time);
      if (trade.sequence !== null) lastSequence = trade.sequence;
    }
  }

  function applyLiquidations(message, now) {
    if (!Array.isArray(message.data) || message.data.length > 1024)
      throw new Error('Invalid futures liquidation batch.');
    const entries = message.data.map((entry) => parseExecution(entry, now, true));
    // This feed has no execution IDs. Deduplicate exact repeated frames, retaining equal rows
    // within a frame because distinct positions can share side, time, size, and bankruptcy price.
    const frameKey = JSON.stringify([message.ts, entries]);
    if (liquidationFrames.has(frameKey)) return;
    if (liquidationFrames.size >= MAXIMUM_LIQUIDATIONS)
      throw new Error('Futures liquidation frames exceed the supported buffer.');
    for (const entry of entries) {
      if (entry.time < completeSince) continue;
      if (liquidations.length >= MAXIMUM_LIQUIDATIONS)
        throw new Error('Futures liquidation activity exceeds the supported buffer.');
      // S is the liquidated POSITION side: Buy is a liquidated long, hence sell pressure.
      liquidations.push({
        time: entry.time,
        size: entry.size,
        position: entry.side === 'buy' ? 'long' : 'short',
      });
      lastLiquidationAt = Math.max(lastLiquidationAt ?? entry.time, entry.time);
    }
    liquidationFrames.set(frameKey, message.ts);
  }

  function applyTicker(message) {
    const data = message.data;
    if (!data || data.symbol !== SYMBOL || !['snapshot', 'delta'].includes(message.type))
      throw new Error('Invalid futures ticker.');
    if (ticker && message.ts < ticker.time) throw new Error('Futures ticker time regressed.');
    if (!ticker && message.type !== 'snapshot')
      throw new Error('Futures ticker snapshot is missing.');
    const next = message.type === 'snapshot' ? {} : { ...ticker };
    for (const key of ['lastPrice', 'indexPrice', 'markPrice', 'openInterest']) {
      if (data[key] !== undefined) next[key] = getNumber(data[key], key === 'openInterest');
      if (!Number.isFinite(next[key])) throw new Error('Futures ticker snapshot is incomplete.');
    }
    ticker = { ...next, time: message.ts };
  }

  function apply(message, now) {
    validateTime(message.ts, now);
    prune(now);
    if (message.topic === `publicTrade.${SYMBOL}`) applyTrades(message, now);
    else if (message.topic === `allLiquidation.${SYMBOL}`) applyLiquidations(message, now);
    else if (message.topic === `tickers.${SYMBOL}`) applyTicker(message);
  }

  function getBoundaryTrade(time, maximumAgeMs = BUCKET_MS) {
    const trade = trades.findLast((entry) => entry.time <= time);
    return trade && time - trade.time <= maximumAgeMs ? trade : null;
  }

  function getSnapshot(now, connected) {
    prune(now);
    const hasFreshTrades =
      connected && lastTradeAt !== null && lastTradeAt <= now && now - lastTradeAt <= FRESHNESS_MS;
    const isCompleteWindow = (seconds) =>
      completeSince !== null && completeSince <= now - seconds * 1000;
    const windows = Object.fromEntries(
      WINDOWS.map((seconds) => {
        const startAt = now - seconds * 1000;
        const available = hasFreshTrades && isCompleteWindow(seconds);
        const entries = available
          ? trades.filter((entry) => entry.time > startAt && entry.time <= now)
          : [];
        const buyBtc = entries.reduce(
          (sum, entry) => sum + (entry.side === 'buy' ? entry.size : 0),
          0,
        );
        const sellBtc = entries.reduce(
          (sum, entry) => sum + (entry.side === 'sell' ? entry.size : 0),
          0,
        );
        const totalBtc = buyBtc + sellBtc;
        const largeTradesAvailable =
          available &&
          classifiedSince !== null &&
          classifiedSince <= startAt &&
          entries.every((entry) => entry.isLarge !== null);
        const large = largeTradesAvailable ? entries.filter((entry) => entry.isLarge) : [];
        const start = getBoundaryTrade(startAt);
        const end = getBoundaryTrade(now, FRESHNESS_MS);
        return [
          seconds,
          {
            available,
            buyBtc: available ? buyBtc : null,
            sellBtc: available ? sellBtc : null,
            totalBtc: available ? totalBtc : null,
            signedBtc: available ? buyBtc - sellBtc : null,
            imbalance: available ? (totalBtc > 0 ? (buyBtc - sellBtc) / totalBtc : 0) : null,
            tradeCount: available ? entries.length : null,
            logReturn: available && start && end ? Math.log(end.price / start.price) : null,
            priceResponseAvailable: Boolean(available && start && end),
            largeTradesAvailable,
            largeBuyBtc: largeTradesAvailable
              ? large.reduce((sum, entry) => sum + (entry.side === 'buy' ? entry.size : 0), 0)
              : null,
            largeSellBtc: largeTradesAvailable
              ? large.reduce((sum, entry) => sum + (entry.side === 'sell' ? entry.size : 0), 0)
              : null,
            largeTradeCount: largeTradesAvailable ? large.length : null,
          },
        ];
      }),
    );
    const samples = [];
    const lastBucketEnd = Math.floor(Math.min(now, lastTradeAt ?? 0) / BUCKET_MS) * BUCKET_MS;
    if (hasFreshTrades && completeSince !== null) {
      for (let endAt = lastBucketEnd - 14 * BUCKET_MS; endAt <= lastBucketEnd; endAt += BUCKET_MS) {
        const startAt = endAt - BUCKET_MS;
        if (startAt < completeSince || startAt < now - RETENTION_MS + FRESHNESS_MS) continue;
        const start = getBoundaryTrade(startAt);
        const end = getBoundaryTrade(endAt);
        if (!start || !end) continue;
        const entries = trades.filter((entry) => entry.time > startAt && entry.time <= endAt);
        samples.push({
          startAt,
          endAt,
          startPrice: start.price,
          endPrice: end.price,
          startPriceAt: start.time,
          endPriceAt: end.time,
          buyBtc: entries.reduce((sum, entry) => sum + (entry.side === 'buy' ? entry.size : 0), 0),
          sellBtc: entries.reduce(
            (sum, entry) => sum + (entry.side === 'sell' ? entry.size : 0),
            0,
          ),
          tradeCount: entries.length,
          logReturn: Math.log(end.price / start.price),
        });
      }
    }
    return {
      completeSince,
      lastTradeAt,
      lastLiquidationAt,
      hasFreshTrades,
      retainedTrades: trades.length,
      retainedLiquidations: liquidations.length,
      windows,
      impact: {
        available: hasFreshTrades && samples.length > 0,
        asOf: now,
        completeSince,
        bucketSeconds: 15,
        samples,
      },
      liquidations: {
        available: connected,
        coverage: 'venue-reported',
        windows: Object.fromEntries(
          WINDOWS.map((seconds) => {
            const available = connected && isCompleteWindow(seconds);
            const entries = available
              ? liquidations.filter(
                  (entry) => entry.time > now - seconds * 1000 && entry.time <= now,
                )
              : [];
            return [
              seconds,
              {
                available,
                longBtc: available
                  ? entries.reduce(
                      (sum, entry) => sum + (entry.position === 'long' ? entry.size : 0),
                      0,
                    )
                  : null,
                shortBtc: available
                  ? entries.reduce(
                      (sum, entry) => sum + (entry.position === 'short' ? entry.size : 0),
                      0,
                    )
                  : null,
                count: available ? entries.length : null,
              },
            ];
          }),
        ),
      },
      ticker:
        connected && ticker && ticker.time <= now && now - ticker.time <= FRESHNESS_MS
          ? { ...ticker }
          : null,
    };
  }

  function beginCoverage(timestamp) {
    // Ticker snapshots can precede the subscription acknowledgement; preserve that snapshot
    // so subsequent deltas can be merged without losing the initial reference fields.
    const initialTicker = ticker;
    reset(timestamp);
    ticker = initialTicker;
  }

  return { reset, beginCoverage, apply, getSnapshot };
}
