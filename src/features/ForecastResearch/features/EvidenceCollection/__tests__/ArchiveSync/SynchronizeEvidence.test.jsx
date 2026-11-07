import { act, screen, waitFor } from '@testing-library/react';
import { createSavedForecast, eventStart, eventEnd } from '../helpers/evidenceFixtures';
import {
  closeResearch,
  exportPendingEvidence,
  openResearch,
  renderEvidenceCollection,
  setBackgroundLockAvailable,
  setupEvidenceTests,
} from '../helpers/evidenceTestHarness';
import {
  ingestRequests,
  releaseIngestRequests,
  setIngestResponse,
} from '../helpers/evidenceServer';
import { expectEmptyPendingExport, expectSyncedAt } from './helpers/syncControls';

setupEvidenceTests();

const now = eventStart + 600_000;

test.each([
  ['network disconnection', new TypeError('Network connection lost.'), 'Network connection lost.'],
  [
    'archive failure',
    {
      status: 503,
      body: { error: 'The archive is offline. Pending records remain on this device.' },
    },
    'The archive is offline. Pending records remain on this device.',
  ],
  [
    'expired sign-in',
    { status: 401 },
    'Research sign-in is required. Open the archive sign-in link, then retry.',
  ],
  [
    'incomplete acknowledgment',
    {
      body: { evidence: { inserted: 0, duplicates: 0 }, forecasts: { inserted: 0, duplicates: 0 } },
    },
    'The archive did not confirm the complete upload. Pending records remain on this device.',
  ],
])(
  'retains downloadable evidence after %s and retries the exact records after recovery',
  async (_scenario, response, message) => {
    setBackgroundLockAvailable(false);
    let failedAt;
    setIngestResponse(() => {
      failedAt = Date.now();
      return response;
    });
    const forecast = createSavedForecast({ id: 'sync-existing-call' });
    const view = await renderEvidenceCollection({ now, forecasts: [forecast] });
    const originalRows = await exportPendingEvidence(view.user);
    await view.update(now + 15_000);
    const dialog = await openResearch(view.user);
    expect(await dialog.findByText(message, { exact: false })).toBeVisible();
    expect(dialog.getByRole('link', { name: 'Check archive access' })).toHaveAttribute(
      'href',
      '/api/research/status',
    );
    expect(screen.getByText('Research needs attention · see Research data')).toBeVisible();
    expect(await exportPendingEvidence(view.user)).toEqual(originalRows);
    const attempts = ingestRequests.length;
    setIngestResponse();
    await view.update(failedAt + 29_999);
    expect(ingestRequests).toHaveLength(attempts);
    expect(await exportPendingEvidence(view.user)).toEqual(originalRows);
    await view.update(failedAt + 30_000);
    await expectSyncedAt(view.user, failedAt + 30_000);
    expect(ingestRequests).toHaveLength(attempts + 1);
    expect(ingestRequests.at(-1).evidence).toEqual(originalRows);
    expect(ingestRequests.at(-1).forecasts).toEqual([
      expect.objectContaining({ id: forecast.id, status: 'pending' }),
    ]);
    await waitFor(() =>
      expect(
        screen.queryByText('Research needs attention · see Research data'),
      ).not.toBeInTheDocument(),
    );
    await expectEmptyPendingExport(view.user);
  },
);

test('keeps an in-flight upload exportable and acknowledges duplicate records without resending them', async () => {
  setBackgroundLockAvailable(false);
  const view = await renderEvidenceCollection({ now, forecasts: [createSavedForecast()] });
  const rows = await exportPendingEvidence(view.user);
  await view.update(now + 15_000);
  await waitFor(() => expect(ingestRequests).toHaveLength(1));
  expect(await exportPendingEvidence(view.user)).toEqual(rows);
  await view.update(now + 60_000);
  expect(ingestRequests).toHaveLength(1);
  setIngestResponse(({ batch }) => ({
    body: {
      evidence: { inserted: 0, duplicates: batch.evidence.length },
      forecasts: { inserted: 0, duplicates: batch.forecasts.length },
    },
  }));
  await act(async () => releaseIngestRequests());
  await expectSyncedAt(view.user, now + 60_000);
  await expectEmptyPendingExport(view.user);
  expect(ingestRequests.flatMap((batch) => batch.evidence)).toEqual(rows);
  expect(ingestRequests.flatMap((batch) => batch.forecasts)).toHaveLength(1);
  const completedUploads = ingestRequests.length;
  await view.update(now + 75_000);
  expect(ingestRequests).toHaveLength(completedUploads);
});

test('resumes a failed upload after reloading without waiting for the old session retry delay', async () => {
  setBackgroundLockAvailable(false);
  setIngestResponse({ status: 503, body: { error: 'Archive temporarily unavailable.' } });
  const view = await renderEvidenceCollection({ now, forecasts: [createSavedForecast()] });
  const originalRows = await exportPendingEvidence(view.user);
  await view.update(now + 15_000);
  expect(await screen.findByText(/Archive temporarily unavailable/)).toBeVisible();
  const attempts = ingestRequests.length;
  setIngestResponse();
  await view.reload();
  await expectSyncedAt(view.user, now + 15_000);
  expect(ingestRequests.length).toBeGreaterThan(attempts);
  const uploadedRows = ingestRequests.slice(attempts).flatMap((batch) => batch.evidence);
  for (const row of originalRows) expect(uploadedRows).toContainEqual(row);
  expect(new Set(uploadedRows.map((row) => row.eventId)).size).toBe(uploadedRows.length);
  await expectEmptyPendingExport(view.user);
});

test('uploads newly captured checkpoint decisions while the research dialog is closed', async () => {
  setBackgroundLockAvailable(false);
  const view = await renderEvidenceCollection();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(eventStart + 15_000);
  await waitFor(() => expect(ingestRequests).toHaveLength(1));
  const firstUpload = ingestRequests[0];
  expect(firstUpload.forecasts).toHaveLength(2);
  expect(firstUpload.forecasts.every((forecast) => forecast.status === 'analyzing')).toBe(true);
  setIngestResponse();
  await act(async () => releaseIngestRequests());
  await expectSyncedAt(view.user, eventStart + 15_000);
  await expectEmptyPendingExport(view.user);
  await closeResearch(view.user);
  await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // The archive can read before this tick's new evidence commits. The next
  // periodic sync must upload it even after the user closes the research panel.
  const pending = await exportPendingEvidence(view.user);
  expect(pending.some((row) => row.event === 'decision')).toBe(true);
  await closeResearch(view.user);
  await view.update(eventEnd - 9 * 60_000 + 15_000, { price: 49_900 });
  await expectSyncedAt(view.user, eventEnd - 9 * 60_000 + 15_000);
  const decisions = ingestRequests
    .flatMap((batch) => batch.evidence)
    .filter((row) => row.event === 'decision');
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({
    cohort: 'manual',
    decision: 'pending',
    checkpointMinutes: 9,
    spot: 50_100,
    inputObservedAt: eventEnd - 9 * 60_000,
  });
  const captured = ingestRequests
    .flatMap((batch) => batch.forecasts)
    .filter((forecast) => forecast.status === 'pending');
  expect(captured).toHaveLength(1);
  expect(captured[0].id).toBe(decisions[0].forecastId);
  expect(captured[0].aboveProbability).toBe(decisions[0].aboveProbability);
});
