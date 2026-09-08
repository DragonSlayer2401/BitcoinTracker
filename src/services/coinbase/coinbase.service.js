const COINBASE_BASE_URL = 'https://api.exchange.coinbase.com';
const REQUEST_TIMEOUT_MS = 8_000;
const CLOCK_TOLERANCE_MS = 60_000;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function parseDecimal(value, field, allowZero = false) {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`Invalid Coinbase ${field}.`);
  }

  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw new Error(`Invalid Coinbase ${field}.`);
  }

  return number;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Exchange timestamps identify the last trade, not the time the request was received.
// https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker
export function parseTicker(payload, receivedAt = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid Coinbase ticker.');
  }

  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
    throw new Error('Invalid ticker receipt time.');
  }

  const { time: timestamp } = payload;
  const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;

  if (
    typeof timestamp !== 'string' ||
    !UTC_TIMESTAMP_PATTERN.test(timestamp) ||
    !Number.isFinite(time) ||
    time <= 0 ||
    time > receivedAt + CLOCK_TOLERANCE_MS ||
    new Date(time).toISOString().slice(0, 19) !== timestamp.slice(0, 19)
  ) {
    throw new Error('Invalid Coinbase ticker time.');
  }

  const price = parseDecimal(payload.price, 'ticker price');
  const bid = parseDecimal(payload.bid, 'ticker bid');
  const ask = parseDecimal(payload.ask, 'ticker ask');
  const volume = parseDecimal(payload.volume, 'ticker volume', true);

  if (bid > ask) {
    throw new Error('Invalid Coinbase bid and ask.');
  }

  return { price, time, receivedAt, bid, ask, volume };
}

// Coinbase candle tuples: [bucket start seconds, low, high, open, close, volume].
// Missing intervals remain missing; no synthetic candles or prices are created.
// https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles
export function parseCandles(payload, receivedAt = Date.now()) {
  if (!Array.isArray(payload)) {
    throw new Error('Invalid Coinbase candles.');
  }

  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) {
    throw new Error('Invalid candle receipt time.');
  }

  const candlesByTime = new Map();

  for (const row of payload) {
    if (!Array.isArray(row) || row.length !== 6) {
      throw new Error('Invalid Coinbase candle.');
    }

    const [seconds, low, high, open, close, volume] = row;
    const time = seconds * 1_000;

    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      seconds % 60 !== 0 ||
      !Number.isSafeInteger(time) ||
      time > receivedAt + CLOCK_TOLERANCE_MS ||
      ![low, high, open, close].every(isPositiveNumber) ||
      typeof volume !== 'number' ||
      !Number.isFinite(volume) ||
      volume < 0 ||
      low > high ||
      open < low ||
      open > high ||
      close < low ||
      close > high
    ) {
      throw new Error('Invalid Coinbase candle values.');
    }

    const candle = { time, open, high, low, close, volume };
    const previous = candlesByTime.get(time);

    if (
      previous &&
      ['open', 'high', 'low', 'close', 'volume'].some((field) => previous[field] !== candle[field])
    ) {
      throw new Error('Conflicting Coinbase candles for the same minute.');
    }

    candlesByTime.set(time, candle);
  }

  return [...candlesByTime.values()].sort((first, second) => first.time - second.time);
}

export class MarketDataError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'MarketDataError';
    this.status = status;
  }
}

async function fetchCoinbaseResource(path, parseResponse) {
  let response;

  try {
    response = await fetch(`${COINBASE_BASE_URL}${path}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new MarketDataError('Coinbase took too long to respond. Please retry.', 504);
    }

    throw new MarketDataError('Unable to reach Coinbase market data. Please retry.');
  }

  if (!response.ok) {
    throw new MarketDataError('Coinbase market data is temporarily unavailable. Please retry.');
  }

  try {
    return parseResponse(await response.json());
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new MarketDataError('Coinbase took too long to respond. Please retry.', 504);
    }

    throw new MarketDataError('Coinbase returned invalid market data. Please retry.');
  }
}

export function fetchCoinbaseTicker() {
  return fetchCoinbaseResource('/products/BTC-USD/ticker', parseTicker);
}

export function fetchCoinbaseCandles() {
  const requestStartedAt = Date.now();
  const completedThrough = Math.floor(requestStartedAt / 60_000) * 60_000;
  // The default upstream window can be cached for five minutes. An explicit rolling
  // window requests the current completed history and has a stable key each minute.
  const parameters = new URLSearchParams({
    granularity: '60',
    start: new Date(completedThrough - 180 * 60_000).toISOString(),
    end: new Date(completedThrough).toISOString(),
  });

  return fetchCoinbaseResource(`/products/BTC-USD/candles?${parameters}`, (payload) =>
    // A partial snapshot must never become a completed candle just because time passes.
    // Use request start so crossing a minute boundary during the fetch cannot include it.
    parseCandles(payload).filter((candle) => candle.time + 60_000 <= requestStartedAt),
  );
}
