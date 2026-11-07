import { act, screen, waitFor } from '@testing-library/react';
import {
  closeResearch,
  exportPendingEvidence,
  openResearch,
  renderEvidenceCollection,
  setBackgroundLockAvailable,
  setupEvidenceTests,
} from '../helpers/evidenceTestHarness';
import { currentMarket, eventEnd, nextMarket } from '../helpers/evidenceFixtures';
import {
  httpRequests,
  ingestRequests,
  releaseIngestRequests,
  setIngestResponse,
  setSettlementResponse,
} from '../helpers/evidenceServer';
import { BACKGROUND_RESEARCH_STORAGE_KEY } from '../../utils/backgroundResearchStorage.utils';
import { exportBackgroundEvidence, expectNoPendingEvidence } from './helpers/backgroundControls';
import { seedFullEvidenceArchive } from './helpers/fullEvidenceArchive';

setupEvidenceTests();

test('collects every automatic research checkpoint while manual recording stays off', async () => {
  const view = await renderEvidenceCollection();
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();

  for (const minutes of [12, 9, 6, 3, 1]) {
    const observedAt = eventEnd - minutes * 60_000;
    await view.update(observedAt, { price: 50_000 + minutes });
    const rows = await exportBackgroundEvidence(view.user);
    const checkpoint = rows.find((row) => row.checkpointMinutes === minutes);
    expect(checkpoint).toMatchObject({
      event: 'decision',
      decision: 'pending',
      inputStatus: 'captured',
      inputObservedAt: observedAt,
      featureCutoffAt: observedAt,
      target: 50_000,
      expiresAt: eventEnd,
      spot: 50_000 + minutes,
      referenceSource: 'cf-brti',
      sessionOrigin: 'new',
    });
    expect(checkpoint.researchInputSnapshot).toBeTruthy();
    expect(checkpoint.aboveProbability + checkpoint.belowProbability).toBeCloseTo(1);
    await closeResearch(view.user);
  }

  const rows = await exportBackgroundEvidence(view.user);
  expect(rows.map((row) => row.checkpointMinutes)).toEqual([12, 9, 6, 3, 1]);
  expect(new Set(rows.map((row) => row.forecastId)).size).toBe(5);
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
});

test('marks earlier checkpoints missing when the page opens late and captures only the current checkpoint', async () => {
  const now = eventEnd - 6 * 60_000;
  const view = await renderEvidenceCollection({ now });
  const initialRows = await exportBackgroundEvidence(view.user);
  expect(initialRows).toHaveLength(3);
  for (const minutes of [12, 9]) {
    expect(initialRows.find((row) => row.checkpointMinutes === minutes)).toMatchObject({
      decision: 'withheld',
      inputStatus: 'decision-inputs-unavailable',
      inputObservedAt: null,
      aboveProbability: null,
      belowProbability: null,
    });
  }
  expect(initialRows.find((row) => row.checkpointMinutes === 6)).toMatchObject({
    decision: 'pending',
    inputObservedAt: now,
  });
  await view.update(now + 1000, { price: 50_200 });
  expect(await exportBackgroundEvidence(view.user)).toEqual(initialRows);
});

test('recovers a missing feed inside the checkpoint grace period and keeps a later missed call missing', async () => {
  const firstCaptureAt = eventEnd - 12 * 60_000;
  const noFeed = { ticker: null, benchmark: null, candles: [], hasRequestError: true };
  const view = await renderEvidenceCollection({ now: firstCaptureAt, feedOverrides: noFeed });
  await expectNoPendingEvidence(view.user);

  await view.update(firstCaptureAt + 2000, { price: 50_050 });
  const recovered = await exportBackgroundEvidence(view.user);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({
    checkpointMinutes: 12,
    decision: 'pending',
    inputObservedAt: firstCaptureAt + 2000,
    spot: 50_050,
  });

  const nextCaptureAt = eventEnd - 9 * 60_000;
  await view.update(nextCaptureAt + 5000, noFeed);
  const missed = await exportBackgroundEvidence(view.user);
  expect(missed).toHaveLength(2);
  expect(missed[1]).toMatchObject({
    checkpointMinutes: 9,
    decision: 'withheld',
    inputObservedAt: null,
    researchExperiment: null,
    aboveProbability: null,
  });
  await view.update(nextCaptureAt + 6000, { price: 50_100 });
  expect(await exportBackgroundEvidence(view.user)).toEqual(missed);
});

test.each([
  ['stale contract details', (now) => ({ ...currentMarket, receivedAt: now - 60_001 })],
  ['changed target', (now) => ({ ...currentMarket, target: 51_000, receivedAt: now })],
  [
    'unverified contract rules',
    (now) => ({ ...currentMarket, rulesVerified: false, receivedAt: now }),
  ],
])(
  'waits for a matching fresh contract after %s and records the later checkpoint',
  async (_label, changeMarket) => {
    const view = await renderEvidenceCollection();
    const firstCaptureAt = eventEnd - 12 * 60_000;
    await view.update(firstCaptureAt + 5000, { markets: [changeMarket(firstCaptureAt + 5000)] });
    const withheld = await exportBackgroundEvidence(view.user);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({
      target: 50_000,
      checkpointMinutes: 12,
      decision: 'withheld',
      inputStatus: 'decision-inputs-unavailable',
    });

    const nextCaptureAt = eventEnd - 9 * 60_000;
    await view.update(nextCaptureAt, {
      markets: [{ ...currentMarket, receivedAt: nextCaptureAt }],
      price: 50_100,
    });
    const rows = await exportBackgroundEvidence(view.user);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(withheld[0]);
    expect(rows[1]).toMatchObject({ target: 50_000, checkpointMinutes: 9, decision: 'pending' });
  },
);

test('restores completed captures without duplicates and keeps their original inputs after a reload', async () => {
  const firstCaptureAt = eventEnd - 12 * 60_000;
  const view = await renderEvidenceCollection({ now: firstCaptureAt });
  const firstRows = await exportBackgroundEvidence(view.user);
  expect(firstRows).toHaveLength(1);
  await closeResearch(view.user);
  await view.update(firstCaptureAt + 1000, { price: 50_500 });
  await view.reload();
  expect(await exportBackgroundEvidence(view.user)).toEqual(firstRows);

  await view.update(eventEnd - 9 * 60_000, { price: 49_900 });
  const rows = await exportBackgroundEvidence(view.user);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(firstRows[0]);
  expect(rows[1]).toMatchObject({ checkpointMinutes: 9, decision: 'pending', spot: 49_900 });
});

test('lets the other tab collect until its background lock becomes available', async () => {
  const captureAt = eventEnd - 12 * 60_000;
  setBackgroundLockAvailable(false);
  const view = await renderEvidenceCollection({ now: captureAt });
  await expectNoPendingEvidence(view.user);
  expect(screen.queryByText(/Research needs attention/)).not.toBeInTheDocument();

  setBackgroundLockAvailable(true);
  await view.update(captureAt + 1000);
  const rows = await exportBackgroundEvidence(view.user);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ decision: 'pending', inputObservedAt: captureAt + 1000 });
  await view.update(captureAt + 2000);
  expect(await exportBackgroundEvidence(view.user)).toEqual(rows);
});

test('replays the exact durable checkpoint after browser evidence storage recovers', async () => {
  const view = await renderEvidenceCollection();
  const database = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  const captureAt = eventEnd - 12 * 60_000;
  await view.update(captureAt, { price: 50_025 });
  const dialog = await openResearch(view.user);
  expect(
    await dialog.findByText(/Research recording is unavailable in this browser/),
  ).toBeVisible();
  await closeResearch(view.user);
  await view.update(captureAt + 1000, { price: 50_500 });

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: database });
  await view.reload();
  const restored = await exportBackgroundEvidence(view.user);
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({
    decision: 'pending',
    checkpointMinutes: 12,
    inputObservedAt: captureAt,
    recordedAt: captureAt,
    spot: 50_025,
  });
  await closeResearch(view.user);
  await view.reload();
  expect(await exportBackgroundEvidence(view.user)).toEqual(restored);
});

test('pauses collection on a storage write failure and resumes when the device can save again', async () => {
  const view = await renderEvidenceCollection();
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const storageFailure = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation((key, value) => {
      if (key === BACKGROUND_RESEARCH_STORAGE_KEY)
        throw new Error('Device research storage is full.');
      return originalSetItem(key, value);
    });
  const captureAt = eventEnd - 12 * 60_000;
  await view.update(captureAt);
  const dialog = await openResearch(view.user);
  expect(await dialog.findByText(/Device research storage is full/)).toBeVisible();
  await expectNoPendingEvidence(view.user);

  storageFailure.mockRestore();
  await view.update(captureAt + 1000);
  await waitFor(() =>
    expect(screen.queryByText(/Research needs attention/)).not.toBeInTheDocument(),
  );
  const rows = await exportBackgroundEvidence(view.user);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ inputObservedAt: captureAt + 1000, decision: 'pending' });
});

test('reports an unreadable saved recorder without replacing it or fabricating historical captures', async () => {
  localStorage.setItem(BACKGROUND_RESEARCH_STORAGE_KEY, '{interrupted save');
  const view = await renderEvidenceCollection({ now: eventEnd - 12 * 60_000 });
  const dialog = await openResearch(view.user);
  expect(
    await dialog.findByText(/Saved background research state is invalid; recording is paused/),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
  await expectNoPendingEvidence(view.user);
  expect(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).toBe('{interrupted save');
});

test('waits for the matching official settlement while collecting the next event', async () => {
  const firstCaptureAt = eventEnd - 12 * 60_000;
  const view = await renderEvidenceCollection({ now: firstCaptureAt });
  expect(await exportBackgroundEvidence(view.user)).toHaveLength(1);
  const secondMarket = { ...nextMarket, target: 50_200, status: 'active', receivedAt: eventEnd };
  await view.update(eventEnd, {
    markets: [{ ...currentMarket, status: 'closed', receivedAt: eventEnd }, secondMarket],
  });
  const closedRows = await exportBackgroundEvidence(view.user);
  expect(closedRows.filter((row) => row.event === 'decision')).toHaveLength(5);
  expect(closedRows.filter((row) => row.event === 'outcome')).toHaveLength(0);

  const nextCaptureAt = secondMarket.expiresAt - 12 * 60_000;
  await view.update(nextCaptureAt, {
    price: 50_300,
    markets: [
      {
        ...currentMarket,
        target: 49_000,
        status: 'finalized',
        result: 'yes',
        settlementPrice: 50_100,
        receivedAt: nextCaptureAt,
      },
      { ...secondMarket, receivedAt: nextCaptureAt },
    ],
  });
  const nextEventRows = await exportBackgroundEvidence(view.user);
  expect(nextEventRows.filter((row) => row.event === 'outcome')).toHaveLength(0);
  expect(
    nextEventRows.find((row) => row.kalshiMarket.ticker === secondMarket.ticker),
  ).toMatchObject({
    event: 'decision',
    decision: 'pending',
    target: 50_200,
    checkpointMinutes: 12,
  });

  await view.update(nextCaptureAt + 1000, {
    markets: [
      {
        ...currentMarket,
        status: 'finalized',
        result: 'yes',
        settlementPrice: 50_100,
        receivedAt: nextCaptureAt + 1000,
      },
      { ...secondMarket, receivedAt: nextCaptureAt + 1000 },
    ],
  });
  const settledRows = await exportBackgroundEvidence(view.user);
  const outcomes = settledRows.filter((row) => row.event === 'outcome');
  expect(outcomes).toHaveLength(5);
  for (const row of outcomes) {
    expect(row).toMatchObject({
      outcomeStatus: 'observed',
      outcome: 'above',
      observedPrice: 50_100,
      observedAt: eventEnd,
      inputStatus: 'outcome-only',
      inputObservedAt: null,
      target: 50_000,
    });
    expect(row.researchInputSnapshot).toBeUndefined();
  }
  expect(outcomes.find((row) => row.checkpointMinutes === 12).decision).toBe('resolved');
  expect(outcomes.find((row) => row.checkpointMinutes === 9).decision).toBe('withheld');
  await closeResearch(view.user);
  await view.reload();
  expect(await exportBackgroundEvidence(view.user)).toEqual(settledRows);
});

test('retrieves an older event result after it leaves the live market list and an initial lookup fails', async () => {
  const view = await renderEvidenceCollection({ now: eventEnd - 12 * 60_000 });
  expect(await exportBackgroundEvidence(view.user)).toHaveLength(1);
  await view.update(eventEnd, { markets: [] });
  const waiting = await exportBackgroundEvidence(view.user);
  expect(waiting.filter((row) => row.event === 'outcome')).toHaveLength(0);
  const requestsForEvent = () =>
    httpRequests.filter(
      (request) => request.path === `/api/kalshi/markets/${currentMarket.ticker}`,
    );
  expect(requestsForEvent()).toHaveLength(1);

  setSettlementResponse({
    ...currentMarket,
    status: 'settled',
    result: 'no',
    settlementPrice: 49_950,
    receivedAt: eventEnd + 15_000,
  });
  await view.update(eventEnd + 14_000, { markets: [] });
  expect(await exportBackgroundEvidence(view.user)).toEqual(waiting);
  expect(requestsForEvent()).toHaveLength(1);
  await view.update(eventEnd + 15_000, { markets: [] });
  await waitFor(() => expect(requestsForEvent()).toHaveLength(2));
  await exportBackgroundEvidence(view.user);
  await view.update(eventEnd + 16_000, { markets: [] });
  const settled = await exportBackgroundEvidence(view.user);
  const outcomes = settled.filter((row) => row.event === 'outcome');
  expect(outcomes).toHaveLength(5);
  for (const row of outcomes)
    expect(row).toMatchObject({
      outcomeStatus: 'observed',
      outcome: 'below',
      observedPrice: 49_950,
      observedAt: eventEnd,
      inputStatus: 'outcome-only',
    });
  await view.update(eventEnd + 17_000, { markets: [] });
  expect(await exportBackgroundEvidence(view.user)).toEqual(settled);
});

test('retains an old unsettled event until a fresh matching response confirms no official result', async () => {
  const view = await renderEvidenceCollection({ now: eventEnd - 12 * 60_000 });
  expect(await exportBackgroundEvidence(view.user)).toHaveLength(1);
  const returnAt = eventEnd + 8 * 24 * 60 * 60_000;
  await view.update(returnAt, { markets: [] });
  const waiting = await exportBackgroundEvidence(view.user);
  expect(waiting.filter((row) => row.event === 'outcome')).toHaveLength(0);
  await closeResearch(view.user);
  await view.reload();
  expect(await exportBackgroundEvidence(view.user)).toEqual(waiting);

  await view.update(returnAt + 1000, {
    markets: [{ ...currentMarket, status: 'closed', receivedAt: returnAt + 1000 }],
  });
  const outcomes = (await exportBackgroundEvidence(view.user)).filter(
    (row) => row.event === 'outcome',
  );
  expect(outcomes).toHaveLength(5);
  for (const row of outcomes)
    expect(row).toMatchObject({
      outcomeStatus: 'unobserved',
      observedPrice: null,
      observedAt: null,
      outcome: null,
      inputStatus: 'outcome-only',
    });
  expect(outcomes.find((row) => row.checkpointMinutes === 12).decision).toBe('unobserved');
});

test('retains a full device archive and resumes the exact checkpoint after confirmed uploads free storage', async () => {
  const savedRows = await seedFullEvidenceArchive();
  const view = await renderEvidenceCollection();
  const originalExport = await exportPendingEvidence(view.user);
  expect(originalExport).toHaveLength(25_000);
  expect(originalExport).toEqual(savedRows);

  const captureAt = eventEnd - 12 * 60_000;
  await view.update(captureAt, { price: 50_075 });
  const dialog = await openResearch(view.user);
  expect(
    await dialog.findByText(
      /Research storage is full. Recording paused; existing data is retained/,
    ),
  ).toBeVisible();
  expect(await exportPendingEvidence(view.user)).toEqual(originalExport);
  expect(ingestRequests).toHaveLength(1);

  setIngestResponse(({ batch }) => {
    setIngestResponse(null);
    return {
      body: {
        evidence: { inserted: batch.evidence.length, duplicates: 0 },
        forecasts: { inserted: batch.forecasts.length, duplicates: 0 },
      },
    };
  });
  await act(async () => releaseIngestRequests());
  await waitFor(() => expect(ingestRequests.length).toBe(2), { timeout: 5000 });
  const uploadedIds = new Set(ingestRequests[0].evidence.map((row) => row.eventId));
  expect(uploadedIds.size).toBe(50);
  await view.update(captureAt + 1000, { price: 50_500 });
  await waitFor(() =>
    expect(screen.queryByText(/Research needs attention/)).not.toBeInTheDocument(),
  );
  const resumed = await exportPendingEvidence(view.user);
  expect(resumed).toHaveLength(24_951);
  const historical = resumed.filter((row) => row.cohort === 'manual');
  expect(historical).toEqual(savedRows.filter((row) => !uploadedIds.has(row.eventId)));
  expect(resumed.find((row) => row.cohort === 'kalshi-background')).toMatchObject({
    event: 'decision',
    decision: 'pending',
    recordedAt: captureAt,
    inputObservedAt: captureAt,
    spot: 50_075,
  });
}, 30_000);
