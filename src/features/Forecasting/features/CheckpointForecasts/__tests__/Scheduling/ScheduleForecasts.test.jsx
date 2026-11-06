import { screen, within } from '@testing-library/react';
import {
  currentMarket,
  eventEnd,
  nextMarket,
  renderCheckpointForecasts,
  selectEvent,
  setupCheckpointTests,
} from '../helpers/checkpointTestHarness';

setupCheckpointTests();

describe('Scheduling checkpoint forecasts', () => {
  test('selects a future event, restores its scheduled start after reload, and cancels it', async () => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);

    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveAttribute(
      'readonly',
    );
    expect(
      screen.getByText('The official target is published when this event starts.'),
    ).toBeVisible();
    expect(screen.getByText('Waiting for 15-minute window')).toBeVisible();

    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('15:00');
    expect(screen.getByRole('button', { name: 'Start scheduled' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeDisabled();

    await view.reload();
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
    await view.user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));
    expect(screen.queryByRole('heading', { name: 'Scheduled forecast' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeEnabled();

    await view.update(eventEnd, {
      markets: [{ ...nextMarket, target: 50_050, status: 'active' }],
    });
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('waits for the official target at opening, then captures checkpoints for that event', async () => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    await view.update(eventEnd, { markets: [{ ...nextMarket, status: 'active' }] });
    expect(screen.getByRole('heading', { name: 'Waiting for start data' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Start window remaining' })).toHaveTextContent(
      '14:40',
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const openedMarket = { ...nextMarket, target: 50_050, status: 'active' };
    await view.update(eventEnd + 1000, { markets: [openedMarket] });
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_050);
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Cancel scheduled start' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent('In 05:59');
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent('In 08:59');

    await view.update(nextMarket.expiresAt - 9 * 60_000, { price: 50_150 });
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent(/Yes.*Saved/);
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent('In 03:00');
    await view.update(nextMarket.expiresAt - 6 * 60_000, { price: 49_950 });
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent(/No.*Saved/);
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  test.each([
    ['a different event identity', { eventTicker: 'KXBTC15M-DIFFERENT-EVENT' }],
    [
      'a different opening window',
      { startsAt: nextMarket.startsAt + 1000, expiresAt: nextMarket.expiresAt + 1000 },
    ],
    ['unverified contract rules', { rulesVerified: false }],
  ])('retains the schedule when the feed supplies %s, then recovers', async (_, marketChanges) => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    const openedMarket = { ...nextMarket, target: 50_050, status: 'active' };

    await view.update(eventEnd + 1000, { markets: [{ ...openedMarket, ...marketChanges }] });
    expect(screen.getByRole('heading', { name: 'Waiting for start data' })).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel scheduled start' })).toBeEnabled();

    await view.update(eventEnd + 2000, { markets: [openedMarket] });
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent('In 05:58');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  test('waits through a contract feed failure and starts when the connection recovers', async () => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    const openedMarket = { ...nextMarket, target: 50_050, status: 'active' };

    await view.update(eventEnd, { markets: [openedMarket], hasContractError: true });
    expect(screen.getByRole('heading', { name: 'Waiting for start data' })).toBeVisible();
    expect(
      screen.getByText('Could not refresh Kalshi events. Retrying automatically.'),
    ).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await view.update(eventEnd + 1000, { hasContractError: false });
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  });

  test('marks an elapsed checkpoint missed after reconnecting but still captures the next one', async () => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    await view.update(eventEnd, { markets: [nextMarket], benchmark: null, ticker: null });
    expect(screen.getByRole('heading', { name: 'Waiting for start data' })).toBeVisible();

    await view.update(nextMarket.expiresAt - 9 * 60_000 + 5001, {
      markets: [{ ...nextMarket, target: 50_050, status: 'active' }],
    });
    const missedRow = screen.getByRole('row', { name: /^9 min left/ });
    expect(within(missedRow).getByRole('cell', { name: 'Missed' })).toHaveAttribute(
      'title',
      'The selected checkpoint passed before a fixed call could be captured.',
    );
    expect(within(missedRow).getByRole('cell', { name: '—' })).toBeVisible();
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent('In 02:55');

    await view.update(nextMarket.expiresAt - 6 * 60_000, { price: 50_150 });
    expect(screen.getByRole('row', { name: /^6 min left/ })).toHaveTextContent(/Yes.*Saved/);
    expect(screen.getByRole('row', { name: /^9 min left/ })).toHaveTextContent('Missed');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  test('dismisses a missed scheduled start and schedules the next available event', async () => {
    const view = await renderCheckpointForecasts();
    await selectEvent(view.user, nextMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));

    await view.update(nextMarket.expiresAt - 19_999, { markets: [nextMarket] });
    expect(screen.getByRole('heading', { name: 'Scheduled start missed' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('—');
    expect(
      screen.getByText(/Fresh data was unavailable before the final 20 seconds/),
    ).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await view.user.click(screen.getByRole('button', { name: 'Dismiss missed start' }));
    expect(
      screen.queryByRole('heading', { name: 'Scheduled start missed' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeEnabled();

    const laterMarket = {
      ...nextMarket,
      ticker: 'KXBTC15M-LATER-45',
      eventTicker: 'KXBTC15M-LATER',
      startsAt: nextMarket.expiresAt,
      expiresAt: nextMarket.expiresAt + 900_000,
    };
    await view.update(nextMarket.expiresAt - 19_999, {
      markets: [currentMarket, nextMarket, laterMarket],
    });
    await selectEvent(view.user, laterMarket);
    await view.user.click(screen.getByRole('button', { name: 'Schedule forecast' }));
    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent('00:20');
    expect(screen.getByRole('button', { name: 'Cancel scheduled start' })).toBeEnabled();
  });
});
