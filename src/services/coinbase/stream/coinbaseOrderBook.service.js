const MAXIMUM_BOOK_LEVELS = 100_000;
const MAXIMUM_BOOK_AGE = 10_000;
const DECIMAL = /^\d+(?:\.\d+)?$/;

function parseLevel(price, size) {
  const numericPrice = typeof price === 'string' && DECIMAL.test(price) ? Number(price) : NaN;
  const numericSize = typeof size === 'string' && DECIMAL.test(size) ? Number(size) : NaN;
  if (
    !Number.isFinite(numericPrice) ||
    numericPrice <= 0 ||
    !Number.isFinite(numericSize) ||
    numericSize < 0
  ) {
    throw new Error('Invalid order book level.');
  }
  return [numericPrice, numericSize];
}

function getBestPrices(bids, asks) {
  let bid = 0;
  let ask = Infinity;
  for (const price of bids.keys()) bid = Math.max(bid, price);
  for (const price of asks.keys()) ask = Math.min(ask, price);
  return { bid, ask };
}

export function createCoinbaseOrderBook() {
  let bids = new Map();
  let asks = new Map();
  let receivedAt = null;
  let eventTime = null;
  let history = [];

  function reset() {
    bids = new Map();
    asks = new Map();
    receivedAt = null;
    eventTime = null;
    history = [];
  }

  function apply(message, now) {
    try {
      if (message.type === 'snapshot') {
        if (!Array.isArray(message.bids) || !Array.isArray(message.asks))
          throw new Error('Invalid book snapshot.');
        const nextBids = new Map();
        const nextAsks = new Map();
        for (const [rows, levels] of [
          [message.bids, nextBids],
          [message.asks, nextAsks],
        ]) {
          if (rows.length > MAXIMUM_BOOK_LEVELS)
            throw new Error('Order book exceeds the supported size.');
          for (const row of rows) {
            if (!Array.isArray(row) || row.length !== 2)
              throw new Error('Invalid book snapshot row.');
            const [price, size] = parseLevel(...row);
            if (levels.has(price)) throw new Error('Duplicate order book price.');
            if (size > 0) levels.set(price, size);
          }
        }
        const best = getBestPrices(nextBids, nextAsks);
        if (!best.bid || !Number.isFinite(best.ask) || best.bid >= best.ask)
          throw new Error('Order book is empty or crossed.');
        bids = nextBids;
        asks = nextAsks;
        receivedAt = now;
        eventTime = null;
        history = [];
      } else if (message.type === 'l2update') {
        if (receivedAt === null) throw new Error('Waiting for a new order book snapshot.');
        const time = Date.parse(message.time);
        if (
          !Number.isFinite(time) ||
          time > now + 2000 ||
          now - time > MAXIMUM_BOOK_AGE ||
          (eventTime !== null && time < eventTime)
        ) {
          throw new Error('Order book updates are delayed or out of order.');
        }
        if (!Array.isArray(message.changes) || message.changes.length > MAXIMUM_BOOK_LEVELS)
          throw new Error('Invalid order book changes.');
        const changes = message.changes.map((row) => {
          if (!Array.isArray(row) || row.length !== 3 || !['buy', 'sell'].includes(row[0]))
            throw new Error('Invalid order book change.');
          return [row[0], ...parseLevel(row[1], row[2])];
        });
        // Coinbase sizes replace the level's quantity; they are never deltas.
        for (const [side, price, size] of changes) {
          const levels = side === 'buy' ? bids : asks;
          if (size === 0) levels.delete(price);
          else levels.set(price, size);
        }
        const best = getBestPrices(bids, asks);
        if (
          !best.bid ||
          !Number.isFinite(best.ask) ||
          best.bid >= best.ask ||
          bids.size > MAXIMUM_BOOK_LEVELS ||
          asks.size > MAXIMUM_BOOK_LEVELS
        ) {
          throw new Error('Order book is empty, crossed, or exceeds the supported size.');
        }
        receivedAt = now;
        eventTime = time;
      }
      return null;
    } catch (error) {
      reset();
      return error.message;
    }
  }

  function getSnapshot(now) {
    if (
      receivedAt === null ||
      now < receivedAt ||
      now - receivedAt > MAXIMUM_BOOK_AGE ||
      (eventTime !== null && (now - eventTime > MAXIMUM_BOOK_AGE || eventTime > now + 2000))
    ) {
      return {
        available: false,
        reason:
          receivedAt === null
            ? 'Waiting for an order book snapshot.'
            : 'Order book updates are delayed.',
        depth: null,
        depthChange60: null,
      };
    }
    const { bid, ask } = getBestPrices(bids, asks);
    const midpoint = (bid + ask) / 2;
    const depth = Object.fromEntries(
      [5, 10, 25].map((basisPoints) => [basisPoints, { bidBtc: 0, askBtc: 0 }]),
    );
    for (const [levels, side] of [
      [bids, 'bidBtc'],
      [asks, 'askBtc'],
    ]) {
      for (const [price, size] of levels) {
        const distance = Math.abs(price / midpoint - 1) * 10_000;
        for (const basisPoints of [5, 10, 25])
          if (distance <= basisPoints) depth[basisPoints][side] += size;
      }
    }
    for (const band of Object.values(depth)) {
      band.totalBtc = band.bidBtc + band.askBtc;
      band.imbalance = band.totalBtc > 0 ? (band.bidBtc - band.askBtc) / band.totalBtc : null;
    }
    if (!history.length || now - history.at(-1).time >= 1000) {
      history.push({ time: now, bidBtc: depth[10].bidBtc, askBtc: depth[10].askBtc });
      history = history.filter((sample) => sample.time >= now - 65_000).slice(-66);
    }
    const baseline = history.findLast((sample) => sample.time <= now - 60_000);
    return {
      available: true,
      reason: null,
      bid,
      ask,
      midpoint,
      spreadBps: ((ask - bid) / midpoint) * 10_000,
      updatedAt: receivedAt,
      snapshotAt: receivedAt,
      depth,
      depthChange60: baseline
        ? {
            available: true,
            bidFraction: baseline.bidBtc > 0 ? depth[10].bidBtc / baseline.bidBtc - 1 : null,
            askFraction: baseline.askBtc > 0 ? depth[10].askBtc / baseline.askBtc - 1 : null,
            totalFraction:
              baseline.bidBtc + baseline.askBtc > 0
                ? depth[10].totalBtc / (baseline.bidBtc + baseline.askBtc) - 1
                : null,
            bidBtc: depth[10].bidBtc - baseline.bidBtc,
            askBtc: depth[10].askBtc - baseline.askBtc,
            totalBtc: depth[10].totalBtc - baseline.bidBtc - baseline.askBtc,
          }
        : {
            available: false,
            bidFraction: null,
            askFraction: null,
            totalFraction: null,
            bidBtc: null,
            askBtc: null,
            totalBtc: null,
          },
    };
  }

  return { apply, getSnapshot, reset };
}
