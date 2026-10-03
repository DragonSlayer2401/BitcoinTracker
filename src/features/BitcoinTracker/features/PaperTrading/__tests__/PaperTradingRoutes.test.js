/** @jest-environment node */
import { GET } from '@/app/api/research/paper-trading/route';
import { getPaperTradingReportFromStore } from '@/services/research/paperTrading/paperTrading.service';

jest.mock('server-only', () => ({}));
jest.mock('@/services/research/paperTrading/paperTrading.service', () => ({
  getPaperTradingReportFromStore: jest.fn(),
}));

test('the private report is uncached and reads saved data only', async () => {
  getPaperTradingReportFromStore.mockResolvedValue({ summary: { decisionCount: 3 } });
  const response = await GET(new Request('http://localhost:3000/api/research/paper-trading'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ summary: { decisionCount: 3 } });
});

test('unconfigured remote access and unrecognized query controls are rejected', async () => {
  const remote = await GET(new Request('https://example.com/api/research/paper-trading'));
  expect(remote.status).toBe(503);
  const query = await GET(
    new Request('http://localhost:3000/api/research/paper-trading?start=true'),
  );
  expect(query.status).toBe(400);
  expect(getPaperTradingReportFromStore).not.toHaveBeenCalled();
});

test('storage failures expose no internal error or invented results', async () => {
  getPaperTradingReportFromStore.mockRejectedValue(new Error('private connection details'));
  const response = await GET(new Request('http://localhost:3000/api/research/paper-trading'));
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body.error).not.toContain('private connection');
  expect(body.summary).toBeUndefined();
});
