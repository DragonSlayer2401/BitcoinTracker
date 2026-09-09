import jStat from 'jstat';

const RETENTION_MS = 240_000;
const MAXIMUM_TRADES = 50_000;
const HEARTBEAT_AGE_MS = 5000;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const getSubMillisecond = (timestamp) =>
  Number(
    `0.${
      String(timestamp)
        .match(/\.(\d+)Z$/)?.[1]
        .slice(3) || '0'
    }`,
  );
const isAtOrBefore = (time, fraction, otherTime, otherFraction = 0) =>
  time < otherTime || (time === otherTime && fraction <= otherFraction);

function parseTrade(message, now) {
  const time = Date.parse(message.time);
  const price =
    typeof message.price === 'string' && DECIMAL.test(message.price) ? Number(message.price) : NaN;
  const size =
    typeof message.size === 'string' && DECIMAL.test(message.size) ? Number(message.size) : NaN;
  if (
    !Number.isSafeInteger(message.trade_id) ||
    message.trade_id < 0 ||
    !Number.isFinite(time) ||
    time > now + 2000 ||
    now - time > 20_000 ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    !['buy', 'sell'].includes(message.side)
  ) {
    throw new Error('Invalid or delayed executed trade.');
  }
  // The match side is the resting maker. A sell maker was lifted by an aggressive buyer.
  return {
    id: message.trade_id,
    time,
    receivedAt: now,
    price,
    size,
    side: message.side === 'sell' ? 'buy' : 'sell',
    subMillisecond: getSubMillisecond(message.time),
  };
}

export function createCoinbaseTrades() {
  let trades = [];
  let tradesById = new Map();
  let lastTradeId = null;
  let lastTradeTime = null;
  let lastTradeFraction = 0;
  let baselineId = null;
  let completeSince = null;
  let heartbeatAt = null;
  let heartbeatTime = null;
  let heartbeatFraction = 0;
  let heartbeatTradeId = null;
  let confirmedThrough = null;
  let pendingHeartbeat = null;
  let thresholds = null;
  let classifiedSince = null;
  let bursts = [];
  let burstRun = null;

  function reset() {
    trades = [];
    tradesById = new Map();
    lastTradeId = null;
    lastTradeTime = null;
    lastTradeFraction = 0;
    baselineId = null;
    completeSince = null;
    heartbeatAt = null;
    heartbeatTime = null;
    heartbeatFraction = 0;
    heartbeatTradeId = null;
    confirmedThrough = null;
    pendingHeartbeat = null;
    thresholds = null;
    classifiedSince = null;
    bursts = [];
    burstRun = null;
  }

  function establishBaseline(id, now) {
    lastTradeId = id;
    baselineId = id;
    completeSince = now;
  }

  function confirmHeartbeat() {
    if (pendingHeartbeat && pendingHeartbeat.id <= lastTradeId) {
      confirmedThrough = Math.max(confirmedThrough ?? 0, pendingHeartbeat.time);
      pendingHeartbeat = null;
    }
  }

  function apply(message, now) {
    try {
      if (message.type === 'last_match') {
        if (lastTradeId === null) {
          if (!Number.isSafeInteger(message.trade_id) || message.trade_id < 0)
            throw new Error('Invalid initial trade marker.');
          establishBaseline(message.trade_id, now);
        }
        return null;
      }
      if (message.type === 'heartbeat') {
        const time = Date.parse(message.time);
        const fraction = getSubMillisecond(message.time);
        const id = message.last_trade_id;
        if (
          !Number.isSafeInteger(id) ||
          id < 0 ||
          !Number.isFinite(time) ||
          time > now + 2000 ||
          now - time > HEARTBEAT_AGE_MS ||
          (heartbeatTime !== null &&
            !isAtOrBefore(heartbeatTime, heartbeatFraction, time, fraction)) ||
          (heartbeatTradeId !== null && id < heartbeatTradeId)
        )
          throw new Error('Invalid or regressed stream heartbeat.');
        if (lastTradeId === null) establishBaseline(id, now);
        const referencedTrade = tradesById.get(id);
        const laterTrade = tradesById.get(id + 1);
        if (
          (laterTrade &&
            isAtOrBefore(laterTrade.time, laterTrade.subMillisecond, time, fraction)) ||
          (referencedTrade &&
            !isAtOrBefore(referencedTrade.time, referencedTrade.subMillisecond, time, fraction))
        ) {
          throw new Error('Heartbeat trade marker conflicts with observed executions.');
        }
        heartbeatAt = now;
        heartbeatTime = time;
        heartbeatFraction = fraction;
        heartbeatTradeId = id;
        if (id >= baselineId) {
          if (id <= lastTradeId) confirmedThrough = Math.max(confirmedThrough ?? 0, time);
          else pendingHeartbeat = { id, time, receivedAt: pendingHeartbeat?.receivedAt ?? now };
        }
        confirmHeartbeat();
        return null;
      }
      if (message.type !== 'match') return null;
      const trade = parseTrade(message, now);
      if (
        heartbeatTime !== null &&
        ((trade.id > heartbeatTradeId &&
          isAtOrBefore(trade.time, trade.subMillisecond, heartbeatTime, heartbeatFraction)) ||
          (trade.id <= heartbeatTradeId &&
            !isAtOrBefore(trade.time, trade.subMillisecond, heartbeatTime, heartbeatFraction)))
      ) {
        throw new Error('Executed trade time conflicts with its heartbeat marker.');
      }
      if (lastTradeId === null) establishBaseline(trade.id - 1, now);
      if (trade.id <= lastTradeId) {
        const previous = tradesById.get(trade.id);
        if (
          previous &&
          ['time', 'subMillisecond', 'price', 'size', 'side'].every(
            (field) => previous[field] === trade[field],
          )
        )
          return null;
        if (trade.id === baselineId) return null;
        throw new Error('Executed trades arrived out of order or conflicted.');
      }
      if (trade.id !== lastTradeId + 1) throw new Error('A gap was detected in executed trades.');
      if (
        lastTradeTime !== null &&
        !isAtOrBefore(lastTradeTime, lastTradeFraction, trade.time, trade.subMillisecond)
      )
        throw new Error('Executed trade times regressed.');
      if (trades.length >= MAXIMUM_TRADES)
        throw new Error('Trade activity exceeds the supported buffer.');
      const threshold = thresholds?.[trade.side];
      trade.isLarge = threshold === undefined ? null : trade.size >= threshold;
      trade.largeThresholdBtc = threshold ?? null;
      if (trade.isLarge) {
        if (!burstRun || trade.side !== burstRun.side || trade.time - burstRun.lastTime > 10_000)
          burstRun = { side: trade.side, count: 0, lastTime: trade.time };
        burstRun.count += 1;
        burstRun.lastTime = trade.time;
        if (burstRun.count === 3) bursts.push({ time: trade.time, side: trade.side });
      }
      trades.push(trade);
      tradesById.set(trade.id, trade);
      lastTradeId = trade.id;
      lastTradeTime = trade.time;
      lastTradeFraction = trade.subMillisecond;
      confirmHeartbeat();
      return null;
    } catch (error) {
      reset();
      return error.message;
    }
  }

  function getQuality(now) {
    const reason =
      heartbeatAt === null
        ? 'Waiting for stream heartbeat.'
        : now < heartbeatAt ||
            now - heartbeatAt > HEARTBEAT_AGE_MS ||
            now - heartbeatTime > HEARTBEAT_AGE_MS
          ? 'Stream heartbeats are delayed.'
          : pendingHeartbeat
            ? 'Verifying potentially missing trades.'
            : null;
    return {
      available: reason === null,
      reason,
      heartbeatAt,
      confirmedThrough,
      completeSince,
      lastTradeId,
      flowReadySeconds:
        completeSince === null ? 0 : Math.max(0, Math.min(180, (now - completeSince) / 1000)),
      needsReconnect: pendingHeartbeat && now - pendingHeartbeat.receivedAt > 2000,
    };
  }

  function getSnapshot(now, liquidity) {
    const obsolete = trades.findIndex((trade) => trade.time >= now - RETENTION_MS);
    const removed = obsolete === -1 ? trades : trades.slice(0, obsolete);
    for (const trade of removed) tradesById.delete(trade.id);
    trades = obsolete === -1 ? [] : trades.slice(obsolete);
    bursts = bursts.filter((burst) => burst.time > now - 60_000);
    const quality = getQuality(now);
    // Non-overlapping completed intervals expose contemporaneous impact observations. They do
    // not establish that an execution caused a price move or that the relationship will persist.
    const impactSamples = [];
    const bucketMs = 15_000;
    const lastBucketEnd = Math.floor(Math.min(now, confirmedThrough ?? 0) / bucketMs) * bucketMs;
    if (quality.available && completeSince !== null) {
      for (let endAt = lastBucketEnd - 14 * bucketMs; endAt <= lastBucketEnd; endAt += bucketMs) {
        const startAt = endAt - bucketMs;
        if (startAt < completeSince || startAt < now - RETENTION_MS + 5000) continue;
        const startTrade = trades.findLast((trade) =>
          isAtOrBefore(trade.time, trade.subMillisecond, startAt),
        );
        const endTrade = trades.findLast((trade) =>
          isAtOrBefore(trade.time, trade.subMillisecond, endAt),
        );
        if (
          !startTrade ||
          !endTrade ||
          startAt - startTrade.time > 5000 ||
          endAt - endTrade.time > 5000
        )
          continue;
        let buyBtc = 0;
        let sellBtc = 0;
        let tradeCount = 0;
        for (const trade of trades) {
          if (
            isAtOrBefore(trade.time, trade.subMillisecond, startAt) ||
            !isAtOrBefore(trade.time, trade.subMillisecond, endAt)
          )
            continue;
          if (trade.side === 'buy') buyBtc += trade.size;
          else sellBtc += trade.size;
          tradeCount += 1;
        }
        impactSamples.push({
          startAt,
          endAt,
          startPrice: startTrade.price,
          endPrice: endTrade.price,
          buyBtc,
          sellBtc,
          tradeCount,
        });
      }
    }
    const impact = {
      available: quality.available && impactSamples.length > 0,
      asOf: now,
      completeSince,
      confirmedThrough,
      bucketSeconds: 15,
      samples: impactSamples,
    };
    const windows = Object.fromEntries(
      [15, 60, 180].map((seconds) => {
        const available =
          quality.available && completeSince !== null && completeSince <= now - seconds * 1000;
        if (!available)
          return [
            seconds,
            {
              available: false,
              tradeCount: null,
              buyBtc: null,
              sellBtc: null,
              signedBtc: null,
              totalBtc: null,
              imbalance: null,
            },
          ];
        let buyBtc = 0;
        let sellBtc = 0;
        let tradeCount = 0;
        for (const trade of trades) {
          if (trade.time <= now - seconds * 1000 || trade.time > now) continue;
          if (trade.side === 'buy') buyBtc += trade.size;
          else sellBtc += trade.size;
          tradeCount += 1;
        }
        const totalBtc = buyBtc + sellBtc;
        return [
          seconds,
          {
            available: true,
            tradeCount,
            buyBtc,
            sellBtc,
            signedBtc: buyBtc - sellBtc,
            totalBtc,
            imbalance: totalBtc > 0 ? (buyBtc - sellBtc) / totalBtc : 0,
          },
        ];
      }),
    );
    const reference = trades.filter((trade) => trade.time > now - 180_000 && trade.time <= now);
    if (
      windows[60].available &&
      reference.length >= 100 &&
      liquidity.available &&
      liquidity.depth[10].bidBtc > 0 &&
      liquidity.depth[10].askBtc > 0
    ) {
      const [median, percentile95] = jStat.quantiles(
        reference.map((trade) => trade.size),
        [0.5, 0.95],
      );
      const historical = Math.max(percentile95, median * 4);
      thresholds = {
        buy: Math.max(historical, liquidity.depth[10].askBtc * 0.05),
        sell: Math.max(historical, liquidity.depth[10].bidBtc * 0.05),
        median,
        percentile95,
      };
      if (classifiedSince === null) classifiedSince = now;
    } else {
      thresholds = null;
      classifiedSince = null;
      burstRun = null;
    }
    const largeReady =
      quality.available && classifiedSince !== null && now - classifiedSince >= 60_000;
    const large = trades.filter(
      (trade) => trade.time > now - 60_000 && trade.time <= now && trade.isLarge,
    );
    const largeTrades = {
      available: largeReady,
      thresholdBtc: thresholds ? Math.min(thresholds.buy, thresholds.sell) : null,
      buyThresholdBtc: thresholds?.buy ?? null,
      sellThresholdBtc: thresholds?.sell ?? null,
      referenceCount: reference.length,
      medianBtc: thresholds?.median ?? null,
      percentile95Btc: thresholds?.percentile95 ?? null,
      count60: largeReady ? large.length : null,
      buyCount60: largeReady ? large.filter((trade) => trade.side === 'buy').length : null,
      sellCount60: largeReady ? large.filter((trade) => trade.side === 'sell').length : null,
      burstCount60: largeReady ? bursts.length : null,
      lastTrade: large.at(-1) ? { ...large.at(-1) } : null,
    };
    return { available: windows[180].available, windows, largeTrades, impact };
  }

  function getDeadlineOutcome(expiresAt, now) {
    const empty = {
      observedPrice: null,
      observedAt: null,
      observedTradeId: null,
      confirmedThrough: null,
      completeSince: null,
    };
    if (
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(now) ||
      expiresAt <= 0 ||
      now < expiresAt
    )
      return { ...empty, status: 'waiting', reason: 'Waiting for the deadline.' };
    const quality = getQuality(now);
    if (completeSince !== null && completeSince > expiresAt)
      return {
        ...empty,
        status: 'unobserved',
        reason: 'The complete trade stream began after the deadline.',
      };
    if (quality.available && confirmedThrough > expiresAt) {
      const trade = trades.findLast((entry) =>
        isAtOrBefore(entry.time, entry.subMillisecond, expiresAt),
      );
      if (trade && trade.time >= completeSince && expiresAt - trade.time <= 5000) {
        return {
          status: 'observed',
          reason: null,
          observedPrice: trade.price,
          observedAt: trade.time,
          observedTradeId: trade.id,
          confirmedThrough,
          completeSince,
        };
      }
      return {
        ...empty,
        status: 'unobserved',
        reason: 'No sufficiently recent, fully observed trade at the deadline.',
      };
    }
    return {
      ...empty,
      status: now > expiresAt + 15_000 ? 'unobserved' : 'waiting',
      reason:
        now > expiresAt + 15_000
          ? 'The deadline could not be verified from a complete trade stream.'
          : 'Waiting for a heartbeat to verify trades through the deadline.',
    };
  }

  return { apply, getQuality, getSnapshot, getDeadlineOutcome, reset };
}
