import { screen, waitFor, within } from '@testing-library/react';
import { JOURNAL_STORAGE_KEY } from '../../utils/journal.utils';
import { renderForecastJournal, setupJournalTests } from '../helpers/journalTestHarness';
import { createSavedForecast, createSavedSchedule, journalNow } from '../helpers/journalFixtures';

setupJournalTests();

describe('Clearing completed forecast history', () => {
  test.each(['Keep journal', 'Close', 'Escape'])(
    'preserves the journal when the user dismisses confirmation with %s',
    async (dismissAction) => {
      const view = await renderForecastJournal({
        forecasts: [createSavedForecast({ id: 'completed', target: 50_100 })],
      });
      const savedJournal = localStorage.getItem(JOURNAL_STORAGE_KEY);
      await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
      const dialog = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
      expect(dialog).toBeVisible();
      expect(dialog).toHaveTextContent(
        'This removes completed and no-call entries from this browser.',
      );
      expect(dialog).toHaveTextContent(
        'Active observation, pending forecasts, and forecasts awaiting official settlement stay in place.',
      );

      if (dismissAction === 'Escape') await view.user.keyboard('{Escape}');
      else
        await view.user.click(
          within(dialog).getByRole('button', { name: dismissAction, exact: true }),
        );
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: 'Clear completed forecasts?' }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'Clear completed' })).toHaveFocus();
      expect(
        screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
      ).toHaveTextContent('$50,100.00');
      expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(savedJournal);

      await view.reload();
      await view.user.click(screen.getByRole('button', { name: 'View history' }));
      const history = await screen.findByRole('dialog', { name: 'Forecast history' });
      expect(within(history).getByRole('table')).toHaveTextContent('$50,100.00');
      expect(within(history).getAllByRole('row')).toHaveLength(2);
    },
  );

  test('clears completed and no-call entries while retaining observing, pending, and unsettled forecasts after reload', async () => {
    const view = await renderForecastJournal({
      now: journalNow + 7 * 60_000,
      forecasts: [
        createSavedForecast({
          id: 'observing',
          status: 'analyzing',
          startsAt: journalNow,
          checkpointMinutes: 6,
        }),
        createSavedForecast({
          id: 'pending',
          status: 'pending',
          startsAt: journalNow,
          checkpointMinutes: 9,
        }),
        createSavedForecast({
          id: 'awaiting',
          status: 'awaiting-settlement',
          startsAt: journalNow - 1800_000,
          target: 49_900,
        }),
        createSavedForecast({ id: 'resolved', target: 50_100 }),
        createSavedForecast({
          id: 'withheld',
          status: 'withheld',
          startsAt: journalNow - 2700_000,
          target: 50_200,
        }),
        createSavedForecast({
          id: 'unobserved',
          status: 'unobserved',
          startsAt: journalNow - 3600_000,
          target: 50_300,
        }),
      ],
    });
    await view.user.click(screen.getByRole('button', { name: 'View history' }));
    let history = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(within(history).getAllByRole('row')).toHaveLength(7);
    expect(within(history).getByRole('table')).toHaveTextContent('No call · unscored');
    expect(within(history).getByRole('table')).toHaveTextContent('Unobserved');
    await view.user.click(within(history).getByRole('button', { name: 'Close history' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
    await view.user.click(within(confirmation).getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'View history' }));
    history = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(within(history).getAllByRole('row')).toHaveLength(4);
    expect(within(history).getByRole('row', { name: /6 min left/ })).toHaveTextContent('Observing');
    expect(within(history).getByRole('row', { name: /\$50,000.00.*9 min left/ })).toHaveTextContent(
      '08:00',
    );
    expect(within(history).getByRole('row', { name: /\$49,900.00/ })).toHaveTextContent(
      'Awaiting Kalshi',
    );
    expect(
      within(history).queryByRole('row', { name: /\$50,100.00|\$50,200.00|\$50,300.00/ }),
    ).not.toBeInTheDocument();

    await view.reload();
    await view.user.click(screen.getByRole('button', { name: 'View history' }));
    history = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(within(history).getAllByRole('row')).toHaveLength(4);
    expect(within(history).getByRole('row', { name: /6 min left/ })).toHaveTextContent('Observing');
    expect(within(history).getByRole('row', { name: /\$50,000.00.*9 min left/ })).toHaveTextContent(
      '08:00',
    );
    expect(within(history).getByRole('row', { name: /\$49,900.00/ })).toHaveTextContent(
      'Awaiting Kalshi',
    );
  });

  test('keeps an armed future schedule and outstanding settlement when completed history is cleared', async () => {
    const scheduledForecast = createSavedSchedule();
    const view = await renderForecastJournal({
      scheduledForecast,
      forecasts: [
        createSavedForecast({ id: 'completed', target: 50_100 }),
        createSavedForecast({
          id: 'awaiting',
          status: 'awaiting-settlement',
          startsAt: journalNow - 1800_000,
          target: 49_900,
        }),
      ],
    });
    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
    await view.user.click(within(confirmation).getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Awaiting Kalshi');
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).scheduledForecast).toEqual(
      scheduledForecast,
    );

    await view.reload();
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Awaiting Kalshi');
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).scheduledForecast).toEqual(
      scheduledForecast,
    );
  });

  test('returns focus to history and restores the empty journal after clearing its final entry', async () => {
    const view = await renderForecastJournal({
      forecasts: [createSavedForecast({ id: 'final-entry' })],
    });
    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
    await view.user.click(within(confirmation).getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'View history' })).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();

    await view.user.keyboard('{Enter}');
    const history = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(within(history).getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
    expect(within(history).queryByRole('table')).not.toBeInTheDocument();
    await view.reload();
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
  });

  test('preserves completed records when a tab without recording ownership confirms clearing', async () => {
    const view = await renderForecastJournal({
      lock: 'follower',
      forecasts: [createSavedForecast({ id: 'owned-by-another-tab', target: 50_100 })],
    });
    const savedJournal = localStorage.getItem(JOURNAL_STORAGE_KEY);
    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    const confirmation = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
    await view.user.click(within(confirmation).getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('$50,100.00');
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(savedJournal);
    await view.user.click(screen.getByRole('button', { name: 'View history' }));
    const history = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(within(history).getAllByRole('row')).toHaveLength(2);
    expect(within(history).getByRole('table')).toHaveTextContent('$50,100.00');
  });

  test('offers no clear action when every saved forecast is still active or awaiting settlement', async () => {
    const view = await renderForecastJournal({
      now: journalNow + 7 * 60_000,
      forecasts: [
        createSavedForecast({
          id: 'observing',
          status: 'analyzing',
          startsAt: journalNow,
          checkpointMinutes: 6,
        }),
        createSavedForecast({
          id: 'pending',
          status: 'pending',
          startsAt: journalNow,
          checkpointMinutes: 9,
        }),
        createSavedForecast({
          id: 'awaiting',
          status: 'awaiting-settlement',
          startsAt: journalNow - 1800_000,
        }),
      ],
    });
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'View history' }));
    const history = await screen.findByRole('dialog', { name: 'Forecast history' });
    expect(within(history).getAllByRole('row')).toHaveLength(4);
    expect(
      within(history).queryByRole('button', { name: 'Clear completed' }),
    ).not.toBeInTheDocument();
  });
});
