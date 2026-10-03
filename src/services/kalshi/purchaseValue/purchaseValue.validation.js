import { assertKalshiTicker, KalshiDataError } from '../kalshi.validation';

const decimal = (value, digits) =>
  typeof value === 'string' && new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`).test(value)
    ? Number(value)
    : NaN;

function parseBidLevels(levels) {
  if (!Array.isArray(levels) || levels.length > 100) {
    throw new KalshiDataError('Kalshi returned invalid purchase depth.');
  }
  const prices = new Set();
  return levels
    .map((level) => {
      const price = decimal(level?.[0], 4);
      const quantity = decimal(level?.[1], 2);
      if (
        !Array.isArray(level) ||
        level.length !== 2 ||
        !Number.isFinite(price) ||
        price <= 0 ||
        price >= 1 ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        quantity > 1_000_000_000 ||
        prices.has(price)
      )
        throw new KalshiDataError('Kalshi returned invalid purchase depth.');
      prices.add(price);
      return { price, quantity };
    })
    .sort((first, second) => second.price - first.price);
}

/** Kalshi supplies bids only: buying Yes consumes the complementary No bids. */
export function parseKalshiPurchaseBook(payload, ticker, receivedAt) {
  assertKalshiTicker(ticker);
  const yes = parseBidLevels(payload?.orderbook_fp?.yes_dollars);
  const no = parseBidLevels(payload?.orderbook_fp?.no_dollars);
  if (yes.length && no.length && yes[0].price + no[0].price > 1 + 1e-9) {
    throw new KalshiDataError('Kalshi returned a crossed purchase book.');
  }
  const asks = (bids) =>
    bids.map(({ price, quantity }) => ({
      price: Number((1 - price).toFixed(4)),
      quantity,
    }));
  return { ticker, receivedAt, yesAsks: asks(no), noAsks: asks(yes), depthLimit: 100 };
}

/** An incomplete event-override history cannot establish the applicable series fee. */
export function parseKalshiPurchaseFees(seriesPayload, eventPayload, eventTicker, now) {
  const unavailable = (reason) => ({ available: false, reason, checkedAt: now });
  const series = seriesPayload?.series;
  const changes = eventPayload?.event_fee_changes;
  if (
    series?.ticker !== 'KXBTC15M' ||
    !Array.isArray(changes) ||
    changes.length > 100 ||
    eventPayload?.cursor !== ''
  ) {
    return unavailable('The applicable event fees could not be fully verified.');
  }
  let latest = null;
  let validUntil = now + 30_000;
  const times = new Set();
  for (const change of changes) {
    const at = typeof change?.scheduled_ts === 'string' ? Date.parse(change.scheduled_ts) : NaN;
    if (
      change?.event_ticker !== eventTicker ||
      change?.series_ticker !== 'KXBTC15M' ||
      !Number.isSafeInteger(at) ||
      times.has(at)
    ) {
      return unavailable('The applicable event fees could not be fully verified.');
    }
    times.add(at);
    if (at > now) validUntil = Math.min(validUntil, at);
    else if (!latest || at > latest.at) latest = { ...change, at };
  }
  const cleared = latest?.fee_type_override === null && latest?.fee_multiplier_override === null;
  const type = latest && !cleared ? latest.fee_type_override : series.fee_type;
  const multiplier = latest && !cleared ? latest.fee_multiplier_override : series.fee_multiplier;
  if (
    type !== 'quadratic' ||
    !Number.isFinite(multiplier) ||
    multiplier < 0 ||
    multiplier > 100 ||
    Math.abs(multiplier * 10_000 - Math.round(multiplier * 10_000)) > 1e-7
  ) {
    return unavailable('This fee schedule is unsupported; net value is unavailable.');
  }
  return {
    available: true,
    type,
    multiplier,
    checkedAt: now,
    validUntil,
    source: latest && !cleared ? 'event override' : 'series',
    sourceUrl: 'https://kalshi.com/docs/kalshi-fee-schedule.pdf',
  };
}
