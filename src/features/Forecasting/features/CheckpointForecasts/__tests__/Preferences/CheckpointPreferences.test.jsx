import { act, screen, within } from '@testing-library/react';
import {
  currentMarket,
  eventEnd,
  nextMarket,
  renderCheckpointForecasts,
  selectEvent,
  setupCheckpointTests,
} from '../helpers/checkpointTestHarness';
import { FORECAST_PREFERENCES_STORAGE_KEY } from '../../utils/forecastAutomation.utils';
import { JOURNAL_STORAGE_KEY } from '../../../ForecastJournal/utils/journal.utils';

setupCheckpointTests();
describe('Checkpoint preferences', () => {
  test('chooses checkpoints with the keyboard, retains the final selection, and restores it after reload', async () => {
    const view = await renderCheckpointForecasts();
    await view.user.click(screen.getByRole('button', { name: 'Remove 6 min left' }));
    await view.user.click(screen.getByRole('button', { name: 'Remove 9 min left' }));
    expect(screen.getByRole('button', { name: 'Remove 9 min left' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove 6 min left' })).not.toBeInTheDocument();

    const checkpointControl = screen.getByRole('combobox', { name: 'Fixed checkpoints' });
    await view.user.click(checkpointControl);
    expect(checkpointControl).toHaveFocus();
    await view.user.keyboard('{Home}{Enter}');
    expect(screen.getByRole('button', { name: 'Remove 12 min left' })).toBeInTheDocument();
    await view.user.click(checkpointControl);
    expect(screen.getByRole('listbox')).toBeVisible();
    await view.user.keyboard('{Escape}');
    expect(checkpointControl).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await view.reload();
    expect(screen.getByRole('button', { name: 'Remove 12 min left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove 9 min left' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove 6 min left' })).not.toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    expect(screen.getByRole('row', { name: /12 min left/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /9 min left/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /6 min left/ })).not.toBeInTheDocument();
  });

  test('applies checkpoint edits to the next automatic event while preserving the armed calls', async () => {
    const view = await renderCheckpointForecasts();
    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    await view.user.click(screen.getByRole('button', { name: 'Remove 6 min left' }));
    await view.user.click(screen.getByRole('combobox', { name: 'Fixed checkpoints' }));
    await view.user.click(screen.getByRole('option', { name: '3 min left', exact: true }));
    await view.user.keyboard('{Escape}');
    expect(screen.getByText(/Changes apply to the next event/)).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /6 min left/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /3 min left/ })).not.toBeInTheDocument();

    await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
    await view.update(eventEnd - 6 * 60_000, { price: 49_900 });
    expect(screen.getByRole('row', { name: /6 min left/ })).toHaveTextContent('Saved');
    await view.update(eventEnd, {
      markets: [currentMarket, { ...nextMarket, target: 50_200, status: 'active' }],
    });
    expect(screen.getByRole('row', { name: /9 min left/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /3 min left/ })).toHaveTextContent('In 12:00');
    expect(screen.queryByRole('row', { name: /6 min left/ })).not.toBeInTheDocument();
  });

  test('recovers unreadable preferences with safe defaults before the user enables recording', async () => {
    localStorage.setItem(FORECAST_PREFERENCES_STORAGE_KEY, '{broken');
    const view = await renderCheckpointForecasts();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Forecast preferences could not be restored',
    );
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Remove 9 min left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove 6 min left' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  });

  test('reflects preferences from another tab and preserves its checkpoint choice when Auto is enabled', async () => {
    const view = await renderCheckpointForecasts();
    await act(async () => {
      localStorage.setItem(
        FORECAST_PREFERENCES_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          autoEnabled: false,
          checkpointMinutes: [12, 3, 1],
        }),
      );
      window.dispatchEvent(new StorageEvent('storage', { key: FORECAST_PREFERENCES_STORAGE_KEY }));
    });
    expect(screen.getByRole('button', { name: 'Remove 12 min left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove 3 min left' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove 1 min left' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove 9 min left' })).not.toBeInTheDocument();

    await view.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('row', { name: /12 min left/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /3 min left/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /1 min left/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /9 min left/ })).not.toBeInTheDocument();
  });

  test('shows a saved forecast read-only when another tab owns recording', async () => {
    const owner = await renderCheckpointForecasts();
    await owner.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    owner.unmount();
    const follower = await renderCheckpointForecasts({ lockAvailable: false });

    expect(
      screen.getByText('Another tab manages recording. Controls are read-only here.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Fixed checkpoints' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    await follower.user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
    expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeChecked();
    expect(JSON.parse(localStorage.getItem(JOURNAL_STORAGE_KEY)).forecasts).toHaveLength(2);
  });

  test('preserves the scheduled start when a read-only follower tries to cancel it', async () => {
    const owner = await renderCheckpointForecasts();
    await selectEvent(owner.user, nextMarket);
    await owner.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    const savedSchedule = localStorage.getItem(JOURNAL_STORAGE_KEY);
    owner.unmount();

    const follower = await renderCheckpointForecasts({ lockAvailable: false });
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel scheduled start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start scheduled' })).toBeDisabled();
    await follower.user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('15:00');
    expect(localStorage.getItem(JOURNAL_STORAGE_KEY)).toBe(savedSchedule);
  });
});
