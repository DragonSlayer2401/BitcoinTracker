import { screen, waitFor, within } from '@testing-library/react';
import {
  closeResearch,
  exportPendingEvidence,
  renderEvidenceCollection,
  setupEvidenceTests,
} from '../helpers/evidenceTestHarness';
import { currentMarket, eventEnd } from '../helpers/evidenceFixtures';
import { setSettlementResponse } from '../helpers/evidenceServer';

setupEvidenceTests();

let withheld;
let exportedRows;

// Keep every setup assertion outside the expected-failure body so a broken
// recording, clear, reload, settlement or export workflow remains a real failure.
beforeEach(async () => {
  const view = await renderEvidenceCollection();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  const checkpointAt = eventEnd - 9 * 60_000;
  const outage = { ticker: null, benchmark: null, candles: [], hasRequestError: true };
  await view.update(checkpointAt, outage);
  await view.update(checkpointAt + 5001, outage);
  await view.update(eventEnd - 6 * 60_000, { price: 50_100 });
  const recordedRows = await exportPendingEvidence(view.user);
  withheld = recordedRows.find(
    (row) => row.cohort === 'manual' && row.event === 'decision' && row.checkpointMinutes === 9,
  );
  expect(withheld).toMatchObject({ decision: 'withheld', aboveProbability: null });
  const captured = recordedRows.find(
    (row) => row.cohort === 'manual' && row.event === 'decision' && row.checkpointMinutes === 6,
  );
  expect(captured).toMatchObject({ decision: 'pending', inputStatus: 'captured' });
  await closeResearch(view.user);

  await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
  const confirmation = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
  await view.user.click(within(confirmation).getByRole('button', { name: 'Clear completed' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await view.reload();
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = await screen.findByRole('dialog', { name: 'Forecast history' });
  expect(within(history).queryByRole('row', { name: /9 min left/ })).not.toBeInTheDocument();
  expect(within(history).getByRole('row', { name: /6 min left/ })).toBeVisible();
  await view.user.click(within(history).getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await exportPendingEvidence(view.user)).toContainEqual(withheld);
  await closeResearch(view.user);

  setSettlementResponse({
    ...currentMarket,
    status: 'settled',
    result: 'no',
    settlementPrice: 49_950,
    receivedAt: eventEnd,
  });
  await view.update(eventEnd);
  expect(await screen.findByRole('heading', { name: 'Result observed' })).toBeVisible();
  // A further clock tick gives evidence collection a chance to observe the
  // official result already retrieved for the surviving saved checkpoint.
  await view.update(eventEnd + 1000);
  exportedRows = await exportPendingEvidence(view.user);
  expect(exportedRows).toContainEqual(withheld);
  expect(
    exportedRows.filter((row) => row.event === 'outcome' && row.forecastId === captured.forecastId),
  ).toEqual([
    expect.objectContaining({ outcomeStatus: 'observed', observedPrice: 49_950, outcome: 'below' }),
  ]);
});

// Cleared no-calls are currently tracked only in memory, so a page reload loses
// their settlement tracking even though their exported decision evidence remains.
test.failing(
  'known limitation: retains a cleared no-call outcome after reloading before settlement',
  () => {
    expect(
      exportedRows.filter(
        (row) => row.event === 'outcome' && row.forecastId === withheld.forecastId,
      ),
    ).toEqual([
      expect.objectContaining({
        decision: 'withheld',
        outcomeStatus: 'observed',
        inputStatus: 'outcome-only',
        observedPrice: 49_950,
        outcome: 'below',
        aboveProbability: null,
      }),
    ]);
  },
);
