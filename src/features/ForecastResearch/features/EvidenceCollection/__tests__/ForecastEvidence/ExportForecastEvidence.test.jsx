import { act, screen, waitFor, within } from '@testing-library/react';
import {
  closeResearch,
  openResearch,
  renderEvidenceCollection,
  setupEvidenceTests,
} from '../helpers/evidenceTestHarness';
import {
  createMarketFeed,
  createSavedForecast,
  currentMarket,
  eventEnd,
  eventStart,
} from '../helpers/evidenceFixtures';
import {
  releaseIngestRequests,
  setIngestResponse,
  setSettlementResponse,
} from '../helpers/evidenceServer';
import {
  checkpointRow,
  clearCompleted,
  exportManualEvidence,
} from './helpers/forecastEvidenceControls';

setupEvidenceTests();

const nineMinuteCheckpoint = eventEnd - 9 * 60_000;
const sixMinuteCheckpoint = eventEnd - 6 * 60_000;

test('exports observed inputs once per sampling interval and keeps separate observations after a reload', async () => {
  const view = await renderEvidenceCollection();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(checkpointRow(9)).toHaveTextContent('In 06:00');
  let rows = await exportManualEvidence(view.user);
  const initialObservations = rows.filter((row) => row.event === 'observation');
  expect(initialObservations).toHaveLength(2);
  expect(rows.some((row) => row.event === 'restored')).toBe(false);
  for (const row of initialObservations) {
    expect(row).toMatchObject({
      sessionOrigin: 'new',
      inputStatus: 'captured',
      inputObservedAt: eventStart,
      target: 50_000,
      spot: 50_000,
      decision: 'analyzing',
      referenceSource: 'cf-brti',
    });
    expect(row.aboveProbability).toEqual(expect.any(Number));
  }

  await view.update(eventStart + 1000, { price: 50_100 });
  await view.update(eventStart + 4000, { price: 49_900 });
  rows = await exportManualEvidence(view.user);
  expect(rows.filter((row) => row.event === 'observation')).toEqual(initialObservations);

  await view.update(eventStart + 5000, { price: 50_100 });
  rows = await exportManualEvidence(view.user);
  const nextObservations = rows.filter(
    (row) => row.event === 'observation' && row.inputObservedAt === eventStart + 5000,
  );
  expect(nextObservations).toHaveLength(2);
  expect(nextObservations.every((row) => row.spot === 50_100)).toBe(true);

  await view.reload();
  expect(checkpointRow(9)).toHaveTextContent('In 05:55');
  rows = await exportManualEvidence(view.user);
  expect(rows.filter((row) => row.event === 'observation')).toHaveLength(6);
  expect(new Set(rows.map((row) => row.eventId)).size).toBe(rows.length);
  expect(rows.filter((row) => row.event === 'restored')).toHaveLength(2);
  expect(
    rows.filter((row) => row.event === 'observation' && row.sessionOrigin === 'restored'),
  ).toHaveLength(2);
  for (const original of initialObservations) expect(rows).toContainEqual(original);
});

test('exports the captured decision inputs and official outcome without rewriting a saved prediction', async () => {
  const view = await renderEvidenceCollection();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(nineMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(9)).toHaveTextContent(/Yes .*Saved/);
  await view.update(sixMinuteCheckpoint, { price: 49_900 });
  expect(checkpointRow(6)).toHaveTextContent(/No .*Saved/);
  let rows = await exportManualEvidence(view.user);
  const decisions = rows.filter((row) => row.event === 'decision');
  expect(decisions).toHaveLength(2);
  for (const [minutes, capturedAt, price] of [
    [9, nineMinuteCheckpoint, 50_100],
    [6, sixMinuteCheckpoint, 49_900],
  ]) {
    const decision = decisions.find((row) => row.checkpointMinutes === minutes);
    expect(decision).toMatchObject({
      event: 'decision',
      decision: 'pending',
      inputStatus: 'captured',
      sessionOrigin: 'new',
      checkpointMinutes: minutes,
      inputObservedAt: capturedAt,
      featureCutoffAt: capturedAt,
      decisionAt: capturedAt,
      capturedAt,
      target: 50_000,
      expiresAt: eventEnd,
      spot: price,
    });
    const capturedFeed = createMarketFeed(capturedAt, price);
    expect(decision.researchInputSnapshot).toMatchObject({
      capturedAt,
      windowStartAt: eventStart,
      input: {
        now: capturedAt,
        target: 50_000,
        expiresAt: eventEnd,
        ticker: capturedFeed.ticker,
        candles: capturedFeed.candles,
        benchmark: capturedFeed.benchmark,
        kalshiMarket: { ticker: currentMarket.ticker },
      },
    });
    expect(decision.researchExperiment).toEqual(expect.any(Object));
    expect(decision.aboveProbability + decision.belowProbability).toBeCloseTo(1);
  }
  expect(decisions.find((row) => row.checkpointMinutes === 9).aboveProbability).toBeGreaterThan(
    0.5,
  );
  expect(decisions.find((row) => row.checkpointMinutes === 6).aboveProbability).toBeLessThan(0.5);

  await view.update(sixMinuteCheckpoint + 5000, { price: 50_500 });
  rows = await exportManualEvidence(view.user);
  expect(rows.filter((row) => row.event === 'decision')).toEqual(decisions);
  setSettlementResponse({
    ...currentMarket,
    status: 'settled',
    result: 'yes',
    settlementPrice: 50_000,
    receivedAt: eventEnd,
  });
  await view.update(eventEnd, { price: 49_000 });
  expect(await screen.findByRole('heading', { name: 'Result observed' })).toBeVisible();
  expect(checkpointRow(9)).toHaveTextContent('Correct');
  expect(checkpointRow(6)).toHaveTextContent('Incorrect');
  rows = await exportManualEvidence(view.user);
  expect(rows.filter((row) => row.event === 'decision')).toEqual(decisions);
  const outcomes = rows.filter((row) => row.event === 'outcome');
  expect(outcomes).toHaveLength(2);
  for (const outcome of outcomes) {
    const decision = decisions.find((row) => row.forecastId === outcome.forecastId);
    expect(outcome).toMatchObject({
      inputStatus: 'outcome-only',
      inputObservedAt: null,
      spot: null,
      outcomeStatus: 'observed',
      observedPrice: 50_000,
      aboveProbability: decision.aboveProbability,
      belowProbability: decision.belowProbability,
    });
    expect(outcome.researchInputSnapshot).toBeUndefined();
    expect(outcome.researchExperiment).toBeNull();
  }

  await clearCompleted(view.user);
  expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
  expect(await exportManualEvidence(view.user)).toEqual(rows);
  await view.reload();
  expect(await exportManualEvidence(view.user)).toEqual(rows);
});

test('exports restored saved calls with their original probabilities and no reconstructed capture inputs', async () => {
  const forecast = createSavedForecast({ id: 'imported-fixed-call', aboveProbability: 0.8 });
  const view = await renderEvidenceCollection({
    now: eventStart + 600_000,
    forecasts: [forecast],
  });
  let rows = await exportManualEvidence(view.user);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    event: 'restored',
    forecastId: forecast.id,
    sessionOrigin: 'restored',
    inputStatus: 'restored-without-inputs',
    inputObservedAt: null,
    spot: null,
    learningFeatures: null,
    researchExperiment: null,
    aboveProbability: 0.8,
    decision: 'pending',
  });
  expect(rows[0].researchInputSnapshot).toBeUndefined();
  const original = rows[0];
  await view.update(eventStart + 605_000, { price: 49_000 });
  expect(await exportManualEvidence(view.user)).toEqual([original]);
  await view.reload();
  rows = await exportManualEvidence(view.user);
  expect(rows).toHaveLength(2);
  expect(rows).toContainEqual(original);
  expect(rows.every((row) => row.event === 'restored')).toBe(true);
  expect(rows.every((row) => row.inputStatus === 'restored-without-inputs')).toBe(true);
  expect(rows.every((row) => row.aboveProbability === 0.8)).toBe(true);
});

test('resumes a restored observation and captures only the inputs available at its original checkpoint', async () => {
  const forecast = createSavedForecast({ id: 'restored-observation', status: 'analyzing' });
  const view = await renderEvidenceCollection({
    now: eventStart + 120_000,
    forecasts: [forecast],
  });
  expect(checkpointRow(9)).toHaveTextContent('In 04:00');
  let rows = await exportManualEvidence(view.user);
  expect(rows.find((row) => row.event === 'restored')).toMatchObject({
    forecastId: forecast.id,
    inputStatus: 'restored-without-inputs',
    inputObservedAt: null,
    spot: null,
  });
  expect(rows.find((row) => row.event === 'observation')).toMatchObject({
    forecastId: forecast.id,
    sessionOrigin: 'restored',
    inputObservedAt: eventStart + 120_000,
  });
  expect(rows.some((row) => row.event === 'decision')).toBe(false);
  await view.update(nineMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(9)).toHaveTextContent(/Yes .*Saved/);
  rows = await exportManualEvidence(view.user);
  expect(rows.filter((row) => row.event === 'decision')).toHaveLength(1);
  expect(rows.find((row) => row.event === 'decision')).toMatchObject({
    forecastId: forecast.id,
    sessionOrigin: 'restored',
    inputStatus: 'captured',
    inputObservedAt: nineMinuteCheckpoint,
    spot: 50_100,
    expiresAt: eventEnd,
  });
});

test('retains a missed checkpoint as research evidence and observes its outcome after clearing the no-call journal entry', async () => {
  const view = await renderEvidenceCollection();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  const outage = { ticker: null, benchmark: null, candles: [], hasRequestError: true };
  await view.update(nineMinuteCheckpoint, outage);
  expect(checkpointRow(9)).toHaveTextContent('Waiting for data');
  await view.update(nineMinuteCheckpoint + 5001, outage);
  expect(checkpointRow(9)).toHaveTextContent('Not captured');
  await view.update(sixMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(6)).toHaveTextContent(/Yes .*Saved/);
  let rows = await exportManualEvidence(view.user);
  const withheld = rows.find((row) => row.event === 'decision' && row.checkpointMinutes === 9);
  expect(withheld).toMatchObject({
    decision: 'withheld',
    aboveProbability: null,
    belowProbability: null,
    spot: null,
    reason: 'market-data-unavailable',
  });
  expect(
    rows.filter((row) => row.event === 'decision' && row.checkpointMinutes === 6),
  ).toHaveLength(1);
  await clearCompleted(view.user);
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = await screen.findByRole('dialog', { name: 'Forecast history' });
  expect(within(history).queryByRole('row', { name: /9 min left/ })).not.toBeInTheDocument();
  expect(within(history).getByRole('row', { name: /6 min left/ })).toBeVisible();
  await view.user.click(within(history).getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  setSettlementResponse({
    ...currentMarket,
    status: 'settled',
    result: 'no',
    settlementPrice: 49_950,
    receivedAt: eventEnd,
  });
  await view.update(eventEnd);
  expect(await screen.findByRole('heading', { name: 'Result observed' })).toBeVisible();
  rows = await exportManualEvidence(view.user);
  expect(rows).toContainEqual(withheld);
  const noCallOutcomes = rows.filter(
    (row) => row.event === 'outcome' && row.forecastId === withheld.forecastId,
  );
  expect(noCallOutcomes).toHaveLength(1);
  expect(noCallOutcomes[0]).toMatchObject({
    decision: 'withheld',
    inputStatus: 'outcome-only',
    outcomeStatus: 'observed',
    observedPrice: 49_950,
    aboveProbability: null,
    spot: null,
  });
  await view.update(eventEnd + 15_000);
  rows = await exportManualEvidence(view.user);
  expect(
    rows.filter((row) => row.event === 'outcome' && row.forecastId === withheld.forecastId),
  ).toEqual(noCallOutcomes);
});

test('shows a recording warning when browser storage disappears and retries the original observations after recovery', async () => {
  const view = await renderEvidenceCollection();
  const availableIndexedDb = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(checkpointRow(9)).toHaveTextContent('In 06:00');
  expect(await screen.findByText('Research needs attention · see Research data')).toBeVisible();
  const research = await openResearch(view.user);
  expect(research.getByRole('alert')).toHaveTextContent(
    'Research recording is unavailable in this browser.',
  );
  expect(research.getByRole('link', { name: 'Check archive access' })).toHaveAttribute(
    'href',
    '/api/research/status',
  );
  await closeResearch(view.user);

  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: availableIndexedDb });
  await view.update(eventStart + 29_000, { price: 49_900 });
  expect(screen.getByText('Research needs attention · see Research data')).toBeVisible();
  await view.update(eventStart + 30_000, { price: 50_100 });
  const rows = await exportManualEvidence(view.user);
  const originalObservations = rows.filter(
    (row) => row.event === 'observation' && row.inputObservedAt === eventStart,
  );
  expect(originalObservations).toHaveLength(2);
  expect(originalObservations.every((row) => row.spot === 50_000)).toBe(true);
  const recoveredObservations = rows.filter(
    (row) => row.event === 'observation' && row.inputObservedAt === eventStart + 30_000,
  );
  expect(recoveredObservations).toHaveLength(2);
  expect(recoveredObservations.every((row) => row.spot === 50_100)).toBe(true);
  expect(new Set(rows.map((row) => row.eventId)).size).toBe(rows.length);

  setIngestResponse();
  await act(async () => releaseIngestRequests());
  await waitFor(() =>
    expect(
      screen.queryByText('Research needs attention · see Research data'),
    ).not.toBeInTheDocument(),
  );
});
