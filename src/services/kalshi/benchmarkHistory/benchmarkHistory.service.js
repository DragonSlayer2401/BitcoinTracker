import 'server-only';
import { getKalshiCredentialFingerprint, hasKalshiCredentials } from '../kalshi.auth';
import { fetchKalshiResource } from '../kalshi.transport';
import {
  BENCHMARK_HISTORY_HOUR_MS,
  parseBenchmarkHistoryHour,
  validateBenchmarkHistoryRange,
} from './benchmarkHistory.validation';

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const MAXIMUM_CACHE_ENTRIES = 32;

function getHistoryFailureReason(error) {
  if ([401, 403].includes(error?.status)) {
    return 'Kalshi denied historical BRTI access. The account may need historical data entitlement.';
  }
  if (error?.status === 429) {
    return 'Historical BRTI requests are waiting for the shared Kalshi read allowance.';
  }
  return 'Some historical BRTI data is temporarily unavailable.';
}

export function createBenchmarkHistoryService({
  fetchResource = fetchKalshiResource,
  now = Date.now,
  getCredentialFingerprint = getKalshiCredentialFingerprint,
  hasCredentials = hasKalshiCredentials,
} = {}) {
  const cache = new Map();
  const requests = new Map();

  async function fetchHour(startsAt, credentialFingerprint) {
    const key = `${credentialFingerprint}:${startsAt}`;
    const existing = cache.get(key);
    const cacheAge = now() - (existing?.receivedAt ?? 0);
    if (existing && cacheAge >= 0 && cacheAge < existing.ttl) return existing.result;
    if (requests.has(key)) return requests.get(key);

    const promise = (async () => {
      let result;
      try {
        const parameters = new URLSearchParams({
          id: 'BRTI',
          timespan: 'HOUR',
          timestamp: new Date(startsAt).toISOString(),
        });
        const response = await fetchResource(`/cfbenchmarks/history/values?${parameters}`);
        const samples = parseBenchmarkHistoryHour(response, startsAt);
        result = {
          samples,
          reason: samples.length ? null : 'Some historical BRTI data has not been published yet.',
          rateLimited: false,
        };
      } catch (error) {
        result = {
          samples: [],
          reason: getHistoryFailureReason(error),
          rateLimited: error?.status === 429,
        };
      }
      if (hasCredentials() && getCredentialFingerprint() === credentialFingerprint) {
        cache.delete(key);
        cache.set(key, {
          receivedAt: now(),
          ttl: result.samples.length ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS,
          result,
        });
        while (cache.size > MAXIMUM_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      }
      return result;
    })();
    requests.set(key, promise);
    try {
      return await promise;
    } finally {
      if (requests.get(key) === promise) requests.delete(key);
    }
  }

  return {
    async fetchBenchmarkHistory(options = {}) {
      const range = validateBenchmarkHistoryRange(options, now());
      const hourStarts = Array.from(
        { length: range.hours },
        (_, index) => range.startsAt + index * BENCHMARK_HISTORY_HOUR_MS,
      );
      const unavailable = (reason) => ({
        ...range,
        samples: [],
        receivedAt: now(),
        status: 'unavailable',
        available: false,
        reason,
        missingHours: hourStarts,
      });
      if (!hasCredentials()) {
        return unavailable(
          'Historical BRTI access needs server-side Kalshi credentials and account entitlement.',
        );
      }
      const credentialFingerprint = getCredentialFingerprint();
      const samples = [];
      const missingHours = [];
      let reason = null;
      let rateLimited = false;
      // Load fixed completed hours sequentially, reusing overlapping ranges.
      // All network reads still pass through the shared, GET-only Kalshi limiter.
      for (const startsAt of hourStarts) {
        if (!hasCredentials() || getCredentialFingerprint() !== credentialFingerprint) {
          return unavailable(
            'Kalshi credentials changed while loading historical BRTI data. Retry the range.',
          );
        }
        if (rateLimited) {
          missingHours.push(startsAt);
          continue;
        }
        const result = await fetchHour(startsAt, credentialFingerprint);
        if (result.samples.length) samples.push(...result.samples);
        else missingHours.push(startsAt);
        reason = result.reason ?? reason;
        rateLimited = result.rateLimited;
      }
      if (!hasCredentials() || getCredentialFingerprint() !== credentialFingerprint) {
        return unavailable(
          'Kalshi credentials changed while loading historical BRTI data. Retry the range.',
        );
      }
      return {
        ...range,
        samples,
        receivedAt: now(),
        status: missingHours.length ? (samples.length ? 'partial' : 'unavailable') : 'available',
        available: samples.length > 0,
        reason,
        missingHours,
      };
    },
  };
}

const benchmarkHistoryService = createBenchmarkHistoryService();
export const fetchBenchmarkHistory = (options) =>
  benchmarkHistoryService.fetchBenchmarkHistory(options);
