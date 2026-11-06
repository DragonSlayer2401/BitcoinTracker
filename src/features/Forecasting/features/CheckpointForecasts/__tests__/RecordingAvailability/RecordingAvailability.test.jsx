import { screen } from '@testing-library/react';
import { JOURNAL_STORAGE_KEY } from '../../../ForecastJournal/utils/journal.utils';
import {
  currentMarket,
  eventEnd,
  eventStart,
  nextMarket,
  renderCheckpointForecasts,
  selectEvent,
  setupCheckpointTests,
} from '../helpers/checkpointTestHarness';

setupCheckpointTests();

describe('Recording availability and saved forecast recovery', () => {
  test.each([
    ['the official target has not arrived', { target: null }, {}],
    ['the contract rules are unverified', { rulesVerified: false }, {}],
    ['the contract connection has failed', {}, { hasContractError: true }],
  ])(
    'waits when %s, then allows the user to start after recovery',
    async (_, marketChanges, feedOverrides) => {
      const view = await renderCheckpointForecasts({
        markets: [{ ...currentMarket, ...marketChanges }, nextMarket],
        feedOverrides,
      });

      const startButton = screen.getByRole('button', { name: 'Start forecast' });
      expect(startButton).toBeDisabled();
      await view.user.click(startButton);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveAttribute(
        'readonly',
      );
      if (marketChanges.target === null) {
        expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
        expect(
          screen.getByText('The official target is published when this event starts.'),
        ).toBeVisible();
      }
      if (feedOverrides.hasContractError) {
        expect(
          screen.getByText('Could not refresh Kalshi events. Retrying automatically.'),
        ).toBeVisible();
      }

      await view.update(eventStart + 1000, { markets: [currentMarket, nextMarket] });
      expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
      expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_000);
      expect(screen.getByRole('link', { name: /View contract and rules/ })).toHaveAttribute(
        'href',
        currentMarket.url,
      );

      await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
      expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
      expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent('In 05:59');
      expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent('In 08:59');
    },
  );

  test('keeps starting disabled during a price outage and records after live inputs recover', async () => {
    const view = await renderCheckpointForecasts({
      feedOverrides: { benchmark: null, ticker: null, hasRequestError: true },
    });

    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await view.update(eventStart + 2000);
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();

    await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent(/Yes.*Saved/);
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent('In 03:00');
  });

  test('records and captures using independent BRTI prices during a Coinbase outage', async () => {
    const view = await renderCheckpointForecasts({
      feedOverrides: { ticker: null, hasRequestError: true },
    });

    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();

    await view.update(eventEnd - 9 * 60_000, {
      price: 50_100,
      ticker: null,
      hasRequestError: true,
    });
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent(/Yes.*Saved/);

    await view.update(eventEnd - 6 * 60_000, {
      price: 49_900,
      ticker: null,
      hasRequestError: true,
    });
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent(/Yes.*Saved/);
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent(/No.*Saved/);
    expect(screen.getByRole('button', { name: 'Forecast in progress' })).toBeDisabled();
  });

  test('pauses a failed first journal save and lets the user retry after reloading', async () => {
    const view = await renderCheckpointForecasts();
    const writeStorage = Storage.prototype.setItem;
    const storageFailure = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (key === JOURNAL_STORAGE_KEY) throw new Error('Storage is full.');
        return writeStorage.call(localStorage, key, value);
      });

    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Forecast history could not be saved on this device. Recording paused; reload to retry.',
    );
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Fixed checkpoints' })).toBeDisabled();

    storageFailure.mockRestore();
    await view.reload();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();

    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    await view.reload();
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  test('restores the durable scheduled event when cancelling could not be saved', async () => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();

    const writeStorage = Storage.prototype.setItem;
    const storageFailure = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (key === JOURNAL_STORAGE_KEY) throw new Error('Storage is full.');
        return writeStorage.call(localStorage, key, value);
      });
    await view.user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved.*Recording paused/);
    expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeDisabled();

    storageFailure.mockRestore();
    await view.reload();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('15:00');
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);

    await view.user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));
    await view.reload();
    expect(screen.queryByRole('heading', { name: 'Scheduled forecast' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
  });
});
