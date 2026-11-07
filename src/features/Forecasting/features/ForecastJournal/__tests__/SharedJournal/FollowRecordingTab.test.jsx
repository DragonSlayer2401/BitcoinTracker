import { screen, waitFor, within } from '@testing-library/react';
import { JOURNAL_STORAGE_KEY } from '../../utils/journal.utils';
import { createSavedForecast, journalNow } from '../helpers/journalFixtures';
import {
  renderForecastJournal,
  saveBrowserJournal,
  setupJournalTests,
} from '../helpers/journalTestHarness';

setupJournalTests();

test('updates an open history from another tab and takes over safely when that writer closes', async () => {
  const original = createSavedForecast({ id: 'original-call', startsAt: journalNow - 1_800_000 });
  const newest = createSavedForecast({ id: 'newest-call', target: 51_000 });
  const view = await renderForecastJournal({ forecasts: [original], lock: 'follower' });
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = within(screen.getByRole('dialog', { name: 'Forecast history' }));
  expect(history.getAllByRole('row')).toHaveLength(2);
  await view.syncFromOtherTab({ forecasts: [newest, original] });
  expect(history.getAllByRole('row')).toHaveLength(3);
  expect(history.getByRole('table')).toHaveTextContent('$51,000.00');
  expect(history.getByText('Scored:').parentElement).toHaveTextContent('Scored: 2');
  await view.user.click(history.getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  // The outgoing writer saved again before this tab received its storage event.
  const unseen = createSavedForecast({
    id: 'unseen-call',
    startsAt: journalNow - 2_700_000,
    target: 52_000,
  });
  saveBrowserJournal({ forecasts: [newest, original, unseen] });
  await view.acquireOwnership();
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const restoredHistory = within(screen.getByRole('dialog', { name: 'Forecast history' }));
  expect(restoredHistory.getAllByRole('row')).toHaveLength(4);
  expect(restoredHistory.getByRole('row', { name: /\$52,000\.00/ })).toHaveTextContent('Correct');
  await view.user.click(restoredHistory.getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
  await view.user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear completed' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
  await view.reload();
  expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
});

test.each([
  ['unsupported', 'This browser cannot coordinate saved forecasts across tabs.'],
  ['failed', 'Browser lock is unavailable. Recording paused; reload to retry.'],
])('keeps history readable and unchanged when browser locking is %s', async (lock, warning) => {
  const savedForecast = createSavedForecast();
  const view = await renderForecastJournal({ forecasts: [savedForecast], lock });
  expect(await screen.findByRole('alert')).toHaveTextContent(warning);
  const originalJournal = localStorage.getItem(JOURNAL_STORAGE_KEY);
  await view.user.click(screen.getByRole('button', { name: 'View history' }));
  const history = within(screen.getByRole('dialog', { name: 'Forecast history' }));
  expect(history.getByRole('table')).toHaveTextContent('80.0% / 20.0%');
  await view.user.click(history.getByRole('button', { name: 'Close history' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
  await view.user.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear completed' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' })).toHaveTextContent(
    'Correct',
  );
  expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(originalJournal);
});
