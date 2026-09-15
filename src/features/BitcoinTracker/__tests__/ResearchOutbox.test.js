/** @jest-environment node */
import { IDBFactory } from 'fake-indexeddb';
import {
  appendEvidenceRows,
  openEvidenceDatabase,
  readEvidenceRows,
} from '../utils/evidenceStorage.utils';
import {
  acknowledgeResearchBatch,
  queueForecastSnapshots,
  readResearchOutbox,
} from '../utils/researchOutbox.utils';

const now = Date.UTC(2026, 8, 9, 12);
const event = (index = 1) => ({
  eventId: `forecast-${index}:decision:pending`,
  recordedAt: now + index,
  target: 50000,
});
const snapshot = (index = 1, status = 'pending') => ({
  id: `forecast-${index}`,
  status,
  target: 50000,
});
const complete = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

async function createLegacyDatabase(rows) {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('bitcoin-tracker-evidence', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('events', { keyPath: 'eventId' });
      store.createIndex('recordedAt', 'recordedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction('events', 'readwrite');
  const done = complete(transaction);
  for (const row of rows) transaction.objectStore('events').add(row);
  await done;
  database.close();
}

describe('research offline outbox', () => {
  let originalFactory;
  beforeEach(() => {
    originalFactory = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
  });
  afterEach(() => {
    globalThis.indexedDB = originalFactory;
  });

  test('large replay captures upload in bounded batches without dropping the remainder', async () => {
    const first = { ...event(1), researchInputSnapshot: { history: 'x'.repeat(1_600_000) } };
    const second = { ...event(2), researchInputSnapshot: { history: 'x'.repeat(1_600_000) } };
    await appendEvidenceRows([first, second]);
    const batch = await readResearchOutbox();
    expect(batch.evidence).toEqual([first]);
    expect(new Blob([JSON.stringify(batch)]).size).toBeLessThan(4 * 1024 * 1024);
    await acknowledgeResearchBatch(batch);
    expect((await readResearchOutbox()).evidence).toEqual([second]);
  });

  test('upgrades v1 evidence to the v2 outbox without discarding historical inputs', async () => {
    const rows = [event(2), event(1)];
    await createLegacyDatabase(rows);
    expect(await readResearchOutbox()).toEqual({ evidence: [event(1), event(2)], forecasts: [] });
    const database = await openEvidenceDatabase();
    expect(database.version).toBe(2);
    expect([...database.objectStoreNames]).toEqual(['events', 'forecast-outbox']);
    database.close();
    expect(await readEvidenceRows()).toEqual([event(1), event(2)]);
  });

  test('keeps the original evidence and forecast snapshot when repeated input differs', async () => {
    await appendEvidenceRows([event()]);
    await appendEvidenceRows([{ ...event(), target: 51000 }]);
    await queueForecastSnapshots([snapshot()]);
    await queueForecastSnapshots([{ ...snapshot(), target: 51000 }]);
    expect(await readResearchOutbox()).toEqual({ evidence: [event()], forecasts: [snapshot()] });
  });

  test('deduplicates repeated forecast snapshots within one batch without aborting other rows', async () => {
    await queueForecastSnapshots([snapshot(), snapshot(), snapshot(2)]);
    expect((await readResearchOutbox()).forecasts).toEqual([snapshot(), snapshot(2)]);
  });

  test('retains every pending and resolved snapshot as separate immutable upload records', async () => {
    await queueForecastSnapshots([snapshot(), snapshot(1, 'resolved')]);
    expect((await readResearchOutbox()).forecasts).toEqual([snapshot(), snapshot(1, 'resolved')]);
  });

  test('acknowledges only the uploaded page and preserves the remaining archive', async () => {
    await appendEvidenceRows(Array.from({ length: 60 }, (_, index) => event(index)));
    await queueForecastSnapshots(Array.from({ length: 60 }, (_, index) => snapshot(index)));
    const first = await readResearchOutbox(50);
    expect(first.evidence).toHaveLength(50);
    expect(first.forecasts).toHaveLength(50);
    await acknowledgeResearchBatch(first);
    const remaining = await readResearchOutbox(50);
    expect(remaining.evidence).toHaveLength(10);
    expect(remaining.forecasts).toHaveLength(10);
    expect(remaining.evidence.map((row) => row.eventId)).not.toEqual(
      expect.arrayContaining(first.evidence.map((row) => row.eventId)),
    );
    await acknowledgeResearchBatch(first);
    expect(await readResearchOutbox()).toEqual(remaining);
  });

  test('does not delete records collected while another batch is being uploaded', async () => {
    await appendEvidenceRows([event()]);
    await queueForecastSnapshots([snapshot()]);
    const uploading = await readResearchOutbox();
    await appendEvidenceRows([event(2)]);
    await queueForecastSnapshots([snapshot(1, 'resolved')]);
    await acknowledgeResearchBatch(uploading);
    expect(await readResearchOutbox()).toEqual({
      evidence: [event(2)],
      forecasts: [snapshot(1, 'resolved')],
    });
  });

  test('serializes concurrent browser writers without replacing their first snapshot', async () => {
    await Promise.all([queueForecastSnapshots([snapshot()]), queueForecastSnapshots([snapshot()])]);
    await Promise.all([appendEvidenceRows([event()]), appendEvidenceRows([event()])]);
    expect(await readResearchOutbox()).toEqual({ evidence: [event()], forecasts: [snapshot()] });
  });

  test('leaves the archive untouched when a read-only outbox page is inspected', async () => {
    await appendEvidenceRows([event()]);
    const first = await readResearchOutbox();
    expect(await readResearchOutbox()).toEqual(first);
    expect(await readEvidenceRows()).toEqual([event()]);
  });

  test('reports unavailable browser storage so sync can retry without acknowledging data', async () => {
    globalThis.indexedDB = undefined;
    await expect(queueForecastSnapshots([snapshot()])).rejects.toThrow(
      'unavailable in this browser',
    );
    await expect(readResearchOutbox()).rejects.toThrow('unavailable in this browser');
  });
});
