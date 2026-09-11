/** @jest-environment node */
import {
  readResearchExport,
  runResearchLearning,
  uploadResearchBatch,
} from '@/services/research/research.client.service';

const batch = { evidence: [{ eventId: 'one' }], forecasts: [{ id: 'one', status: 'pending' }] };
const acknowledgment = {
  evidence: { inserted: 1, duplicates: 0 },
  forecasts: { inserted: 0, duplicates: 1 },
};

describe('research archive client', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue(Response.json(acknowledgment));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('accepts a complete acknowledgment containing both new and already-saved records', async () => {
    expect(await uploadResearchBatch(batch)).toEqual(acknowledgment);
    expect(fetch).toHaveBeenCalledWith(
      '/api/research/ingest',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(batch),
      }),
    );
  });

  test.each([
    {},
    null,
    { ...acknowledgment, evidence: { inserted: 0, duplicates: 0 } },
    { ...acknowledgment, evidence: { inserted: -1, duplicates: 2 } },
    { ...acknowledgment, forecasts: { inserted: 0.5, duplicates: 0.5 } },
    { ...acknowledgment, forecasts: { inserted: 1, duplicates: 1 } },
  ])(
    'rejects incomplete or malformed acknowledgment %j before the outbox is cleared',
    async (value) => {
      fetch.mockResolvedValue(Response.json(value));
      await expect(uploadResearchBatch(batch)).rejects.toThrow(
        'did not confirm the complete upload',
      );
    },
  );

  test('reports authentication and server failures without treating them as successful uploads', async () => {
    fetch.mockResolvedValueOnce(Response.json({ error: 'Private store' }, { status: 401 }));
    await expect(uploadResearchBatch(batch)).rejects.toThrow('sign-in is required');
    fetch.mockResolvedValueOnce(Response.json({ error: 'Storage unavailable' }, { status: 503 }));
    await expect(uploadResearchBatch(batch)).rejects.toThrow('Storage unavailable');
  });

  test('requests server-owned analysis with an empty JSON object', async () => {
    await runResearchLearning();
    expect(fetch).toHaveBeenCalledWith(
      '/api/research/analyze',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  test('exports all cursor pages and rejects a nonadvancing cursor', async () => {
    fetch.mockResolvedValueOnce(Response.json({ rows: [{ eventId: 'one' }], nextCursor: '1' }));
    fetch.mockResolvedValueOnce(Response.json({ rows: [{ eventId: 'two' }], nextCursor: null }));
    expect(await readResearchExport()).toEqual([{ eventId: 'one' }, { eventId: 'two' }]);
    expect(fetch.mock.calls[1][0]).toContain('after=1');
    fetch.mockResolvedValueOnce(Response.json({ rows: [], nextCursor: '1' }));
    fetch.mockResolvedValueOnce(Response.json({ rows: [], nextCursor: '1' }));
    await expect(readResearchExport()).rejects.toThrow('did not advance');
  });
});
