import 'server-only';
import { constants, createHash, createPrivateKey, sign } from 'node:crypto';
import {
  assertKalshiTicker,
  KalshiDataError,
  parseKalshiBenchmark,
  parseKalshiMarket,
  parseKalshiSeries,
} from './kalshi.validation';

const BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';
const REQUEST_TIMEOUT_MS = 8_000;
const MAXIMUM_RESPONSE_BYTES = 1_000_000;
const BENCHMARK_CACHE_MS = 1_000;
let benchmarkCache = null;
let benchmarkRequest = null;

async function readBoundedJson(response) {
  if (Number(response.headers?.get('content-length')) > MAXIMUM_RESPONSE_BYTES) {
    throw new KalshiDataError('Kalshi returned too much market data.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new KalshiDataError('Kalshi returned an empty market response.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAXIMUM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new KalshiDataError('Kalshi returned too much market data.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

async function fetchResource(path, { headers = {} } = {}) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const status = [400, 401, 403, 404, 429].includes(response.status) ? response.status : 502;
      throw new KalshiDataError('Kalshi market data is temporarily unavailable.', status);
    }
    return await readBoundedJson(response);
  } catch (error) {
    if (error instanceof KalshiDataError) throw error;
    if (['TimeoutError', 'AbortError'].includes(error?.name)) {
      throw new KalshiDataError('Kalshi took too long to respond. Please retry.', 504);
    }
    throw new KalshiDataError('Unable to load valid Kalshi market data. Please retry.');
  }
}

async function fetchSeries() {
  return parseKalshiSeries(await fetchResource('/series/KXBTC15M'));
}

export async function fetchKalshiMarkets() {
  const series = await fetchSeries();
  const maximumClose = Math.floor((Date.now() + 3 * 60 * 60_000) / 1_000);
  // The authoritative series shard prevents crypto markets silently disappearing
  // when an omitted exchange_index defaults to the old matching engine.
  const responses = await Promise.all(
    ['open', 'unopened'].map((status) =>
      fetchResource(
        `/markets?${new URLSearchParams({ series_ticker: 'KXBTC15M', status, limit: '100', exchange_index: String(series.exchangeIndex), max_close_ts: String(maximumClose) })}`,
      ),
    ),
  );
  const receivedAt = Date.now();
  const byTicker = new Map();
  for (const response of responses) {
    if (!Array.isArray(response?.markets) || response.markets.length > 100) {
      throw new KalshiDataError('Kalshi returned invalid Bitcoin markets.');
    }
    for (const row of response.markets) {
      const market = parseKalshiMarket(row, series, receivedAt);
      if (market.expiresAt > receivedAt) byTicker.set(market.ticker, market);
    }
  }
  return {
    markets: [...byTicker.values()]
      .sort((first, second) => first.expiresAt - second.expiresAt)
      .slice(0, 12),
    receivedAt,
  };
}

export async function fetchKalshiMarket(ticker) {
  assertKalshiTicker(ticker);
  const [series, response] = await Promise.all([
    fetchSeries(),
    fetchResource(`/markets/${encodeURIComponent(ticker)}`).catch((error) => {
      if (error.status !== 404) throw error;
      return fetchResource(`/historical/markets/${encodeURIComponent(ticker)}`);
    }),
  ]);
  const market = parseKalshiMarket(response, series);
  if (market.ticker !== ticker) throw new KalshiDataError('Kalshi returned a different market.');
  return market;
}

export function hasKalshiCredentials(environment = process.env) {
  return Boolean(environment.KALSHI_API_KEY_ID && environment.KALSHI_PRIVATE_KEY);
}

export function createKalshiReadHeaders(path, environment = process.env, now = Date.now()) {
  if (!hasKalshiCredentials(environment)) {
    throw new KalshiDataError('Configure server-side Kalshi credentials for BRTI access.', 503);
  }
  // Deliberately restricted to this one read-only endpoint; there is no general
  // signing proxy and no credential, portfolio, or trading route in the browser.
  if (path.split('?')[0] !== '/cfbenchmarks/values') {
    throw new KalshiDataError('This Kalshi resource is not supported.', 400);
  }
  try {
    const key = createPrivateKey(environment.KALSHI_PRIVATE_KEY.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'rsa') throw new Error('Invalid key type.');
    const timestamp = String(now);
    const signature = sign(
      'sha256',
      Buffer.from(`${timestamp}GET/trade-api/v2${path.split('?')[0]}`),
      {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
    );
    return {
      'KALSHI-ACCESS-KEY': environment.KALSHI_API_KEY_ID,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    };
  } catch {
    throw new KalshiDataError('The server-side Kalshi signing key is invalid.', 503);
  }
}

function unavailableBenchmark(status, reason) {
  return {
    status,
    available: false,
    current: null,
    samples: [],
    receivedAt: Date.now(),
    reason,
    source: 'CF Benchmarks BRTI',
  };
}

async function requestKalshiBenchmark() {
  const path = '/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND';
  try {
    const response = await fetchResource(path, { headers: createKalshiReadHeaders(path) });
    return parseKalshiBenchmark(response);
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      return unavailableBenchmark(
        'unauthorized',
        'Kalshi denied benchmark access. Check the server credentials and CF Benchmarks entitlement.',
      );
    }
    return unavailableBenchmark(
      'unavailable',
      error instanceof KalshiDataError
        ? error.message
        : 'Official BRTI data is temporarily unavailable.',
    );
  }
}

export async function fetchKalshiBenchmark({ expiresAt } = {}) {
  const now = Date.now();
  if (
    expiresAt !== undefined &&
    (!Number.isSafeInteger(expiresAt) || Math.abs(expiresAt - now) > 86_400_000)
  ) {
    throw new KalshiDataError('Select a benchmark deadline within one day of now.', 400);
  }
  if (!hasKalshiCredentials()) {
    return unavailableBenchmark(
      'not-configured',
      'Official BRTI access needs server-side Kalshi API credentials and account entitlement.',
    );
  }
  // Memoize only this fixed BRTI read. Credential rotation cannot reuse another
  // key's response, and a cold serverless instance simply fetches the full hour.
  const credentialFingerprint = createHash('sha256')
    .update(process.env.KALSHI_API_KEY_ID)
    .update('\0')
    .update(process.env.KALSHI_PRIVATE_KEY)
    .digest('hex');
  const cacheAge = now - (benchmarkCache?.receivedAt ?? 0);
  if (
    benchmarkCache?.credentialFingerprint === credentialFingerprint &&
    cacheAge >= 0 &&
    cacheAge < BENCHMARK_CACHE_MS
  ) {
    // Retain the original receipt time; serving cached data must not freshen it.
    return benchmarkCache.result;
  }
  if (benchmarkRequest?.credentialFingerprint === credentialFingerprint) {
    return benchmarkRequest.promise;
  }
  const promise = requestKalshiBenchmark();
  benchmarkRequest = { credentialFingerprint, promise };
  try {
    const result = await promise;
    if (benchmarkRequest?.promise === promise && ['live', 'stale'].includes(result.status)) {
      benchmarkCache = { credentialFingerprint, receivedAt: result.receivedAt, result };
    }
    return result;
  } finally {
    if (benchmarkRequest?.promise === promise) benchmarkRequest = null;
  }
}
