import { waitFor } from '@testing-library/react';
import {
  closeResearch,
  exportPendingEvidence,
  openResearch,
  renderEvidenceCollection,
  setBackgroundLockAvailable,
  setupEvidenceTests,
} from '../helpers/evidenceTestHarness';
import { eventStart } from '../helpers/evidenceFixtures';
import { ingestRequests, setIngestResponse } from '../helpers/evidenceServer';
import {
  createPendingEvidence,
  savePendingEvidence,
  serializedBytes,
} from './helpers/pendingArchiveFixtures';
import { expectNoPendingRecords } from './helpers/backlogControls';

setupEvidenceTests();

test('resumes a large saved backlog in bounded passes and exports the records still awaiting upload', async () => {
  const savedRows = Array.from({ length: 275 }, (_, index) => createPendingEvidence(index));
  await savePendingEvidence(savedRows);
  setBackgroundLockAvailable(false);
  setIngestResponse();
  const view = await renderEvidenceCollection();
  await waitFor(() => expect(ingestRequests).toHaveLength(5));
  expect(ingestRequests.map((batch) => batch.evidence.length)).toEqual([50, 50, 50, 50, 50]);
  expect(ingestRequests.every((batch) => batch.forecasts.length === 0)).toBe(true);
  expect(ingestRequests.flatMap((batch) => batch.evidence)).toEqual(savedRows.slice(0, 250));
  expect(await exportPendingEvidence(view.user)).toEqual(savedRows.slice(250));
  const research = await openResearch(view.user);
  expect(research.getByText(/Collection needs this page running/)).not.toHaveTextContent(
    'Last archive sync: waiting',
  );
  await closeResearch(view.user);

  await view.update(eventStart + 14_999);
  expect(ingestRequests).toHaveLength(5);
  await view.update(eventStart + 15_000);
  await waitFor(() => expect(ingestRequests).toHaveLength(6));
  expect(ingestRequests[5].evidence).toEqual(savedRows.slice(250));
  const uploadedRows = ingestRequests.flatMap((batch) => batch.evidence);
  expect(uploadedRows).toEqual(savedRows);
  expect(new Set(uploadedRows.map((row) => row.eventId)).size).toBe(savedRows.length);
  await expectNoPendingRecords(view.user);
  await view.reload();
  await expectNoPendingRecords(view.user);
  expect(ingestRequests).toHaveLength(6);
});

test('splits large captured-input records into safe upload sizes without trimming their saved history', async () => {
  const savedRows = Array.from({ length: 3 }, (_, index) =>
    createPendingEvidence(index, { sampleCount: 25_000 }),
  );
  // Each saved snapshot fits, but any pair exceeds the upload budget.
  expect(serializedBytes(savedRows[0])).toBeGreaterThan(1.5 * 1024 * 1024);
  expect(serializedBytes(savedRows[0])).toBeLessThan(3 * 1024 * 1024);
  await savePendingEvidence(savedRows);
  setBackgroundLockAvailable(false);
  setIngestResponse();
  const view = await renderEvidenceCollection();
  await waitFor(() => expect(ingestRequests).toHaveLength(3));
  expect(ingestRequests.map((batch) => batch.evidence.length)).toEqual([1, 1, 1]);
  for (const [index, batch] of ingestRequests.entries()) {
    expect(serializedBytes(batch)).toBeLessThan(3 * 1024 * 1024);
    expect(JSON.stringify(batch.evidence[0])).toBe(JSON.stringify(savedRows[index]));
    expect(batch.forecasts).toEqual([]);
  }
  await expectNoPendingRecords(view.user);
  const research = await openResearch(view.user);
  expect(research.getByText(/Collection needs this page running/)).not.toHaveTextContent(
    'Last archive sync: waiting',
  );
});

test('keeps an oversized record available for export and explains why upload is paused after retry and reload', async () => {
  const savedRows = [createPendingEvidence(0, { sampleCount: 50_000 }), createPendingEvidence(1)];
  expect(serializedBytes(savedRows[0])).toBeGreaterThan(3 * 1024 * 1024);
  await savePendingEvidence(savedRows);
  setBackgroundLockAvailable(false);
  setIngestResponse();
  const view = await renderEvidenceCollection();
  const warning =
    'A research record exceeds the upload size limit. The original record is retained.';
  let research = await openResearch(view.user);
  expect(await research.findByRole('alert')).toHaveTextContent(warning);
  expect(ingestRequests).toHaveLength(0);
  expect(JSON.stringify(await exportPendingEvidence(view.user))).toBe(JSON.stringify(savedRows));
  await closeResearch(view.user);

  await view.update(eventStart + 30_000);
  research = await openResearch(view.user);
  expect(research.getByRole('alert')).toHaveTextContent(warning);
  expect(ingestRequests).toHaveLength(0);
  await view.reload();
  research = await openResearch(view.user);
  expect(await research.findByRole('alert')).toHaveTextContent(warning);
  expect(JSON.stringify(await exportPendingEvidence(view.user))).toBe(JSON.stringify(savedRows));
  expect(ingestRequests).toHaveLength(0);
});
