import { parseDecimalUnits } from '@/utils/fixedPoint.utils';
import { assertKalshiTicker } from '../kalshi.validation';

const source = Object.freeze({ id: 'kalshi', kind: 'official' });
const isTime = (value) =>
  Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const readInteger = (value) => {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,29})$/.test(value) ? value : null;
};
const readPrice = (value) => {
  const units = parseDecimalUnits(value, 4);
  return units !== null && units >= 0n && units <= 10_000n ? units : null;
};
const readLevels = (rows) => {
  if (!Array.isArray(rows) || rows.length > 10_001) throw new Error('Invalid Kalshi book levels.');
  const levels = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid Kalshi book level.');
    const price = readPrice(row[0]);
    const quantity = parseDecimalUnits(row[1], 2);
    if (price === null || quantity === null || quantity < 0n || levels.has(price.toString()))
      throw new Error('Invalid or duplicate Kalshi book level.');
    levels.set(price.toString(), quantity);
  }
  for (const [price, quantity] of levels) if (quantity === 0n) levels.delete(price);
  return levels;
};
const toLevels = (levels, complement = false) =>
  [...levels.entries()]
    .map(([price, quantity]) => ({
      priceUnits: (complement ? 10_000n - BigInt(price) : BigInt(price)).toString(),
      quantityUnits: quantity.toString(),
    }))
    .sort((left, right) =>
      complement
        ? Number(BigInt(left.priceUnits) - BigInt(right.priceUnits))
        : Number(BigInt(right.priceUnits) - BigInt(left.priceUnits)),
    );
const readSourceTime = (message) => {
  if (message.ts_ms !== undefined) {
    if (!isTime(message.ts_ms)) throw new Error('Invalid Kalshi book event timestamp.');
    return message.ts_ms;
  }
  if (message.ts === undefined) return null;
  if (
    typeof message.ts !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(message.ts)
  )
    throw new Error('Invalid Kalshi book event timestamp.');
  const time = Date.parse(message.ts);
  if (!isTime(time) || new Date(time).toISOString().slice(0, 19) !== message.ts.slice(0, 19))
    throw new Error('Invalid Kalshi book event timestamp.');
  return time;
};
const describeBook = (book, now, freshnessMs) => {
  const yesBids = toLevels(book.yes);
  const noBids = toLevels(book.no);
  const isCrossed =
    yesBids.length > 0 &&
    noBids.length > 0 &&
    BigInt(yesBids[0].priceUnits) + BigInt(noBids[0].priceUnits) > 10_000n;
  const isFresh =
    isTime(now) &&
    book.receivedAt !== null &&
    book.receivedAt <= now &&
    now - book.receivedAt <= freshnessMs &&
    (book.sourceTime === null ||
      (book.sourceTime <= now && now - book.sourceTime <= freshnessMs)) &&
    (book.sendingTime === null || book.sendingTime <= now);
  const reason = !book.valid
    ? book.reason
    : !isFresh
      ? 'stale_book'
      : isCrossed
        ? 'crossed_book'
        : null;
  return {
    schemaVersion: 'kalshi-book-v1',
    source: { ...source },
    ticker: book.ticker,
    transport: book.transport,
    currency: 'USD',
    priceUnit: 'USD/contract',
    quantityUnit: 'contracts',
    priceScale: 4,
    quantityScale: 2,
    timestampUnit: 'unix-ms',
    available: reason === null,
    reason,
    receivedAt: book.receivedAt,
    sourceTime: book.sourceTime,
    sendingTime: book.sendingTime,
    sequence: book.sequence,
    subscriptionId: book.subscriptionId,
    clock: book.clock,
    marketId: book.marketId,
    yesBids: reason === null ? yesBids : [],
    noBids: reason === null ? noBids : [],
    yesAsks: reason === null ? toLevels(book.no, true) : [],
    noAsks: reason === null ? toLevels(book.yes, true) : [],
  };
};
const emptyBook = (ticker, reason = 'waiting_for_snapshot') => ({
  ticker,
  transport: 'kalshi-websocket',
  valid: false,
  reason,
  yes: new Map(),
  no: new Map(),
  receivedAt: null,
  sourceTime: null,
  sendingTime: null,
  sequence: null,
  subscriptionId: null,
  clock: null,
  snapshotClock: null,
  marketId: null,
});

/** REST evidence is independent. It has no WS sequence boundary and cannot seed live deltas. */
export const normalizeKalshiRestBook = (payload, ticker, receivedAt) => {
  assertKalshiTicker(ticker);
  if (!isTime(receivedAt)) throw new Error('Invalid Kalshi book receipt time.');
  const book = {
    ...emptyBook(ticker),
    transport: 'kalshi-rest',
    valid: true,
    reason: null,
    receivedAt,
    yes: readLevels(payload?.orderbook_fp?.yes_dollars),
    no: readLevels(payload?.orderbook_fp?.no_dollars),
  };
  return describeBook(book, receivedAt, 5000);
};

/** Single-subscription, arrival-order reconstruction. Every WS snapshot replaces its market.
 * https://docs.kalshi.com/websockets/orderbook-updates — v2, reviewed 2026-11-06.
 * Quantities are additive deltas. Clocks may skip/share values; sequence numbers may not.
 */
export const createKalshiBookState = ({ tickers, freshnessMs = 5000 } = {}) => {
  if (!Array.isArray(tickers) || tickers.length > 100 || new Set(tickers).size !== tickers.length)
    throw new Error('Choose unique Kalshi book tickers.');
  tickers.forEach(assertKalshiTicker);
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs <= 0)
    throw new Error('Invalid book freshness interval.');
  const books = new Map(tickers.map((ticker) => [ticker, emptyBook(ticker)]));
  let subscriptionId = null;
  let sequence = null;
  let lastReceivedAt = null;
  let resyncRequired = false;
  const pendingSnapshots = new Set(tickers);
  const seen = new Map();
  const invalidate = (reason = 'book_invalidated', receivedAt = lastReceivedAt) => {
    for (const ticker of tickers) {
      books.set(ticker, {
        ...emptyBook(ticker, reason),
        receivedAt: isTime(receivedAt) ? receivedAt : null,
      });
      pendingSnapshots.add(ticker);
    }
    resyncRequired = true;
  };
  const getSnapshot = (now) => {
    const records = Object.fromEntries(
      [...books].map(([ticker, book]) => [ticker, describeBook(book, now, freshnessMs)]),
    );
    const available = tickers.length > 0 && Object.values(records).every((book) => book.available);
    return {
      schemaVersion: 'kalshi-books-v1',
      source: { ...source },
      available,
      reason: available
        ? null
        : tickers.length === 0
          ? 'no_active_markets'
          : resyncRequired
            ? 'resync_required'
            : 'book_unavailable',
      requiresResync: resyncRequired,
      subscriptionId,
      sequence,
      lastReceivedAt,
      books: records,
    };
  };
  const accept = (frame, receivedAt) => {
    const result = (disposition, reason = null) => ({
      accepted: disposition === 'accepted',
      disposition,
      reason,
      requiresResync: resyncRequired,
      snapshot: getSnapshot(lastReceivedAt),
    });
    const reject = (reason) => {
      invalidate(reason, receivedAt);
      return result('invalid', reason);
    };
    if (!isTime(receivedAt) || (lastReceivedAt !== null && receivedAt < lastReceivedAt))
      return reject('invalid_receipt_time');
    lastReceivedAt = receivedAt;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame))
      return reject('invalid_book_frame');
    if (frame.type === 'subscribed') {
      if (frame.msg?.channel !== 'orderbook_delta') return result('ignored', 'other_channel');
      const sid = readInteger(frame.msg.sid);
      if (sid === null || BigInt(sid) === 0n || (subscriptionId !== null && sid !== subscriptionId))
        return reject('invalid_book_subscription');
      subscriptionId = sid;
      return result('accepted');
    }
    if (frame.type === 'error') return reject('book_source_error');
    const sid = readInteger(frame.sid);
    if (subscriptionId === null || sid !== subscriptionId)
      return result('ignored', 'unmatched_subscription');
    const nextSequence = readInteger(frame.seq);
    if (nextSequence === null) return reject('invalid_book_sequence');
    const fingerprint = JSON.stringify(frame);
    if (seen.has(nextSequence)) {
      if (seen.get(nextSequence) === fingerprint) return result('duplicate');
      return reject('conflicting_book_sequence');
    }
    if (sequence !== null && BigInt(nextSequence) <= BigInt(sequence))
      return reject('regressed_book_sequence');
    const gap = sequence !== null && BigInt(nextSequence) !== BigInt(sequence) + 1n;
    sequence = nextSequence;
    seen.set(sequence, fingerprint);
    if (seen.size > 2000) seen.delete(seen.keys().next().value);
    if (gap) invalidate('book_sequence_gap', receivedAt);
    if (frame.type === 'unsubscribed') {
      invalidate('book_unsubscribed', receivedAt);
      return result('accepted');
    }
    // Control replies share the subscription sequence and must not be mistaken for lost deltas.
    if (frame.type === 'ok') return result('accepted', gap ? 'book_sequence_gap' : null);
    if (!['orderbook_snapshot', 'orderbook_delta'].includes(frame.type))
      return reject('unsupported_book_message');
    const message = frame.msg;
    const ticker = message?.market_ticker;
    if (!books.has(ticker)) return reject('unsubscribed_market');
    const current = books.get(ticker);
    const clock = readInteger(message.clock);
    if (clock === null) return reject('invalid_exchange_clock');
    if (frame.sending_ts_ms !== undefined && !isTime(frame.sending_ts_ms))
      return reject('invalid_sending_time');
    if (
      message.market_id !== undefined &&
      (typeof message.market_id !== 'string' ||
        !message.market_id ||
        message.market_id.length > 100)
    )
      return reject('invalid_market_id');
    if (
      current.marketId !== null &&
      message.market_id !== undefined &&
      message.market_id !== current.marketId
    )
      return reject('market_identity_changed');
    try {
      if (frame.type === 'orderbook_snapshot') {
        books.set(ticker, {
          ...emptyBook(ticker),
          valid: true,
          reason: null,
          receivedAt,
          sourceTime: null,
          sendingTime: frame.sending_ts_ms ?? null,
          sequence,
          subscriptionId,
          clock,
          snapshotClock: clock,
          marketId: message.market_id ?? null,
          yes: readLevels(message.yes_dollars_fp),
          no: readLevels(message.no_dollars_fp),
        });
        pendingSnapshots.delete(ticker);
        if (pendingSnapshots.size === 0) resyncRequired = false;
        return result('accepted', gap ? 'snapshot_replaced_after_gap' : null);
      }
      if (!current.valid || pendingSnapshots.has(ticker)) {
        resyncRequired = true;
        return result('ignored', 'delta_without_snapshot');
      }
      if (BigInt(clock) <= BigInt(current.snapshotClock) || BigInt(clock) < BigInt(current.clock))
        return reject('regressed_exchange_clock');
      if (!['yes', 'no'].includes(message.side)) return reject('invalid_book_side');
      const price = readPrice(message.price_dollars);
      const delta = parseDecimalUnits(message.delta_fp, 2);
      if (price === null || delta === null) return reject('invalid_book_delta');
      const sourceTime = readSourceTime(message);
      const levels = new Map(current[message.side]);
      const quantity = (levels.get(price.toString()) ?? 0n) + delta;
      if (quantity < 0n) return reject('negative_book_quantity');
      if (quantity === 0n) levels.delete(price.toString());
      else levels.set(price.toString(), quantity);
      books.set(ticker, {
        ...current,
        [message.side]: levels,
        receivedAt,
        sourceTime,
        sendingTime: frame.sending_ts_ms ?? null,
        sequence,
        clock,
        marketId: message.market_id ?? current.marketId,
      });
      return result('accepted');
    } catch {
      return reject('invalid_book_data');
    }
  };
  return { accept, invalidate, getSnapshot, requiresResync: () => resyncRequired };
};
