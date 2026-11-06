import { screen, within } from '@testing-library/react';
import {
  currentMarket,
  eventEnd,
  eventStart,
  nextMarket,
  renderCheckpointForecasts,
  setupCheckpointTests,
} from '../helpers/checkpointTestHarness';
import {
  AUTOMATIC_FORECAST_STORAGE_KEY,
  FORECAST_PREFERENCES_STORAGE_KEY,
} from '../../utils/forecastAutomation.utils';
import { JOURNAL_STORAGE_KEY } from '../../../ForecastJournal/utils/journal.utils';

setupCheckpointTests();

describe('Automatic checkpoint recording', () => {
  test('enables recording, restores the armed event without duplicates, and finishes it after Auto is turned off', async () => {
    const view = await renderCheckpointForecasts();
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));

    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeDisabled();
    expect(screen.getByRole('row', { name: /9 min left/ })).toHaveTextContent('In 06:00');
    expect(screen.getByRole('row', { name: /6 min left/ })).toHaveTextContent('In 09:00');

    await view.reload();
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeChecked();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toHaveLength(2);

    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
    expect(screen.getByRole('row', { name: /9 min left/ })).toHaveTextContent('Saved');
    await view.update(eventEnd - 6 * 60_000, { price: 49_900 });
    expect(screen.getByRole('row', { name: /6 min left/ })).toHaveTextContent('Saved');

    await view.update(eventEnd, {
      markets: [currentMarket, { ...nextMarket, target: 50_200, status: 'active' }],
    });
    expect(screen.getByRole('button', { name: 'New forecast' })).toBeEnabled();
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toHaveLength(2);
    await view.user.click(screen.getByRole('button', { name: 'New forecast' }));
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_200);
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('automatically starts the next official event while earlier calls await settlement', async () => {
    const view = await renderCheckpointForecasts();
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
    await view.update(eventEnd - 6 * 60_000, { price: 49_900 });
    await view.update(eventEnd, {
      markets: [currentMarket, { ...nextMarket, target: 50_200, status: 'active' }],
    });

    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_200);
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    expect(screen.getByRole('row', { name: /9 min left/ })).toHaveTextContent('In 06:00');
    expect(screen.getByRole('row', { name: /6 min left/ })).toHaveTextContent('In 09:00');
    const savedJournal = JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY));
    expect(savedJournal.forecasts).toHaveLength(4);
    expect(
      savedJournal.forecasts.filter((forecast) => forecast.status === 'awaiting-settlement'),
    ).toHaveLength(2);

    await view.reload();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_200);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toHaveLength(4);
  });

  test('waits for usable market data and starts automatically when the feed recovers', async () => {
    const view = await renderCheckpointForecasts({
      feedOverrides: { benchmark: { available: false }, ticker: null, candles: [] },
    });
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await view.update(eventStart + 1000);
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    expect(screen.getByRole('row', { name: /9 min left/ })).toBeInTheDocument();
  });

  test('keeps recording off when preferences cannot be saved and lets the user retry', async () => {
    const view = await renderCheckpointForecasts();
    const originalSetItem = Storage.prototype.setItem;
    const savePreference = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key, value) => {
        if (key === FORECAST_PREFERENCES_STORAGE_KEY) throw new Error('Storage is full');
        return originalSetItem.call(localStorage, key, value);
      });

    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Forecast preferences could not be saved');
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    savePreference.mockRestore();
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  });

  test('reports unreadable automatic history and resumes after history is repaired and Auto is restarted', async () => {
    localStorage.setItem(AUTOMATIC_FORECAST_STORAGE_KEY, '{broken');
    const view = await renderCheckpointForecasts();
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Automatic event history could not be read',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    localStorage.removeItem(AUTOMATIC_FORECAST_STORAGE_KEY);
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  });

  test('retains the saved event after its automatic marker fails and repairs it on reload', async () => {
    const view = await renderCheckpointForecasts();
    const originalSetItem = Storage.prototype.setItem;
    const saveMarker = jest.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key === AUTOMATIC_FORECAST_STORAGE_KEY) throw new Error('Storage is full');
      return originalSetItem.call(localStorage, key, value);
    });
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The automatic event marker could not be saved',
    );
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);

    saveMarker.mockRestore();
    await view.reload();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toHaveLength(2);
    expect(
      JSON.parse(localStorage.getItem(AUTOMATIC_FORECAST_STORAGE_KEY)).lastStartedEvent
        .marketTicker,
    ).toBe(currentMarket.ticker);
  });
});
