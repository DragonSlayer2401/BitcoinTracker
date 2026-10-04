/** @jest-environment node */
import { GET, POST } from '../../../app/api/research/collector-control/route';
import {
  getCollectorControlStatus,
  startManagedCollector,
  stopManagedCollector,
} from '../../../services/research/collectorControl/collectorControl.service';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('../../../services/research/collectorControl/collectorControl.service', () => ({
  getCollectorControlStatus: jest.fn(),
  startManagedCollector: jest.fn(),
  stopManagedCollector: jest.fn(),
}));

const endpoint = 'http://localhost:3000/api/research/collector-control';
const makeRequest = ({
  url = endpoint,
  body,
  headers = {},
  origin = 'http://localhost:3000',
} = {}) =>
  new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('collector-control routes', () => {
  let originalEnvironment;
  beforeEach(() => {
    originalEnvironment = process.env;
    process.env = { ...originalEnvironment };
    for (const key of [
      'RESEARCH_API_USERNAME',
      'RESEARCH_API_PASSWORD',
      'VERCEL',
      'AWS_LAMBDA_FUNCTION_NAME',
      'NETLIFY',
    ]) {
      delete process.env[key];
    }
    getCollectorControlStatus.mockResolvedValue({ status: 'stopped', canStart: true });
    startManagedCollector.mockResolvedValue({ status: 'starting' });
    stopManagedCollector.mockResolvedValue({ status: 'stopping' });
  });
  afterEach(() => {
    process.env = originalEnvironment;
  });

  test('reads status without starting collection and returns uncached output', async () => {
    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'stopped', canStart: true });
    expect(startManagedCollector).not.toHaveBeenCalled();
    expect(stopManagedCollector).not.toHaveBeenCalled();
  });

  test.each(['start', 'stop'])('allows an explicit same-origin %s action', async (action) => {
    const response = await POST(makeRequest({ body: { action } }));
    expect(response.status).toBe(200);
    expect(
      action === 'start' ? startManagedCollector : stopManagedCollector,
    ).toHaveBeenCalledWith();
    expect(
      action === 'start' ? stopManagedCollector : startManagedCollector,
    ).not.toHaveBeenCalled();
  });

  test.each([
    null,
    [],
    'start',
    {},
    { action: 'restart' },
    { action: 'start', command: 'arbitrary executable' },
    { action: 'stop', pid: 123 },
    { action: 'start', statePath: '/elsewhere' },
  ])('rejects unexpected process instructions %j', async (body) => {
    expect((await POST(makeRequest({ body }))).status).toBe(400);
    expect(startManagedCollector).not.toHaveBeenCalled();
    expect(stopManagedCollector).not.toHaveBeenCalled();
  });

  test.each([
    { origin: 'https://other.example' },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { host: 'other.example:3000' } },
    { headers: { 'content-type': 'text/plain' } },
  ])('rejects foreign origins and unsafe writes %j', async (options) => {
    expect(
      (await POST(makeRequest({ body: { action: 'start' }, ...options }))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(startManagedCollector).not.toHaveBeenCalled();
  });

  test('does not let query parameters select a process or executable', async () => {
    const response = await POST(
      makeRequest({ url: `${endpoint}?pid=123`, body: { action: 'stop' } }),
    );
    expect(response.status).toBe(400);
    expect(stopManagedCollector).not.toHaveBeenCalled();
  });

  test('requires configured research authentication for reads and mutations', async () => {
    process.env.RESEARCH_API_USERNAME = 'private';
    process.env.RESEARCH_API_PASSWORD = 'test-only';
    expect((await GET(makeRequest())).status).toBe(401);
    expect((await POST(makeRequest({ body: { action: 'start' } }))).status).toBe(401);
    expect(getCollectorControlStatus).not.toHaveBeenCalled();
    expect(startManagedCollector).not.toHaveBeenCalled();
    const authorization = `Basic ${Buffer.from('private:test-only').toString('base64')}`;
    expect((await GET(makeRequest({ headers: { authorization } }))).status).toBe(200);
  });

  test.each([
    {
      url: 'https://private.example/api/research/collector-control',
      origin: 'https://private.example',
    },
    { hosted: 'VERCEL' },
    { hosted: 'NETLIFY' },
    { hosted: 'AWS_LAMBDA_FUNCTION_NAME' },
  ])(
    'forbids process controls on remote or hosted app instances %j',
    async ({ hosted, ...options }) => {
      process.env.RESEARCH_API_USERNAME = 'private';
      process.env.RESEARCH_API_PASSWORD = 'test-only';
      if (hosted) process.env[hosted] = '1';
      const headers = {
        authorization: `Basic ${Buffer.from('private:test-only').toString('base64')}`,
      };
      expect((await GET(makeRequest({ ...options, headers }))).status).toBe(403);
      expect(
        (await POST(makeRequest({ ...options, headers, body: { action: 'start' } }))).status,
      ).toBe(403);
      expect(getCollectorControlStatus).not.toHaveBeenCalled();
      expect(startManagedCollector).not.toHaveBeenCalled();
    },
  );

  test('sanitizes service failures instead of returning private configuration', async () => {
    startManagedCollector.mockRejectedValue(new Error('private-token-and-path'));
    const response = await POST(makeRequest({ body: { action: 'start' } }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-token-and-path');
  });
});
