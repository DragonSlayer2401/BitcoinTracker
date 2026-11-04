/** @jest-environment node */
import { GET, POST } from '@/app/api/research/advisor-configuration/route';
import {
  getAdvisorConfigurationFromStore,
  saveAdvisorConfigurationToStore,
} from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import { ResearchDataError } from '@/services/research/research.validation';

jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('@/services/research/tradingAdvisor/tradingAdvisor.service', () => ({
  getAdvisorConfigurationFromStore: jest.fn(),
  saveAdvisorConfigurationToStore: jest.fn(),
}));

const endpoint = 'http://localhost:3000/api/research/advisor-configuration';
const configuration = { allocation: 50, riskLevel: 'conservative', expectedRevision: 0 };
const request = ({ url = endpoint, body, headers = {}, origin = 'http://localhost:3000' } = {}) =>
  new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('paper adviser setup routes', () => {
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
    getAdvisorConfigurationFromStore.mockResolvedValue({
      revision: 0,
      policy: { totalBudget: 100 },
    });
    saveAdvisorConfigurationToStore.mockResolvedValue({ revision: 1, policy: { totalBudget: 50 } });
  });
  afterEach(() => {
    process.env = originalEnvironment;
  });

  test('reading setup returns uncached configuration without modifying the account', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ revision: 0, policy: { totalBudget: 100 } });
    expect(saveAdvisorConfigurationToStore).not.toHaveBeenCalled();
  });

  test('forwards an explicit same-origin revision-checked setup to the repository', async () => {
    const response = await POST(request({ body: configuration }));
    expect(response.status).toBe(200);
    expect(saveAdvisorConfigurationToStore).toHaveBeenCalledWith(configuration);
    expect(await response.json()).toEqual({ revision: 1, policy: { totalBudget: 50 } });
  });

  test.each([
    null,
    [],
    '50',
    {},
    { allocation: 50 },
    { allocation: 50, riskLevel: 'conservative' },
    { allocation: 50, expectedRevision: 0 },
    { riskLevel: 'conservative', expectedRevision: 0 },
    { ...configuration, cash: 1000 },
    { ...configuration, resetLosses: true },
  ])('rejects missing fields and unauthorized account fields %j', async (body) => {
    expect((await POST(request({ body }))).status).toBe(400);
    expect(saveAdvisorConfigurationToStore).not.toHaveBeenCalled();
  });

  test.each([
    { origin: 'https://other.example' },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { host: 'other.example:3000' } },
  ])('rejects a foreign write before account changes %j', async (options) => {
    expect((await POST(request({ body: configuration, ...options }))).status).toBe(403);
    expect(saveAdvisorConfigurationToStore).not.toHaveBeenCalled();
  });

  test('requires JSON and rejects undeclared query behavior', async () => {
    expect(
      (await POST(request({ body: configuration, headers: { 'content-type': 'text/plain' } })))
        .status,
    ).toBe(415);
    expect(
      (await POST(request({ body: configuration, url: `${endpoint}?reset=true` }))).status,
    ).toBe(400);
    expect((await GET(request({ url: `${endpoint}?reset=true` }))).status).toBe(400);
    expect(saveAdvisorConfigurationToStore).not.toHaveBeenCalled();
    expect(getAdvisorConfigurationFromStore).not.toHaveBeenCalled();
  });

  test('requires configured research credentials for both setup reads and writes', async () => {
    process.env.RESEARCH_API_USERNAME = 'private';
    process.env.RESEARCH_API_PASSWORD = 'test-only';
    expect((await GET(request())).status).toBe(401);
    expect((await POST(request({ body: configuration }))).status).toBe(401);
    expect(saveAdvisorConfigurationToStore).not.toHaveBeenCalled();
    expect(getAdvisorConfigurationFromStore).not.toHaveBeenCalled();
    const headers = {
      authorization: `Basic ${Buffer.from('private:test-only').toString('base64')}`,
    };
    expect((await POST(request({ body: configuration, headers }))).status).toBe(200);
  });

  test('surfaces a conflicting revision without pretending setup was saved', async () => {
    saveAdvisorConfigurationToStore.mockRejectedValue(
      new ResearchDataError('Setup changed in another window.', 409),
    );
    const response = await POST(request({ body: configuration }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      available: false,
      error: 'Setup changed in another window.',
    });
  });

  test('redacts unexpected storage errors', async () => {
    saveAdvisorConfigurationToStore.mockRejectedValue(new Error('private-configuration-and-path'));
    const response = await POST(request({ body: configuration }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-configuration-and-path');
  });
});
