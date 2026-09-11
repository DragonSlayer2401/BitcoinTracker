import 'server-only';
import { getKalshiCredentialFingerprint, hasKalshiCredentials } from './kalshi.auth';
import { fetchKalshiResource as fetchResource } from './kalshi.transport';
export { createKalshiReadHeaders, hasKalshiCredentials } from './kalshi.auth';
import {
  assertKalshiTicker,
  KalshiDataError,
  parseKalshiBenchmark,
  parseKalshiMarket,
  parseKalshiSeries,
} from './kalshi.validation';

const BENCHMARK_CACHE_MS = 1_000;
let benchmarkCache = null;
let benchmarkRequest = null;

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
    const response = await fetchResource(path);
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
  const credentialFingerprint = getKalshiCredentialFingerprint();
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
