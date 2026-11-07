import { parseDecimalUnits } from '@/utils/fixedPoint.utils';

const source = Object.freeze({ id: 'coinbase-btc-usd', kind: 'proxy', venue: 'coinbase-exchange' });
const instrument = 'BTC-USD';
const maximumSeen = 10_000;
const requiredChannels = ['matches', 'heartbeat', 'ticker', 'level2_batch'];
const isReceiptTime = (value) =>
  Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime());
const readId = (value) => {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,29})$/.test(value) ? value : null;
};
const readDecimal = (value, allowZero = false) => {
  const scale = typeof value === 'string' ? (value.split('.')[1]?.length ?? 0) : 0;
  const units = parseDecimalUnits(value, scale);
  return units !== null && (allowZero ? units >= 0n : units > 0n) ? value : null;
};
const compareDecimals = (left, right) => {
  const scale = Math.max(left.split('.')[1]?.length ?? 0, right.split('.')[1]?.length ?? 0);
  const difference = parseDecimalUnits(left, scale) - parseDecimalUnits(right, scale);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
const readTime = (value) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  )
    return null;
  const time = Date.parse(value);
  if (!isReceiptTime(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    return null;
  const fraction = (value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0');
  return {
    time,
    eventTime: value,
    nanoseconds: BigInt(time) * 1_000_000n + BigInt(fraction.slice(3) || '0'),
  };
};
const readLevel = (row, hasSide) => {
  if (!Array.isArray(row) || row.length !== (hasSide ? 3 : 2)) return null;
  const [price, size] = hasSide ? row.slice(1) : row;
  if (hasSide && !['buy', 'sell'].includes(row[0])) return null;
  if (readDecimal(price) === null || readDecimal(size, true) === null) return null;
  return { ...(hasSide ? { side: row[0] } : {}), price, size };
};
const readLevels = (rows, hasSide = false) => {
  if (!Array.isArray(rows) || rows.length > 50_000) return null;
  const levels = rows.map((row) => readLevel(row, hasSide));
  return levels.some((row) => row === null) ? null : levels;
};

/** Arrival-order normalization. Coinbase spot is a proxy, never a Kalshi settlement source.
 * Feed protocol: https://docs.cdp.coinbase.com/exchange/websocket-feed/channels
 * Reviewed 2026-11-06; public Exchange JSON protocol, no numbered release supplied.
 * Preserve raw frames in the caller. Deduplication only affects derived observations.
 */
export const createCoinbaseSpotNormalizer = ({ freshnessMs = 5000 } = {}) => {
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs <= 0)
    throw new Error('Invalid spot freshness interval.');
  let status = 'stopped';
  let connectionId = null;
  let lastReceivedAt = null;
  let subscribed = false;
  let latestObservation = null;
  let quote = null;
  let heartbeat = null;
  let lastTradeId = null;
  let pendingHeartbeat = null;
  let hasGap = false;
  const seen = new Map();
  const latestByType = new Map();

  const getSnapshot = (now) => {
    const fresh = (observation) =>
      Boolean(
        observation &&
        isReceiptTime(now) &&
        observation.receivedAt <= now &&
        observation.time !== null &&
        observation.time <= now &&
        BigInt(observation.eventTimeNanoseconds) <= BigInt(now) * 1_000_000n &&
        now - observation.time <= freshnessMs &&
        now - observation.receivedAt <= freshnessMs,
      );
    const reason =
      status !== 'connected'
        ? `connection_${status}`
        : !subscribed
          ? 'subscriptions_missing'
          : hasGap
            ? 'capture_gap'
            : pendingHeartbeat
              ? 'unconfirmed_trades'
              : !fresh(heartbeat)
                ? 'heartbeat_missing_or_stale'
                : !fresh(quote)
                  ? 'quote_missing_or_stale'
                  : null;
    return {
      source: { ...source },
      instrument,
      status,
      available: reason === null,
      reason,
      connectionId,
      lastReceivedAt,
      latestObservation,
      latestQuote: reason === null ? quote : null,
      heartbeatAt: heartbeat?.receivedAt ?? null,
      hasGap,
    };
  };

  const apply = (input) => {
    const receivedAt = isReceiptTime(input?.receivedAt) ? input.receivedAt : null;
    const output = {
      schemaVersion: 'coinbase-spot-normalized-v1',
      kind: input?.kind ?? null,
      connectionId: input?.connectionId ?? null,
      receivedAt,
      disposition: 'accepted',
      notes: [],
      gaps: [],
      observation: null,
    };
    const finish = () => ({ ...output, health: getSnapshot(lastReceivedAt) });
    const reject = (reason, disposition = 'invalid') => {
      output.disposition = disposition;
      output.notes.push(reason);
      return finish();
    };
    if (
      receivedAt === null ||
      !Number.isSafeInteger(input?.connectionId) ||
      input.connectionId < 0
    ) {
      hasGap = true;
      return reject('invalid_capture_envelope');
    }
    if (lastReceivedAt !== null && receivedAt < lastReceivedAt) {
      hasGap = true;
      output.gaps.push({ kind: 'receipt_time_regressed' });
      return reject('receipt_time_regressed', 'out_of_order');
    }
    lastReceivedAt = receivedAt;
    if (input.kind === 'connection') {
      if (
        !['connecting', 'connected', 'reconnecting', 'stopped', 'unavailable'].includes(input.state)
      )
        return reject('invalid_connection_state');
      if (connectionId !== null && input.connectionId < connectionId)
        return reject('obsolete_connection', 'out_of_order');
      connectionId = input.connectionId;
      status = input.state;
      if (status !== 'connected') {
        if (status === 'reconnecting')
          output.gaps.push({ kind: 'disconnect', reason: input.reason ?? null });
        subscribed = false;
        quote = null;
        heartbeat = null;
        latestByType.clear();
        pendingHeartbeat = null;
        lastTradeId = null;
        hasGap = status === 'reconnecting';
      }
      if (input.reason) output.notes.push(input.reason);
      return finish();
    }
    if (connectionId !== input.connectionId || status !== 'connected')
      return reject('inactive_connection', 'ignored');
    if (input.kind === 'clock') {
      if (pendingHeartbeat && receivedAt - pendingHeartbeat.receivedAt > 2000) {
        hasGap = true;
        output.gaps.push({
          kind: 'heartbeat_trade_gap',
          fromTradeId: pendingHeartbeat.fromTradeId,
          throughTradeId: pendingHeartbeat.tradeId,
        });
        pendingHeartbeat = null;
      }
      if (heartbeat && receivedAt - heartbeat.receivedAt > freshnessMs)
        output.notes.push('heartbeat_stale');
      return finish();
    }
    if (input.kind !== 'message' || typeof input.payload !== 'string')
      return reject('invalid_raw_frame');
    let message;
    try {
      message = JSON.parse(input.payload);
    } catch {
      hasGap = true;
      return reject('malformed_json');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      hasGap = true;
      return reject('invalid_message_object');
    }
    if (message.type === 'subscriptions') {
      subscribed =
        Array.isArray(message.channels) &&
        requiredChannels.every((name) =>
          message.channels.some(
            (channel) =>
              (channel.name === name ||
                (name === 'level2_batch' && channel.name === 'level2_50')) &&
              channel.product_ids?.includes(instrument),
          ),
        );
      return subscribed ? finish() : reject('subscriptions_missing');
    }
    if (message.type === 'error') {
      hasGap = true;
      return reject('source_error');
    }
    if (message.product_id !== instrument) return reject('unselected_instrument', 'ignored');
    if (
      !['match', 'last_match', 'ticker', 'heartbeat', 'snapshot', 'l2update'].includes(message.type)
    )
      return reject('unsupported_message_type', 'ignored');
    const isSnapshot = message.type === 'snapshot';
    const timestamp = isSnapshot ? null : readTime(message.time);
    if (!isSnapshot && !timestamp) {
      hasGap = true;
      return reject('invalid_event_time');
    }
    const sequence = message.sequence === undefined ? null : readId(message.sequence);
    if (message.sequence !== undefined && sequence === null) {
      hasGap = true;
      return reject('invalid_sequence');
    }
    const tradeId = ['match', 'last_match', 'ticker'].includes(message.type)
      ? readId(message.trade_id)
      : message.type === 'heartbeat'
        ? readId(message.last_trade_id)
        : null;
    if (['match', 'last_match', 'ticker', 'heartbeat'].includes(message.type) && tradeId === null) {
      hasGap = true;
      return reject('invalid_trade_id');
    }
    const observation = {
      schemaVersion: 'coinbase-spot-observation-v1',
      source: { ...source },
      instrument,
      kind: message.type,
      connectionId,
      receivedAt,
      eventTime: timestamp?.eventTime ?? null,
      eventTimeNanoseconds: timestamp?.nanoseconds.toString() ?? null,
      time: timestamp?.time ?? null,
      delayMs: timestamp ? receivedAt - timestamp.time : null,
      delayNanoseconds: timestamp
        ? (BigInt(receivedAt) * 1_000_000n - timestamp.nanoseconds).toString()
        : null,
      sequence,
      tradeId,
      baseCurrency: 'BTC',
      quoteCurrency: 'USD',
      timestampUnit: 'unix-ms',
      priceUnit: 'USD/BTC',
      quantityUnit: 'BTC',
    };
    if (['match', 'last_match', 'ticker'].includes(message.type)) {
      observation.price = readDecimal(message.price);
      if (observation.price === null) {
        hasGap = true;
        return reject('invalid_price');
      }
    }
    if (['match', 'last_match'].includes(message.type)) {
      observation.size = readDecimal(message.size);
      observation.makerSide = message.side;
      observation.aggressorSide = message.side === 'buy' ? 'sell' : 'buy';
      if (observation.size === null || !['buy', 'sell'].includes(message.side)) {
        hasGap = true;
        return reject('invalid_trade');
      }
    }
    if (message.type === 'ticker') {
      observation.bid = readDecimal(message.best_bid);
      observation.ask = readDecimal(message.best_ask);
      observation.bidSize =
        message.best_bid_size === undefined ? null : readDecimal(message.best_bid_size, true);
      observation.askSize =
        message.best_ask_size === undefined ? null : readDecimal(message.best_ask_size, true);
      if (
        observation.bid === null ||
        observation.ask === null ||
        compareDecimals(observation.bid, observation.ask) > 0 ||
        (message.best_bid_size !== undefined && observation.bidSize === null) ||
        (message.best_ask_size !== undefined && observation.askSize === null)
      ) {
        hasGap = true;
        return reject('invalid_best_bid_ask');
      }
    }
    if (isSnapshot) {
      observation.bids = readLevels(message.bids);
      observation.asks = readLevels(message.asks);
      if (observation.bids === null || observation.asks === null) {
        hasGap = true;
        return reject('invalid_book_snapshot');
      }
      output.notes.push('source_timestamp_unavailable', 'source_sequence_unavailable');
    }
    if (message.type === 'l2update') {
      observation.changes = readLevels(message.changes, true);
      if (observation.changes === null) {
        hasGap = true;
        return reject('invalid_book_changes');
      }
      output.notes.push('batch_timestamp_is_latest_event', 'source_sequence_unavailable');
    }
    const identity =
      message.type === 'match'
        ? `match:${tradeId}`
        : message.type === 'ticker' && sequence !== null
          ? `ticker:${sequence}`
          : message.type === 'heartbeat'
            ? `heartbeat:${tradeId}:${message.time}`
            : null;
    const semantic = JSON.stringify({
      ...observation,
      connectionId: null,
      receivedAt: null,
      delayMs: null,
      delayNanoseconds: null,
    });
    if (identity && seen.has(identity)) {
      if (seen.get(identity) !== semantic) {
        hasGap = true;
        return reject('conflicting_event_id');
      }
      return reject('duplicate_event_id', 'duplicate');
    }
    const previous = latestByType.get(message.type);
    if (
      previous &&
      (timestamp.nanoseconds < previous.nanoseconds ||
        (sequence !== null &&
          previous.sequence !== null &&
          BigInt(sequence) < BigInt(previous.sequence)))
    ) {
      output.gaps.push({ kind: 'out_of_order', messageType: message.type });
      return reject('event_order_regressed', 'out_of_order');
    }
    if (message.type === 'match') {
      if (lastTradeId !== null && BigInt(tradeId) <= BigInt(lastTradeId))
        return reject('trade_id_regressed', 'out_of_order');
      if (lastTradeId !== null && BigInt(tradeId) !== BigInt(lastTradeId) + 1n) {
        hasGap = true;
        output.gaps.push({
          kind: 'trade_id_gap',
          fromTradeId: (BigInt(lastTradeId) + 1n).toString(),
          throughTradeId: (BigInt(tradeId) - 1n).toString(),
        });
      }
      lastTradeId = tradeId;
      if (pendingHeartbeat && BigInt(tradeId) >= BigInt(pendingHeartbeat.tradeId))
        pendingHeartbeat = null;
    } else if (message.type === 'last_match') {
      if (lastTradeId === null) lastTradeId = tradeId;
      output.notes.push('subscription_baseline_not_new_trade');
    } else if (message.type === 'heartbeat') {
      if (lastTradeId === null) {
        lastTradeId = tradeId;
        output.notes.push('subscription_baseline');
      } else if (BigInt(tradeId) > BigInt(lastTradeId))
        pendingHeartbeat = {
          tradeId,
          fromTradeId: (BigInt(lastTradeId) + 1n).toString(),
          receivedAt: pendingHeartbeat?.receivedAt ?? receivedAt,
        };
      heartbeat = observation;
    } else if (message.type === 'ticker') quote = observation;
    if (timestamp) latestByType.set(message.type, { nanoseconds: timestamp.nanoseconds, sequence });
    if (identity) {
      seen.set(identity, semantic);
      if (seen.size > maximumSeen) seen.delete(seen.keys().next().value);
    }
    latestObservation = observation;
    output.observation = observation;
    return finish();
  };
  return { apply, getSnapshot };
};
