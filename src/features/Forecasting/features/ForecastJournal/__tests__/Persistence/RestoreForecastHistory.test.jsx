import { screen, waitFor, within } from '@testing-library/react';
import { JOURNAL_STORAGE_KEY } from '../../utils/journal.utils';
import { createSavedForecast } from '../helpers/journalFixtures';
import {
  renderForecastJournal,
  saveBrowserJournal,
  setupJournalTests,
} from '../helpers/journalTestHarness';
import { readBrowserEvidence, seedBrowserEvidence } from './helpers/browserEvidence';

setupJournalTests();

describe('Restoring and protecting browser forecast history', () => {
  test.each([
    [
      'unreadable JSON',
      () => '{broken',
      'Saved journal could not be read. Cleanup paused without replacing it.',
    ],
    [
      'an unknown version',
      () => JSON.stringify({ version: 99, forecasts: [], scheduledForecast: null }),
      'Saved journal has an unknown format. Cleanup paused without replacing it.',
    ],
    [
      'an invalid saved prediction',
      () =>
        JSON.stringify({
          version: 7,
          forecasts: [{ ...createSavedForecast(), aboveProbability: 2 }],
          scheduledForecast: null,
        }),
      'Saved Kalshi records could not be validated. Cleanup preserved them.',
    ],
  ])(
    'preserves %s and restores history after the saved data is repaired',
    async (_, serializeJournal, warning) => {
      const originalJournal = serializeJournal();
      const view = await renderForecastJournal({ serializedJournal: originalJournal });
      expect(await screen.findByRole('alert')).toHaveTextContent(warning);
      expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(originalJournal);
      await view.user.click(screen.getByRole('button', { name: 'View history' }));
      const dialog = screen.getByRole('dialog', { name: 'Forecast history' });
      expect(within(dialog).getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
      expect(within(dialog).queryByRole('table')).not.toBeInTheDocument();

      saveBrowserJournal({ forecasts: [createSavedForecast({ id: 'recovered-call' })] });
      await view.reload();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(
        screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
      ).toHaveTextContent('Correct');
      await view.user.click(screen.getByRole('button', { name: 'View history' }));
      expect(within(screen.getByRole('dialog')).getByRole('table')).toHaveTextContent(
        '80.0% / 20.0%',
      );
    },
  );

  test('keeps durable records intact when the browser denies reading storage and recovers on reload', async () => {
    saveBrowserJournal({ forecasts: [createSavedForecast({ id: 'saved-before-denial' })] });
    const originalJournal = localStorage.getItem(JOURNAL_STORAGE_KEY);
    const readStorage = Storage.prototype.getItem;
    const deniedRead = jest.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === JOURNAL_STORAGE_KEY) throw new Error('Browser storage access denied.');
      return readStorage.call(localStorage, key);
    });
    const view = await renderForecastJournal();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Browser storage access denied. Recording paused; reload to retry.',
    );
    expect(readStorage.call(localStorage, JOURNAL_STORAGE_KEY)).toBe(originalJournal);
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
    deniedRead.mockRestore();
    await view.reload();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Correct');
  });

  test('restores the durable history after clearing could not be saved, then allows a successful retry', async () => {
    const view = await renderForecastJournal({ forecasts: [createSavedForecast()] });
    const originalJournal = localStorage.getItem(JOURNAL_STORAGE_KEY);
    const writeStorage = Storage.prototype.setItem;
    const deniedWrite = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (key === JOURNAL_STORAGE_KEY) throw new Error('Storage is full.');
        return writeStorage.call(localStorage, key, value);
      });
    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    await view.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear completed' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Forecast history could not be saved on this device. Recording paused; reload to retry.',
    );
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(originalJournal);
    deniedWrite.mockRestore();
    await view.reload();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Correct');

    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    await view.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear completed' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await view.reload();
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toEqual([]);
  });

  test('preserves readable history when local research cleanup fails and retries on reload', async () => {
    const savedForecast = createSavedForecast();
    saveBrowserJournal({ forecasts: [savedForecast] });
    const originalJournal = localStorage.getItem(JOURNAL_STORAGE_KEY);
    const unavailableDatabase = jest.spyOn(indexedDB, 'open').mockImplementation(() => {
      throw new Error('Local research storage is unavailable.');
    });
    const view = await renderForecastJournal();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local research storage is unavailable. Recording paused; reload to retry.',
    );
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Correct');
    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    await view.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear completed' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Correct');
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(originalJournal);
    unavailableDatabase.mockRestore();
    await view.reload();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Clear completed' }));
    await view.user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear completed' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeVisible();
  });

  test('opens legacy browser history while retaining Kalshi calls and their research evidence', async () => {
    const retainedForecast = createSavedForecast({ id: 'retained-kalshi-call' });
    const retainedEvidence = {
      eventId: 'kalshi-evidence',
      outcomeDefinition: retainedForecast.outcomeDefinition,
    };
    const legacyEvidence = {
      eventId: 'legacy-evidence',
      outcomeDefinition: 'old-coinbase-outcome',
    };
    await seedBrowserEvidence([retainedEvidence, legacyEvidence]);
    localStorage.setItem('bitcoin-tracker:background-research:legacy', 'old recorder');
    localStorage.setItem('bitcoin-tracker:background-research:kalshi:current', 'current recorder');
    const view = await renderForecastJournal({
      serializedJournal: JSON.stringify({
        version: 7,
        forecasts: [
          retainedForecast,
          { id: 'legacy-call', outcomeDefinition: 'old-coinbase-outcome' },
        ],
        scheduledForecast: null,
      }),
    });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await view.user.click(screen.getByRole('button', { name: 'View history' }));
    const history = within(screen.getByRole('dialog', { name: 'Forecast history' }));
    expect(history.getAllByRole('row')).toHaveLength(2);
    expect(history.getByRole('table')).toHaveTextContent('Correct');
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toEqual([
      retainedForecast,
    ]);
    expect(await readBrowserEvidence('events')).toEqual([retainedEvidence]);
    expect(await readBrowserEvidence('forecast-outbox')).toEqual([
      { key: retainedEvidence.eventId, forecast: retainedEvidence },
    ]);
    expect(localStorage.getItem('bitcoin-tracker:background-research:legacy')).toBeNull();
    expect(localStorage.getItem('bitcoin-tracker:background-research:kalshi:current')).toBe(
      'current recorder',
    );
    await view.reload();
    expect(
      screen.getByRole('table', { name: 'Latest recorded Bitcoin forecast' }),
    ).toHaveTextContent('Correct');
  });
});
