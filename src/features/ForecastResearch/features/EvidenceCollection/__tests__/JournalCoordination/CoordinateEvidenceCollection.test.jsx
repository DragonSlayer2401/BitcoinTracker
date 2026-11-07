import { screen, waitFor } from '@testing-library/react';
import {
  closeResearch,
  exportPendingEvidence,
  renderEvidenceCollection,
  setupEvidenceTests,
} from '../helpers/evidenceTestHarness';
import { createSavedForecast, eventEnd } from '../helpers/evidenceFixtures';
import { ingestRequests } from '../helpers/evidenceServer';
import {
  assertCollectionPaused,
  saveJournalFromWriter,
} from './helpers/journalCoordinationControls';

setupEvidenceTests();

test('keeps a following tab read-only while another tab owns forecast recording', async () => {
  const view = await renderEvidenceCollection({ now: eventEnd - 12 * 60_000, lock: 'follower' });
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeDisabled();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await assertCollectionPaused(view.user);
  await closeResearch(view.user);

  await view.update(eventEnd - 9 * 60_000);
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
  await assertCollectionPaused(view.user);
});

test('restores the outgoing writer’s latest calls before collecting and uploading after ownership changes', async () => {
  const original = createSavedForecast({ id: 'original-writer-call', checkpointMinutes: 12 });
  const view = await renderEvidenceCollection({
    now: eventEnd - 12 * 60_000,
    forecasts: [original],
    lock: 'follower',
  });
  expect(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' })).toHaveTextContent(
    'Likely Yes',
  );
  await assertCollectionPaused(view.user);
  await closeResearch(view.user);

  await view.update(eventEnd - 9 * 60_000);
  const latest = createSavedForecast({
    id: 'latest-writer-call',
    checkpointMinutes: 9,
    aboveProbability: 0.3,
  });
  // The departing tab commits its newest call before this tab receives ownership.
  saveJournalFromWriter([latest, original]);
  await view.acquireOwnership();
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeEnabled();
  expect(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' })).toHaveTextContent(
    'Likely No',
  );
  const rows = await exportPendingEvidence(view.user);
  const restored = rows.filter((row) => row.event === 'restored');
  expect(restored.map((row) => row.forecastId).sort()).toEqual([latest.id, original.id].sort());
  for (const row of restored)
    expect(row).toMatchObject({
      inputStatus: 'restored-without-inputs',
      sessionOrigin: 'restored',
      inputObservedAt: null,
    });
  expect(
    rows.find((row) => row.cohort === 'kalshi-background' && row.checkpointMinutes === 12),
  ).toMatchObject({
    decision: 'withheld',
    inputObservedAt: null,
  });
  expect(
    rows.find((row) => row.cohort === 'kalshi-background' && row.checkpointMinutes === 9),
  ).toMatchObject({
    decision: 'pending',
    inputObservedAt: eventEnd - 9 * 60_000,
  });
  await waitFor(() =>
    expect(
      ingestRequests
        .flatMap((batch) => batch.forecasts)
        .map((forecast) => forecast.id)
        .sort(),
    ).toEqual([latest.id, original.id].sort()),
  );
});

test('keeps saved calls readable but pauses evidence and uploads when browser locking is unavailable', async () => {
  const forecast = createSavedForecast({ checkpointMinutes: 9 });
  const view = await renderEvidenceCollection({
    now: eventEnd - 6 * 60_000,
    forecasts: [forecast],
    lock: 'unsupported',
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'This browser cannot coordinate saved forecasts across tabs.',
  );
  expect(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' })).toHaveTextContent(
    'Likely Yes',
  );
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
  await assertCollectionPaused(view.user);
  await closeResearch(view.user);

  await view.update(eventEnd - 3 * 60_000);
  expect(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' })).toHaveTextContent(
    'Likely Yes',
  );
  await assertCollectionPaused(view.user);
});
