/** @jest-environment node */
import { GET } from '@/app/api/research/trading-advisor/route';
import { getTradingAdvisorReportFromStore } from '@/services/research/tradingAdvisor/tradingAdvisor.service';

jest.mock('server-only', () => ({}));
jest.mock('@/services/research/tradingAdvisor/tradingAdvisor.service', () => ({
  getTradingAdvisorReportFromStore: jest.fn(),
}));

test('private report reads saved simulated data with caching disabled', async () => {
  getTradingAdvisorReportFromStore.mockResolvedValue({ simulated: true, portfolio: { cash: 100 } });
  const response = await GET(new Request('http://localhost:3000/api/research/trading-advisor'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ simulated: true, portfolio: { cash: 100 } });
});
test('remote unauthenticated access and action/query controls are rejected', async () => {
  expect((await GET(new Request('https://example.com/api/research/trading-advisor'))).status).toBe(
    503,
  );
  expect(
    (await GET(new Request('http://localhost:3000/api/research/trading-advisor?buy=true'))).status,
  ).toBe(400);
  expect(getTradingAdvisorReportFromStore).not.toHaveBeenCalled();
});
test('storage failures never invent advice or expose private error details', async () => {
  getTradingAdvisorReportFromStore.mockRejectedValue(new Error('private database details'));
  const response = await GET(new Request('http://localhost:3000/api/research/trading-advisor'));
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.error).not.toContain('private database');
  expect(body.latestAdvice).toBeUndefined();
});
