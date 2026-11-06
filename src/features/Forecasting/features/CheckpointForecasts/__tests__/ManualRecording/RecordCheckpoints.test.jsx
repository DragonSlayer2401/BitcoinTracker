import { screen } from '@testing-library/react';
import { checkpointRow, fixedCall } from './helpers/checkpointQueries';
import {
  currentMarket,
  eventEnd,
  eventStart,
  nextMarket,
  renderCheckpointForecasts,
  selectEvent,
  setSettlementResponse,
  setupCheckpointTests,
} from '../helpers/checkpointTestHarness';

setupCheckpointTests();

const nineMinuteCheckpoint = eventEnd - 9 * 60_000;
const sixMinuteCheckpoint = eventEnd - 6 * 60_000;

test('selects every supported checkpoint and captures each call at its displayed time', async () => {
  const view = await renderCheckpointForecasts();
  for (const minutes of [12, 3, 1]) {
    await view.user.click(screen.getByRole('combobox', { name: 'Fixed checkpoints' }));
    await view.user.click(screen.getByRole('option', { name: `${minutes} min left`, exact: true }));
    await view.user.keyboard('{Escape}');
  }
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  const savedCalls = new Map();
  for (const minutes of [12, 9, 6, 3, 1]) {
    const captureAt = eventEnd - minutes * 60_000;
    await view.update(captureAt - 1000, { price: 50_100 });
    expect(checkpointRow(minutes)).toHaveTextContent('In 00:01');
    await view.update(captureAt, { price: 50_100 });
    expect(checkpointRow(minutes)).toHaveTextContent(/Yes · .*Saved/);
    savedCalls.set(minutes, fixedCall(minutes));
    for (const [savedMinutes, call] of savedCalls) {
      expect(fixedCall(savedMinutes)).toBe(call);
    }
  }
  expect(screen.getAllByRole('row')).toHaveLength(6);
  expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
  await view.reload();
  for (const [minutes, call] of savedCalls) {
    expect(checkpointRow(minutes)).toHaveTextContent('Saved');
    expect(fixedCall(minutes)).toBe(call);
  }
});

test('starts from the official event, captures separate calls and preserves them through settlement and reload', async () => {
  const view = await renderCheckpointForecasts();
  expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_000);
  expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveAttribute(
    'readonly',
  );
  expect(screen.getByRole('link', { name: /View contract and rules/ })).toHaveAttribute(
    'href',
    currentMarket.url,
  );
  expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('15:00');

  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeDisabled();
  expect(checkpointRow(9)).toHaveTextContent('In 06:00');
  expect(checkpointRow(6)).toHaveTextContent('In 09:00');

  await view.update(nineMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(9)).toHaveTextContent(/Yes · .*Saved/);
  const firstCall = fixedCall(9);
  expect(checkpointRow(6)).toHaveTextContent('In 03:00');
  await view.update(sixMinuteCheckpoint, { price: 49_900 });
  expect(checkpointRow(6)).toHaveTextContent(/No · .*Saved/);
  const secondCall = fixedCall(6);
  expect(fixedCall(9)).toBe(firstCall);
  await view.update(sixMinuteCheckpoint + 1000, { price: 50_300 });
  expect(fixedCall(9)).toBe(firstCall);
  expect(fixedCall(6)).toBe(secondCall);
  await view.reload();
  expect(fixedCall(9)).toBe(firstCall);
  expect(fixedCall(6)).toBe(secondCall);
  expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();

  await view.update(eventEnd);
  expect(screen.getByRole('heading', { name: 'Awaiting Kalshi settlement' })).toBeVisible();
  expect(checkpointRow(9)).toHaveTextContent('Awaiting result');
  expect(checkpointRow(6)).toHaveTextContent('Awaiting result');
  expect(
    await screen.findByText('Kalshi results are delayed. Saved forecasts will be checked again.'),
  ).toBeVisible();
  // A tie is an official Yes result, regardless of the latest live price.
  setSettlementResponse({
    ...currentMarket,
    status: 'settled',
    result: 'yes',
    settlementPrice: 50_000,
    receivedAt: eventEnd + 15_000,
  });
  await view.update(eventEnd + 15_000);
  expect(await screen.findByRole('heading', { name: 'Result observed' })).toBeVisible();
  expect(checkpointRow(9)).toHaveTextContent('Correct');
  expect(checkpointRow(6)).toHaveTextContent('Incorrect');
  expect(screen.getByRole('status')).toHaveTextContent('Kalshi settled Yes');
  expect(fixedCall(9)).toBe(firstCall);
  expect(fixedCall(6)).toBe(secondCall);
  await view.reload();
  expect(screen.getByRole('heading', { name: 'Result observed' })).toBeVisible();
  expect(checkpointRow(9)).toHaveTextContent('Correct');
  await view.update(eventEnd + 16_000, {
    markets: [{ ...nextMarket, status: 'active', target: 50_050 }],
  });
  await view.user.click(screen.getByRole('button', { name: 'New forecast' }));
  expect(
    screen.queryByRole('region', { name: 'Saved and upcoming fixed checkpoints' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_050);
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  expect(checkpointRow(9)).toHaveTextContent('In 05:44');
});

test('reloads armed checkpoints without moving their deadlines or creating duplicates', async () => {
  const view = await renderCheckpointForecasts();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(eventStart + 60_000);
  await view.reload();
  expect(checkpointRow(9)).toHaveTextContent('In 05:00');
  expect(checkpointRow(6)).toHaveTextContent('In 08:00');
  expect(screen.getAllByRole('row')).toHaveLength(3);
  await view.update(nineMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(9)).toHaveTextContent(/Yes · .*Saved/);
  expect(screen.getAllByRole('row')).toHaveLength(3);
});

test('joins just before a checkpoint and captures at its selected time without an extra observation wait', async () => {
  const view = await renderCheckpointForecasts({ now: nineMinuteCheckpoint - 1000 });
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(checkpointRow(9)).toHaveTextContent('In 00:01');
  await view.update(nineMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(9)).toHaveTextContent(/Yes · .*Saved/);
  expect(checkpointRow(6)).toHaveTextContent('In 03:00');
});

test('joins after a checkpoint has passed and captures only the remaining checkpoint', async () => {
  const view = await renderCheckpointForecasts({ now: nineMinuteCheckpoint + 5001 });
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(checkpointRow(9)).toHaveTextContent('Missed');
  expect(fixedCall(9)).toBe('—');
  await view.update(sixMinuteCheckpoint, { price: 49_900 });
  expect(checkpointRow(6)).toHaveTextContent(/No · .*Saved/);
  expect(checkpointRow(9)).toHaveTextContent('Missed');
});

test('recovers fresh inputs within the grace window and saves the waiting call once', async () => {
  const view = await renderCheckpointForecasts();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(nineMinuteCheckpoint, { benchmark: null, ticker: null, hasRequestError: true });
  expect(checkpointRow(9)).toHaveTextContent('Waiting for data');
  expect(fixedCall(9)).toBe('—');
  await view.update(nineMinuteCheckpoint + 4000, { price: 50_100 });
  expect(checkpointRow(9)).toHaveTextContent(/Yes · .*Saved/);
  const savedCall = fixedCall(9);
  await view.update(nineMinuteCheckpoint + 5000, { price: 49_900 });
  expect(fixedCall(9)).toBe(savedCall);
});

test('leaves an unavailable checkpoint uncaptured while recovery allows the next call', async () => {
  const view = await renderCheckpointForecasts();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(nineMinuteCheckpoint, { benchmark: null, ticker: null, hasRequestError: true });
  expect(checkpointRow(9)).toHaveTextContent('Waiting for data');
  await view.update(nineMinuteCheckpoint + 5001, {
    benchmark: null,
    ticker: null,
    hasRequestError: true,
  });
  expect(checkpointRow(9)).toHaveTextContent('Not captured');
  expect(fixedCall(9)).toBe('—');
  await view.update(sixMinuteCheckpoint, { price: 50_100 });
  expect(checkpointRow(6)).toHaveTextContent(/Yes · .*Saved/);
  expect(checkpointRow(9)).toHaveTextContent('Not captured');
  expect(fixedCall(9)).toBe('—');
  await view.reload();
  expect(checkpointRow(9)).toHaveTextContent('Not captured');
  expect(checkpointRow(6)).toHaveTextContent(/Yes · .*Saved/);
});

test('prevents recording the same event again after all its selected checkpoints were missed', async () => {
  const view = await renderCheckpointForecasts({ now: sixMinuteCheckpoint + 5001 });
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(checkpointRow(9)).toHaveTextContent('Missed');
  expect(checkpointRow(6)).toHaveTextContent('Missed');
  await view.user.click(screen.getByRole('button', { name: 'New forecast' }));
  expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
  await selectEvent(view.user, currentMarket);
  expect(screen.getByRole('button', { name: 'Event already recorded' })).toBeDisabled();
  expect(screen.getAllByRole('row')).toHaveLength(3);
  await selectEvent(view.user, nextMarket);
  expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
});
