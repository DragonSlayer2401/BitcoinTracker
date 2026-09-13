/** @jest-environment node */
import {
  createBenchmarkHistoryService,
  fetchBenchmarkHistory,
} from '../../../services/kalshi/benchmarkHistory/benchmarkHistory.service';
import {
  parseBenchmarkHistoryHour,
  readBenchmarkHistoryQuery,
  validateBenchmarkHistoryRange,
} from '../../../services/kalshi/benchmarkHistory/benchmarkHistory.validation';
import { hasKalshiCredentials } from '../../../services/kalshi/kalshi.auth';
import * as historyRoute from '../../../app/api/kalshi/benchmark/history/route';

jest.mock('server-only', () => ({}));
jest.mock('../../../services/kalshi/kalshi.auth', () => ({
  ...jest.requireActual('../../../services/kalshi/kalshi.auth'),
  hasKalshiCredentials: jest.fn(() => true),
}));
jest.mock('../../../services/kalshi/benchmarkHistory/benchmarkHistory.service', () => ({
  ...jest.requireActual('../../../services/kalshi/benchmarkHistory/benchmarkHistory.service'),
  fetchBenchmarkHistory: jest.fn(),
}));

const HOUR = 3_600_000;
const endingAt = Date.parse('2026-09-13T06:00:00.000Z');
const currentTime = endingAt + 15 * 60_000;
const start = endingAt - HOUR;
const payload = (rows) => ({ data: { payload: rows } });
const row = (time = start, value = '77000.25') => ({ time, value });

function setup(options = {}) {
  let clock = currentTime;
  let fingerprint = 'first-test-key';
  let configured = true;
  const fetchResource = jest.fn(async (path) => {
    const timestamp = new URL(path, 'https://test.invalid').searchParams.get('timestamp');
    return payload([row(Date.parse(timestamp))]);
  });
  const service = createBenchmarkHistoryService({
    now: () => clock,
    getCredentialFingerprint: () => fingerprint,
    hasCredentials: () => configured,
    fetchResource,
    ...options,
  });
  return {
    service,
    fetchResource,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    rotate: (key) => {
      fingerprint = key;
    },
    unconfigure: () => {
      configured = false;
    },
  };
}

describe('historical BRTI parsing and ranges', () => {
  it('accepts five publications per second and retains only observed exact-second readings', () => {
    const rows = Array.from({ length: 18_000 }, (_, index) =>
      row(start + index * 200, String(77000 + index / 100)),
    );
    const samples = parseBenchmarkHistoryHour(payload(rows.reverse()), start);
    expect(samples).toHaveLength(3600);
    expect(samples[0]).toEqual({ time: start, price: 77000 });
    expect(samples.at(-1)).toEqual({ time: start + HOUR - 1000, price: 77179.95 });
  });

  it('deduplicates identical publications and preserves missing seconds', () => {
    expect(
      parseBenchmarkHistoryHour(
        payload([row(start + 3000, '7.7e4'), row(start), row(start), row(start + 200)]),
        start,
      ),
    ).toEqual([
      { time: start, price: 77000.25 },
      { time: start + 3000, price: 77000 },
    ]);
  });

  it.each([
    [row(start - 1)],
    [row(start + HOUR)],
    [row(start, '0')],
    [row(start, '-1')],
    [row(start, 'Infinity')],
    [row(start, '1e309')],
    [row(start, '0x20')],
    [row(start, 77000)],
    [row(String(start))],
    [row(start + 0.5)],
    [row(), row(start, '77001')],
    [row(start + 200), row(start + 200, '77001')],
    [null],
  ])('rejects malformed, conflicting or out-of-hour publications (%j)', (...rows) => {
    expect(() => parseBenchmarkHistoryHour(payload(rows), start)).toThrow();
  });

  it('rejects upstream errors, unexpected response shapes and oversized batches', () => {
    for (const response of [
      { data: { error: 'Upstream rejected access.', payload: [] } },
      { payload: [row()] },
      payload(null),
      payload(Array(20_001).fill(row())),
    ])
      expect(() => parseBenchmarkHistoryHour(response, start)).toThrow();
  });

  it('accepts only two or four completed hours at the current or previous UTC hour', () => {
    expect(validateBenchmarkHistoryRange({ hours: 2 }, currentTime)).toEqual({
      hours: 2,
      startsAt: endingAt - 2 * HOUR,
      endsAt: endingAt,
    });
    expect(
      validateBenchmarkHistoryRange({ hours: 4, endingAt: endingAt - HOUR }, currentTime).endsAt,
    ).toBe(endingAt - HOUR);
    for (const options of [
      { hours: 1 },
      { hours: '2' },
      { hours: 2, endingAt: start - HOUR },
      { hours: 2, endingAt: currentTime },
      { hours: 2, endingAt: endingAt + HOUR },
      { hours: 2, endingAt: new Date(endingAt).toISOString() },
    ])
      expect(() => validateBenchmarkHistoryRange(options, currentTime)).toThrow();
  });

  it.each([
    '',
    '?hours=1',
    '?hours=02',
    '?hours=2&hours=4',
    '?hours=2&unknown=yes',
    `?hours=2&endingAt=${endingAt}&endingAt=${endingAt}`,
    '?hours=2&endingAt=2026-09-13T06:00:00.000Z',
    '?hours=2&endingAt=',
    '?hours=2&endingAt=1789279200',
  ])('rejects invalid route query before any history read: %s', (query) => {
    expect(() =>
      readBenchmarkHistoryQuery(
        new Request(`http://localhost/api/kalshi/benchmark/history${query}`),
        currentTime,
      ),
    ).toThrow();
  });
});

describe('historical BRTI service', () => {
  it('uses the shared read transport with canonical fixed hourly requests', async () => {
    const { service, fetchResource } = setup();
    const result = await service.fetchBenchmarkHistory({ hours: 2, endingAt });
    expect(fetchResource.mock.calls.map(([path]) => path)).toEqual(
      [4, 5].map(
        (hour) =>
          `/cfbenchmarks/history/values?${new URLSearchParams({ id: 'BRTI', timespan: 'HOUR', timestamp: `2026-09-13T0${hour}:00:00.000Z` })}`,
      ),
    );
    expect(result).toEqual({
      hours: 2,
      startsAt: endingAt - 2 * HOUR,
      endsAt: endingAt,
      receivedAt: currentTime,
      status: 'available',
      available: true,
      reason: null,
      missingHours: [],
      samples: [
        { time: endingAt - 2 * HOUR, price: 77000.25 },
        { time: start, price: 77000.25 },
      ],
    });
  });

  it('reuses overlapping range hours and deduplicates concurrent range requests', async () => {
    const { service, fetchResource } = setup();
    const [first, second] = await Promise.all([
      service.fetchBenchmarkHistory({ hours: 2 }),
      service.fetchBenchmarkHistory({ hours: 2 }),
    ]);
    expect(first).toEqual(second);
    expect(fetchResource).toHaveBeenCalledTimes(2);
    await service.fetchBenchmarkHistory({ hours: 4 });
    expect(fetchResource).toHaveBeenCalledTimes(4);
    await service.fetchBenchmarkHistory({ hours: 2 });
    expect(fetchResource).toHaveBeenCalledTimes(4);
  });

  it('refreshes successful cache entries after five minutes', async () => {
    const { service, fetchResource, advance } = setup();
    await service.fetchBenchmarkHistory({ hours: 2 });
    advance(299_999);
    await service.fetchBenchmarkHistory({ hours: 2 });
    expect(fetchResource).toHaveBeenCalledTimes(2);
    advance(1);
    await service.fetchBenchmarkHistory({ hours: 2 });
    expect(fetchResource).toHaveBeenCalledTimes(4);
  });

  it('never shares cached historical data across credential rotations', async () => {
    const { service, fetchResource, rotate } = setup();
    await service.fetchBenchmarkHistory({ hours: 2 });
    rotate('second-test-key');
    await service.fetchBenchmarkHistory({ hours: 2 });
    expect(fetchResource).toHaveBeenCalledTimes(4);
  });

  it('bounds cached hour entries to 32', async () => {
    const { service, fetchResource, rotate } = setup();
    for (let index = 0; index < 17; index += 1) {
      rotate(`key-${index}`);
      await service.fetchBenchmarkHistory({ hours: 2 });
    }
    rotate('key-0');
    await service.fetchBenchmarkHistory({ hours: 2 });
    expect(fetchResource).toHaveBeenCalledTimes(36);
  });

  it('does not issue a read when credentials are absent or range arguments are invalid', async () => {
    const { service, fetchResource, unconfigure } = setup();
    await expect(service.fetchBenchmarkHistory({ hours: 12 })).rejects.toMatchObject({
      status: 400,
    });
    unconfigure();
    expect(await service.fetchBenchmarkHistory({ hours: 2 })).toMatchObject({
      available: false,
      samples: [],
      status: 'unavailable',
      missingHours: [endingAt - 2 * HOUR, start],
    });
    expect(fetchResource).not.toHaveBeenCalled();
  });

  it('discards an in-flight response if credentials change before it arrives', async () => {
    let finish;
    const fetchResource = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { service, rotate } = setup({ fetchResource });
    const pending = service.fetchBenchmarkHistory({ hours: 2 });
    rotate('replacement-key');
    finish(payload([row(endingAt - 2 * HOUR)]));
    expect(await pending).toMatchObject({ available: false, samples: [], status: 'unavailable' });
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });

  it('preserves valid hours when another hour fails and retries failures after one minute', async () => {
    const { service, fetchResource, advance } = setup();
    fetchResource.mockRejectedValueOnce({
      status: 503,
      message: 'Private upstream details must not leak.',
    });
    const result = await service.fetchBenchmarkHistory({ hours: 2 });
    expect(result).toMatchObject({
      status: 'partial',
      available: true,
      missingHours: [endingAt - 2 * HOUR],
      samples: [{ time: start, price: 77000.25 }],
    });
    expect(JSON.stringify(result)).not.toContain('Private upstream');
    advance(59_999);
    await service.fetchBenchmarkHistory({ hours: 2 });
    expect(fetchResource).toHaveBeenCalledTimes(2);
    advance(1);
    expect(await service.fetchBenchmarkHistory({ hours: 2 })).toMatchObject({
      status: 'available',
      missingHours: [],
    });
    expect(fetchResource).toHaveBeenCalledTimes(3);
  });

  it('marks unpublished empty hours as missing', async () => {
    const { service, fetchResource } = setup();
    fetchResource.mockResolvedValue(payload([]));
    expect(await service.fetchBenchmarkHistory({ hours: 2 })).toMatchObject({
      status: 'unavailable',
      available: false,
      samples: [],
      missingHours: [endingAt - 2 * HOUR, start],
    });
  });

  it('stops a range after a rate limit response and caches that failure', async () => {
    const { service, fetchResource } = setup();
    fetchResource.mockRejectedValueOnce({ status: 429 });
    const result = await service.fetchBenchmarkHistory({ hours: 4 });
    expect(result).toMatchObject({
      status: 'unavailable',
      samples: [],
      missingHours: [endingAt - 4 * HOUR, endingAt - 3 * HOUR, endingAt - 2 * HOUR, start],
    });
    await service.fetchBenchmarkHistory({ hours: 4 });
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });
});

describe('historical BRTI access route', () => {
  const environment = { ...process.env };
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(currentTime);
    hasKalshiCredentials.mockReturnValue(true);
    process.env = { ...environment };
    for (const key of [
      'RESEARCH_API_USERNAME',
      'RESEARCH_API_PASSWORD',
      'VERCEL',
      'AWS_LAMBDA_FUNCTION_NAME',
      'NETLIFY',
    ])
      delete process.env[key];
    fetchBenchmarkHistory.mockResolvedValue({ available: true, samples: [] });
  });
  afterEach(() => {
    process.env = environment;
    jest.restoreAllMocks();
  });

  it('exposes only GET and serves local authorized history without caching entitled responses', async () => {
    expect(Object.keys(historyRoute).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    const response = await historyRoute.GET(
      new Request(`http://localhost/api/kalshi/benchmark/history?hours=2&endingAt=${endingAt}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchBenchmarkHistory).toHaveBeenCalledWith({ hours: 2, endingAt });
  });

  it('rejects duplicate or unexpected parameters before reaching the service', async () => {
    for (const query of ['hours=2&hours=4', 'hours=2&target=1', 'hours=2&endingAt=invalid']) {
      const response = await historyRoute.GET(
        new Request(`http://localhost/api/kalshi/benchmark/history?${query}`),
      );
      expect(response.status).toBe(400);
    }
    expect(fetchBenchmarkHistory).not.toHaveBeenCalled();
  });

  it('requires the existing private app credentials for remote requests', async () => {
    process.env.RESEARCH_API_USERNAME = 'history-test-user';
    process.env.RESEARCH_API_PASSWORD = 'history-test-password';
    const response = await historyRoute.GET(
      new Request('https://tracker.example/api/kalshi/benchmark/history?hours=2'),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic');
    expect(fetchBenchmarkHistory).not.toHaveBeenCalled();
  });

  it('allows authenticated remote reads under the existing access policy', async () => {
    process.env.RESEARCH_API_USERNAME = 'history-test-user';
    process.env.RESEARCH_API_PASSWORD = 'history-test-password';
    const response = await historyRoute.GET(
      new Request('https://tracker.example/api/kalshi/benchmark/history?hours=4', {
        headers: {
          authorization: `Basic ${Buffer.from('history-test-user:history-test-password').toString('base64')}`,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchBenchmarkHistory).toHaveBeenCalledWith({ hours: 4, endingAt });
  });
});
