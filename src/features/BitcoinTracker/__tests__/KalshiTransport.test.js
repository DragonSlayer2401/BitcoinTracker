/** @jest-environment node */
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import { createKalshiTransport } from '../../../services/kalshi/kalshi.transport';
import { createKalshiRatePolicy } from '../../../services/kalshi/rateLimit/rateLimit.policy';
import { getKalshiCredentialFingerprint } from '../../../services/kalshi/kalshi.auth';
import { KalshiDataError } from '../../../services/kalshi/kalshi.validation';

jest.mock('server-only', () => ({}));

const timestamp = Date.parse('2026-09-10T22:00:00Z');
const limits = {
  usage_tier: 'basic',
  read: { refill_rate: 200, bucket_capacity: 400 },
  write: { refill_rate: 100, bucket_capacity: 100 },
};
const costs = {
  default_cost: 10,
  endpoint_costs: [{ method: 'GET', path: '/trade-api/v2/cfbenchmarks/*endpoint', cost: 50 }],
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const environment = {
  KALSHI_API_KEY_ID: 'transport-test-key',
  KALSHI_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const benchmarkPath = '/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND';
const response = (value, options) => Response.json(value, options);

function setup({ configured = true, cached = true, fetchResponse, reserve } = {}) {
  let currentTime = timestamp;
  const selectedEnvironment = configured ? environment : {};
  let policy = cached
    ? createKalshiRatePolicy(limits, costs, {
        credentialFingerprint: getKalshiCredentialFingerprint(selectedEnvironment),
        now: currentTime,
      })
    : null;
  const repository = {
    getPolicy: jest.fn(async () => policy),
    savePolicy: jest.fn(async (next) => {
      policy = next;
    }),
    reserve: jest.fn(reserve ?? (async () => ({ allowed: true, waitMs: 0 }))),
    block: jest.fn(async () => {}),
  };
  const request = jest.fn(
    fetchResponse ??
      (async (url) =>
        response(
          url.endsWith('/account/limits')
            ? limits
            : url.endsWith('/account/endpoint_costs')
              ? costs
              : { result: 'market data' },
        )),
  );
  const sleep = jest.fn(async (milliseconds) => {
    currentTime += milliseconds;
  });
  const transport = createKalshiTransport({
    getRepository: async () => repository,
    fetchResponse: request,
    getEnvironment: () => selectedEnvironment,
    now: () => currentTime,
    monotonicNow: () => currentTime,
    sleep,
  });
  return {
    transport,
    repository,
    request,
    sleep,
    advanceTime: (milliseconds) => {
      currentTime += milliseconds;
    },
  };
}

describe('Kalshi protected read transport', () => {
  it('discovers account limits and endpoint costs through the same limiter before market data', async () => {
    const { transport, repository, request } = setup({ cached: false });
    await transport.request(benchmarkPath);
    expect(request.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/trade-api/v2/account/limits',
      '/trade-api/v2/account/endpoint_costs',
      '/trade-api/v2/cfbenchmarks/values',
    ]);
    expect(repository.reserve.mock.calls.map(([value]) => [value.cost, value.bootstrap])).toEqual([
      [50, true],
      [50, true],
      [50, false],
    ]);
    expect(repository.savePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ refillRate: 100, bucketCapacity: 100 }),
    );
    for (const [url, options] of request.mock.calls) {
      expect(options.method).toBe('GET');
      expect(options).not.toHaveProperty('body');
      expect(options.redirect).toBe('error');
      const path = new URL(url).pathname;
      expect(
        verify(
          'sha256',
          Buffer.from(`${options.headers['KALSHI-ACCESS-TIMESTAMP']}GET${path}`),
          { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
          Buffer.from(options.headers['KALSHI-ACCESS-SIGNATURE'], 'base64'),
        ),
      ).toBe(true);
    }
  });

  it('deduplicates concurrent identical requests before spending tokens', async () => {
    const { transport, repository, request } = setup();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => transport.request(benchmarkPath)),
    );
    expect(results).toHaveLength(30);
    expect(repository.reserve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shares one policy discovery for different concurrent resources', async () => {
    const { transport, request, repository } = setup({ cached: false });
    await Promise.all([transport.request(benchmarkPath), transport.request('/series/KXBTC15M')]);
    expect(request.mock.calls.filter(([url]) => url.endsWith('/account/limits'))).toHaveLength(1);
    expect(repository.savePolicy).toHaveBeenCalledTimes(1);
  });

  it('signs at dispatch after waiting for permission to send', async () => {
    let calls = 0;
    const { transport, request, sleep } = setup({
      reserve: async () => (++calls === 1 ? { allowed: false, waitMs: 900 } : { allowed: true }),
    });
    await transport.request(benchmarkPath);
    expect(sleep).toHaveBeenCalledWith(900);
    expect(request.mock.calls[0][1].headers['KALSHI-ACCESS-TIMESTAMP']).toBe(
      String(timestamp + 900),
    );
  });

  it('stops a saturated queue without sending an upstream request', async () => {
    const { transport, request, sleep } = setup({
      reserve: async () => ({ allowed: false, waitMs: 10_000 }),
    });
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({ status: 429 });
    expect(request).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('discards a delayed successful admission without sending or refunding tokens', async () => {
    const { transport, repository, request, advanceTime } = setup();
    repository.reserve.mockImplementation(async () => {
      advanceTime(350);
      return { allowed: true };
    });
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({ status: 429 });
    expect(request).not.toHaveBeenCalled();
    expect(repository.reserve).toHaveBeenCalledTimes(1);
    expect(repository.savePolicy).not.toHaveBeenCalled();
  });

  it('enforces the overall queue deadline even if the final reservation succeeds', async () => {
    const { transport, repository, request, advanceTime } = setup();
    repository.reserve
      .mockResolvedValueOnce({ allowed: false, waitMs: 2800 })
      .mockImplementationOnce(async () => {
        advanceTime(201);
        return { allowed: true };
      });
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({ status: 429 });
    expect(request).not.toHaveBeenCalled();
  });

  it('persists Retry-After before surfacing an upstream limit and does not retry immediately', async () => {
    const { transport, repository, request } = setup({
      fetchResponse: async () => response({}, { status: 429, headers: { 'Retry-After': '12' } }),
    });
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 12000,
    });
    expect(repository.block).toHaveBeenCalledWith({ retryAfterMs: 12000 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses the shared exponential cooldown when Kalshi supplies no rate headers', async () => {
    const { transport, repository } = setup({
      fetchResponse: async () => response({}, { status: 429 }),
    });
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({ status: 429 });
    expect(repository.block).toHaveBeenCalledWith({ retryAfterMs: undefined });
  });

  it('does not send anything when shared storage is locked or unavailable', async () => {
    const { transport, repository, request } = setup();
    repository.reserve.mockRejectedValue(
      new KalshiDataError('The shared limiter is unavailable.', 503),
    );
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({ status: 503 });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not use a guessed authenticated budget if account discovery fails', async () => {
    const { transport, repository, request } = setup({
      cached: false,
      fetchResponse: async () => response({}, { status: 403 }),
    });
    await expect(transport.request(benchmarkPath)).rejects.toMatchObject({ status: 403 });
    expect(repository.savePolicy).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatch(/\/account\/limits$/);
  });

  it('throttles public contract reads too when credentials are absent', async () => {
    const { transport, request, repository } = setup({ configured: false, cached: false });
    await transport.request('/series/KXBTC15M');
    expect(repository.reserve).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(([url]) => url.endsWith('/account/limits'))).toBe(false);
    expect(request.mock.calls.every(([, options]) => !options.headers['KALSHI-ACCESS-KEY'])).toBe(
      true,
    );
  });

  it.each([
    '/portfolio/orders',
    '/account/api_usage_level/upgrade',
    'https://example.com/markets',
    '/markets/../portfolio/orders',
  ])('rejects unsupported resources without consuming quota: %s', async (path) => {
    const { transport, repository, request } = setup();
    await expect(transport.request(path)).rejects.toMatchObject({ status: 400 });
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
