import { screen, waitFor, within } from '@testing-library/react';
import { renderForecastJournal, setupJournalTests } from '../helpers/journalTestHarness';
import { createSavedForecast, journalNow } from '../helpers/journalFixtures';
import { formatTime } from '@/utils/format.utils';

setupJournalTests();

test('opens an empty journal from the keyboard and returns focus after closing history', async () => {
  const view = await renderForecastJournal();
  expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
  expect(screen.getByText('Forecasts appear here when their countdown starts.')).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();

  await view.user.tab();
  const historyButton = screen.getByRole('button', { name: 'View history' });
  expect(historyButton).toHaveFocus();
  await view.user.keyboard('{Enter}');
  const history = within(await screen.findByRole('dialog', { name: 'Forecast history' }));
  expect(history.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
  expect(history.getByText(/Stored in this browser/)).toBeVisible();
  expect(history.getByText('Scored:')).toHaveTextContent('Scored: 0');
  expect(history.getByText('Observed accuracy:')).toHaveTextContent('Observed accuracy: —');
  expect(history.getByText('Brier:')).toHaveTextContent('Brier: —');
  expect(history.getByText('Call coverage:')).toHaveTextContent('Call coverage: —');

  await view.user.click(history.getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(historyButton).toHaveFocus();
});

test('previews the latest saved call and opens the full, newest-first history with contract details', async () => {
  const earlier = createSavedForecast({
    id: 'earlier-call',
    startsAt: journalNow - 1_800_000,
    target: 49_000,
    checkpointMinutes: 9,
    aboveProbability: 0.2,
    result: 'no',
  });
  const latest = createSavedForecast({
    id: 'latest-call',
    target: 51_000,
    checkpointMinutes: 6,
    aboveProbability: 0.8,
    captureOrigin: 'automatic',
  });
  const view = await renderForecastJournal({ forecasts: [earlier, latest] });
  const preview = within(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }));
  expect(preview.getAllByRole('row')).toHaveLength(2);
  expect(preview.getByRole('row', { name: /\$51,000\.00/ })).toHaveTextContent(
    'Likely Yes · at or above',
  );
  expect(preview.queryByText('$49,000.00')).not.toBeInTheDocument();
  expect(preview.queryByRole('columnheader', { name: 'Yes / No' })).not.toBeInTheDocument();

  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = within(await screen.findByRole('dialog', { name: 'Forecast history' }));
  const table = within(
    history.getByRole('table', { name: 'Recorded Bitcoin forecasts and observed outcomes' }),
  );
  const rows = table.getAllByRole('row').slice(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('$51,000.00');
  expect(rows[1]).toHaveTextContent('$49,000.00');
  expect(rows[0]).toHaveTextContent(
    `${formatTime(latest.startsAt)}–${formatTime(latest.expiresAt)}`,
  );
  expect(rows[0]).toHaveTextContent(`Kalshi · ${latest.kalshiMarket.ticker} · 6 min left · Auto`);
  expect(rows[0]).toHaveTextContent('80.0% / 20.0%');
  expect(rows[0]).toHaveTextContent('$51,100.00');
  expect(rows[0]).toHaveTextContent('Official Kalshi settlement');
  expect(rows[0]).toHaveTextContent('Correct');
  expect(rows[1]).toHaveTextContent('Likely No · below');
  expect(rows[1]).toHaveTextContent('20.0% / 80.0%');
  expect(rows[1]).not.toHaveTextContent('Auto');
  expect(history.getByText(/Yes includes ties/)).toBeVisible();

  await view.user.click(history.getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await view.reload();
  expect(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' })).toHaveTextContent(
    '$51,000.00',
  );
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  expect(
    within(await screen.findByRole('dialog', { name: 'Forecast history' })).getAllByRole('row'),
  ).toHaveLength(3);
});

test('explains mixed outcomes and calculates accuracy, probability error, and call coverage from saved history', async () => {
  const view = await renderForecastJournal({
    now: journalNow + 7 * 60_000,
    forecasts: [
      createSavedForecast({
        id: 'correct',
        startsAt: journalNow - 6 * 900_000,
        target: 51_000,
        aboveProbability: 0.8,
        result: 'yes',
      }),
      createSavedForecast({
        id: 'incorrect',
        startsAt: journalNow - 5 * 900_000,
        target: 52_000,
        aboveProbability: 0.7,
        result: 'no',
      }),
      createSavedForecast({
        id: 'neutral',
        startsAt: journalNow - 4 * 900_000,
        target: 53_000,
        aboveProbability: 0.5,
        result: 'yes',
      }),
      createSavedForecast({
        id: 'no-call',
        startsAt: journalNow - 3 * 900_000,
        status: 'withheld',
        target: 54_000,
      }),
      createSavedForecast({
        id: 'awaiting',
        startsAt: journalNow - 2 * 900_000,
        status: 'awaiting-settlement',
        target: 55_000,
      }),
      createSavedForecast({ id: 'unobserved', status: 'unobserved', target: 56_000 }),
      createSavedForecast({
        id: 'pending',
        status: 'pending',
        startsAt: journalNow,
        checkpointMinutes: 9,
      }),
      createSavedForecast({
        id: 'observing',
        status: 'analyzing',
        startsAt: journalNow,
        checkpointMinutes: 6,
      }),
    ],
  });
  expect(screen.getByText('Scored:')).toHaveTextContent('Scored: 2');
  expect(screen.getByText('Current policy accuracy:')).toHaveTextContent(
    'Current policy accuracy: 50.0%',
  );
  expect(screen.getByText('No calls:')).toHaveTextContent('No calls: 1');
  expect(screen.getByText('Call coverage:')).toHaveTextContent('Call coverage: 85.7%');

  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = within(await screen.findByRole('dialog', { name: 'Forecast history' }));
  expect(history.getByRole('row', { name: /\$51,000\.00/ })).toHaveTextContent('Correct');
  expect(history.getByRole('row', { name: /\$52,000\.00/ })).toHaveTextContent('Incorrect');
  const neutralRow = history.getByRole('row', { name: /\$53,000\.00/ });
  expect(neutralRow).toHaveTextContent('No directional edge');
  expect(neutralRow).toHaveTextContent('50.0% / 50.0%');
  expect(neutralRow).toHaveTextContent('Neutral · unscored');
  const noCallRow = history.getByRole('row', { name: /\$54,000\.00/ });
  expect(noCallRow).toHaveTextContent('No fixed call');
  expect(noCallRow).toHaveTextContent('Not issued');
  expect(noCallRow).toHaveTextContent('No call · unscored');
  expect(history.getByRole('row', { name: /\$55,000\.00/ })).toHaveTextContent('Awaiting Kalshi');
  expect(history.getByRole('row', { name: /\$56,000\.00/ })).toHaveTextContent('Unobserved');
  expect(history.getByRole('row', { name: /\$50,000\.00.*9 min left/ })).toHaveTextContent('08:00');
  const observingRow = history.getByRole('row', { name: /\$50,000\.00.*6 min left/ });
  expect(observingRow).toHaveTextContent('Observing');
  expect(observingRow).toHaveTextContent('Not issued');
  expect(history.getByText('Scored:')).toHaveTextContent('Scored: 2');
  expect(history.getByText('Observed accuracy:')).toHaveTextContent('Observed accuracy: 50.0%');
  // (0.2² + 0.7² + 0.5²) / 3: neutral calls contribute probability error,
  // while no calls and unfinished records contribute no scored result.
  expect(history.getByText('Brier:')).toHaveTextContent('Brier: 0.260');
  expect(history.getByText('Observing:')).toHaveTextContent('Observing: 1');
  expect(history.getByText('Issued after observation:')).toHaveTextContent(
    'Issued after observation: 6',
  );
  expect(history.getByText('Call coverage:')).toHaveTextContent('Call coverage: 85.7%');
});

test('shows small Yes and No leans with their saved probabilities in the history details', async () => {
  const view = await renderForecastJournal({
    forecasts: [
      createSavedForecast({ id: 'slight-yes', target: 51_000, aboveProbability: 0.53 }),
      createSavedForecast({
        id: 'slight-no',
        startsAt: journalNow - 1_800_000,
        target: 49_000,
        aboveProbability: 0.47,
        result: 'no',
      }),
    ],
  });
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = within(await screen.findByRole('dialog', { name: 'Forecast history' }));
  const yesRow = history.getByRole('row', { name: /\$51,000\.00/ });
  const noRow = history.getByRole('row', { name: /\$49,000\.00/ });
  expect(yesRow).toHaveTextContent('Slight lean Yes · at or above');
  expect(yesRow).toHaveTextContent('53.0% / 47.0%');
  expect(noRow).toHaveTextContent('Slight lean No · below');
  expect(noRow).toHaveTextContent('47.0% / 53.0%');
});

test.each(['header close', 'Escape'])(
  'closes populated history with %s and restores focus without changing the saved calls',
  async (closeMethod) => {
    const view = await renderForecastJournal({
      forecasts: [createSavedForecast({ id: 'saved-call' })],
    });
    const historyButton = screen.getByRole('button', { name: 'View history' });
    await view.user.click(historyButton);
    const dialog = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(dialog).toBeVisible();
    expect(within(dialog).getAllByRole('row')).toHaveLength(2);
    if (closeMethod === 'header close') {
      await view.user.click(within(dialog).getByRole('button', { name: 'Close', exact: true }));
    } else {
      await view.user.keyboard('{Escape}');
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(historyButton).toHaveFocus();
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('$50,000.00');
    await view.user.keyboard('{Enter}');
    expect(
      within(await screen.findByRole('dialog', { name: 'Forecast history' })).getAllByRole('row'),
    ).toHaveLength(2);
  },
);
