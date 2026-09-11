import 'server-only';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { KalshiDataError } from './kalshi.validation';
import {
  createKalshiReadHeaders,
  getKalshiCredentialFingerprint,
  hasKalshiCredentials,
} from './kalshi.auth';
import {
  createKalshiRatePolicy,
  getKalshiReadCost,
  getKalshiReadResource,
} from './rateLimit/rateLimit.policy';
import { getKalshiRateLimitRepository } from './rateLimit/rateLimit.repository';

const BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';
const REQUEST_TIMEOUT_MS = 8_000;
const MAXIMUM_WAIT_MS = 3_000;
const MAXIMUM_ADMISSION_AGE_MS = 250;
const MAXIMUM_RESPONSE_BYTES = 1_000_000;
const BASIC_LIMITS = {
  read: { refill_rate: 200, bucket_capacity: 200 },
  write: { refill_rate: 100, bucket_capacity: 100 },
};

async function readBoundedJson(response) {
  if (Number(response.headers?.get('content-length')) > MAXIMUM_RESPONSE_BYTES) {
    await response.body?.cancel();
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

function getRetryDelay(response, now) {
  const value = response.headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) &&
    milliseconds > 0 &&
    milliseconds < Number.MAX_SAFE_INTEGER - now
    ? Math.ceil(milliseconds)
    : undefined;
}

/** One transport owns every upstream read, including discovery and diagnostics. */
export function createKalshiTransport({
  getRepository = getKalshiRateLimitRepository,
  fetchResponse = (...args) => fetch(...args),
  getEnvironment = () => process.env,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  sleep = delay,
} = {}) {
  const policiesInFlight = new Map();
  const requestsInFlight = new Map();

  async function send(path, { repository, environment, bootstrap = false, policy } = {}) {
    const resource = getKalshiReadResource(path);
    const fingerprint = getKalshiCredentialFingerprint(environment);
    // Validate the key before touching the limiter; sign again only after admission.
    if (hasKalshiCredentials(environment)) createKalshiReadHeaders(path, environment, now());
    if (resource.isBenchmark && !hasKalshiCredentials(environment)) {
      throw new KalshiDataError('Configure server-side Kalshi credentials for BRTI access.', 503);
    }
    const startedAt = monotonicNow();
    let waitedMs = 0;
    let admissionStartedAt;
    const assertFreshAdmission = () => {
      if (
        monotonicNow() - startedAt >= MAXIMUM_WAIT_MS ||
        monotonicNow() - admissionStartedAt > MAXIMUM_ADMISSION_AGE_MS
      ) {
        // Never refund a delayed permit: other workers have already used the shared balance.
        throw new KalshiDataError(
          'Kalshi request permission expired before dispatch. Please retry shortly.',
          429,
        );
      }
    };
    while (true) {
      admissionStartedAt = monotonicNow();
      const reservation = await repository.reserve({
        path,
        credentialFingerprint: fingerprint,
        cost: bootstrap ? 50 : getKalshiReadCost(policy, path),
        bootstrap,
      });
      if (reservation.allowed) {
        assertFreshAdmission();
        break;
      }
      const waitMs = Math.max(1, Math.ceil(reservation.waitMs));
      if (
        !Number.isFinite(waitMs) ||
        Math.max(waitedMs, monotonicNow() - startedAt) + waitMs >= MAXIMUM_WAIT_MS
      ) {
        const error = new KalshiDataError(
          'Kalshi read requests are paused by the shared rate limiter. Please retry shortly.',
          429,
        );
        error.retryAfterMs = waitMs;
        throw error;
      }
      await sleep(waitMs);
      waitedMs += waitMs;
    }
    const headers = {
      Accept: 'application/json',
      ...(hasKalshiCredentials(environment)
        ? createKalshiReadHeaders(path, environment, now())
        : {}),
    };
    assertFreshAdmission();
    const response = await fetchResponse(`${BASE_URL}${path}`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 429) {
      // Persist a cooldown for every worker and collector before the caller retries.
      const retryAfterMs = getRetryDelay(response, now());
      const cooldown = await repository.block({ retryAfterMs });
      await response.body?.cancel();
      const error = new KalshiDataError(
        'Kalshi requested a pause. All app and collector reads are backing off together.',
        429,
      );
      error.retryAfterMs = cooldown?.waitMs ?? retryAfterMs ?? 2000;
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const status = [400, 401, 403, 404].includes(response.status) ? response.status : 502;
      throw new KalshiDataError('Kalshi market data is temporarily unavailable.', status);
    }
    return readBoundedJson(response);
  }

  async function getPolicy(repository, environment) {
    const credentialFingerprint = getKalshiCredentialFingerprint(environment);
    const existing = await repository.getPolicy(credentialFingerprint);
    if (existing) return existing;
    if (policiesInFlight.has(credentialFingerprint))
      return policiesInFlight.get(credentialFingerprint);
    const request = (async () => {
      // Discovery itself is charged to the same persisted bucket, at >=50 tokens/read.
      const limits = hasKalshiCredentials(environment)
        ? await send('/account/limits', { repository, environment, bootstrap: true })
        : BASIC_LIMITS;
      const costs = await send('/account/endpoint_costs', {
        repository,
        environment,
        bootstrap: true,
      });
      const policy = createKalshiRatePolicy(limits, costs, {
        credentialFingerprint,
        now: now(),
      });
      await repository.savePolicy(policy);
      return policy;
    })();
    policiesInFlight.set(credentialFingerprint, request);
    try {
      return await request;
    } finally {
      policiesInFlight.delete(credentialFingerprint);
    }
  }

  async function request(path) {
    getKalshiReadResource(path);
    const environment = { ...getEnvironment() };
    const key = `${getKalshiCredentialFingerprint(environment)}:${path}`;
    if (requestsInFlight.has(key)) return requestsInFlight.get(key);
    const pending = (async () => {
      try {
        // A broken key or shared store must never fall back to unbudgeted public reads.
        if (hasKalshiCredentials(environment)) createKalshiReadHeaders(path, environment, now());
        const repository = await getRepository();
        const policy = await getPolicy(repository, environment);
        return await send(path, { repository, environment, policy });
      } catch (error) {
        if (error instanceof KalshiDataError) throw error;
        if (['TimeoutError', 'AbortError'].includes(error?.name)) {
          throw new KalshiDataError('Kalshi took too long to respond. Please retry.', 504);
        }
        throw new KalshiDataError('Unable to load valid Kalshi market data. Please retry.');
      }
    })();
    requestsInFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      requestsInFlight.delete(key);
    }
  }
  return { request };
}

const transport = createKalshiTransport();
export const fetchKalshiResource = (path) => transport.request(path);
