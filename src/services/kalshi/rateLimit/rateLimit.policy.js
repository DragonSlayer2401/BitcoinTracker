import { assertKalshiTicker, KalshiDataError } from '../kalshi.validation';

const POLICY_LIFETIME_MS = 5 * 60_000;
const MAXIMUM_READ_TOKENS = 100;
const MARKET_QUERY_NAMES = new Set([
  'series_ticker',
  'status',
  'limit',
  'exchange_index',
  'max_close_ts',
]);
const BENCHMARK_HISTORY_QUERY_NAMES = new Set(['id', 'timespan', 'timestamp', 'maxResolution']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function rejectResource() {
  throw new KalshiDataError('This Kalshi read resource is not supported.', 400);
}

function rejectPolicy() {
  throw new KalshiDataError('Kalshi returned invalid API limits or endpoint costs.');
}

function isInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function isQueryInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)$/.test(value) &&
    isInteger(Number(value), minimum) &&
    Number(value) <= maximum
  );
}

function isEncodedHistoryHour(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}%3A00%3A00\.000Z$/.test(value)) return false;
  const timestamp = value.replaceAll('%3A', ':');
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === timestamp;
}

// This is the complete outbound resource allowlist, not a general signing proxy.
// Reject encoded or normalized aliases before URL parsing can hide their original path.
export function getKalshiReadResource(path) {
  if (
    typeof path !== 'string' ||
    path.length > 512 ||
    !path.startsWith('/') ||
    path.includes('//')
  ) {
    rejectResource();
  }
  const [pathname, query, extraQuery] = path.split('?');
  if (/[^A-Za-z0-9/_-]/.test(pathname) || extraQuery !== undefined || query === '') {
    rejectResource();
  }
  const isBenchmarkHistory = pathname === '/cfbenchmarks/history/values';
  const parameters = new Map();
  if (query !== undefined) {
    for (const pair of query.split('&')) {
      const [name, value, extraValue] = pair.split('=');
      if (
        !name ||
        !value ||
        /[^A-Za-z0-9_-]/.test(name) ||
        extraValue !== undefined ||
        parameters.has(name) ||
        (isBenchmarkHistory && name === 'timestamp'
          ? !isEncodedHistoryHour(value)
          : /[^A-Za-z0-9_-]/.test(value))
      ) {
        rejectResource();
      }
      parameters.set(name, value);
    }
  }

  const isBenchmark = pathname === '/cfbenchmarks/values' || isBenchmarkHistory;
  const isDiscovery = ['/account/limits', '/account/endpoint_costs'].includes(pathname);
  if (isBenchmarkHistory) {
    if (
      parameters.get('id') !== 'BRTI' ||
      parameters.get('timespan') !== 'HOUR' ||
      !parameters.has('timestamp') ||
      [...parameters.keys()].some((name) => !BENCHMARK_HISTORY_QUERY_NAMES.has(name)) ||
      (parameters.has('maxResolution') && parameters.get('maxResolution') !== 'PER_SECOND')
    ) {
      rejectResource();
    }
  } else if (isBenchmark) {
    if (
      parameters.get('id') !== 'BRTI' ||
      [...parameters.keys()].some((name) => !['id', 'maxResolution'].includes(name)) ||
      (parameters.has('maxResolution') && parameters.get('maxResolution') !== 'PER_SECOND')
    ) {
      rejectResource();
    }
  } else if (pathname === '/markets') {
    if (
      parameters.get('series_ticker') !== 'KXBTC15M' ||
      [...parameters.keys()].some((name) => !MARKET_QUERY_NAMES.has(name)) ||
      (parameters.has('status') && !['open', 'unopened'].includes(parameters.get('status'))) ||
      (parameters.has('limit') && !isQueryInteger(parameters.get('limit'), 1, 100)) ||
      (parameters.has('exchange_index') &&
        !isQueryInteger(parameters.get('exchange_index'), 0, 100)) ||
      (parameters.has('max_close_ts') && !isQueryInteger(parameters.get('max_close_ts'), 1))
    ) {
      rejectResource();
    }
  } else {
    if (parameters.size) rejectResource();
    if (!isDiscovery && pathname !== '/series/KXBTC15M') {
      const marketMatch = /^\/(?:historical\/)?markets\/([^/]+)$/.exec(pathname);
      if (!marketMatch) rejectResource();
      assertKalshiTicker(marketMatch[1]);
    }
  }
  return { path: pathname, isBenchmark, isDiscovery };
}

function getEndpointPattern(path) {
  if (
    typeof path !== 'string' ||
    path.length > 512 ||
    !path.startsWith('/') ||
    /[^A-Za-z0-9_./:{}*-]/.test(path) ||
    path.includes('//')
  ) {
    rejectPolicy();
  }
  const relativePath = path.startsWith('/trade-api/v2/')
    ? path.slice('/trade-api/v2'.length)
    : path;
  const segments = relativePath.slice(1).split('/');
  const pattern = segments.map((segment, index) => {
    if (
      segment === '*' ||
      /^\*[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ||
      /^\{\*[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)
    ) {
      if (index !== segments.length - 1) rejectPolicy();
      return '.*';
    }
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment) || /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return '[^/]+';
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(segment) || ['.', '..'].includes(segment)) rejectPolicy();
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^/${pattern.join('/')}$`);
}

function getReportedBucket(bucket, minimum) {
  if (!isInteger(bucket?.refill_rate, minimum) || !isInteger(bucket?.bucket_capacity, minimum)) {
    rejectPolicy();
  }
  return { refill_rate: bucket.refill_rate, bucket_capacity: bucket.bucket_capacity };
}

export function createKalshiRatePolicy(
  limits,
  costs,
  { credentialFingerprint, now = Date.now() } = {},
) {
  const reportedRead = getReportedBucket(limits?.read, 1);
  const reportedWrite = getReportedBucket(limits?.write, 0);
  if (
    !isInteger(now) ||
    !isInteger(now + POLICY_LIFETIME_MS) ||
    !isInteger(costs?.default_cost) ||
    !Array.isArray(costs?.endpoint_costs) ||
    costs.endpoint_costs.length > 2_048
  ) {
    rejectPolicy();
  }
  const endpointCosts = costs.endpoint_costs.map((endpoint) => {
    if (!HTTP_METHODS.has(endpoint?.method) || !isInteger(endpoint?.cost)) rejectPolicy();
    getEndpointPattern(endpoint.path);
    return { method: endpoint.method, path: endpoint.path, cost: endpoint.cost };
  });
  return {
    credentialFingerprint,
    checkedAt: now,
    expiresAt: now + POLICY_LIFETIME_MS,
    refillRate: Math.min(MAXIMUM_READ_TOKENS, reportedRead.refill_rate * 0.5),
    bucketCapacity: Math.min(MAXIMUM_READ_TOKENS, reportedRead.bucket_capacity * 0.5),
    defaultCost: costs.default_cost,
    endpointCosts,
    reportedRead,
    reportedWrite,
  };
}

export function getKalshiReadCost(policy, path) {
  const resource = getKalshiReadResource(path);
  if (!isInteger(policy?.defaultCost) || !Array.isArray(policy?.endpointCosts)) rejectPolicy();
  // Keep the documented floors even if discovery reports a lower cost. When
  // multiple routes match, reserve the largest cost rather than guessing priority.
  let cost = Math.max(resource.isBenchmark ? 50 : 10, policy.defaultCost);
  for (const endpoint of policy.endpointCosts) {
    if (!HTTP_METHODS.has(endpoint?.method) || !isInteger(endpoint?.cost)) rejectPolicy();
    const pattern = getEndpointPattern(endpoint.path);
    if (endpoint.method === 'GET' && pattern.test(resource.path)) {
      cost = Math.max(cost, endpoint.cost);
    }
  }
  return cost;
}
