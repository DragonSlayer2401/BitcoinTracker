import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdvisorSetup from '../components/AdvisorSetup';
import AdvisorSellLimit from '../components/AdvisorSellLimit';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import {
  readAdvisorConfiguration,
  saveAdvisorConfiguration,
  readCollectorControl,
  changeCollectorControl,
} from '@/services/research/tradingAdvisor/advisorSetup.service';

jest.mock('@/services/research/tradingAdvisor/advisorSetup.service', () => ({
  readAdvisorConfiguration: jest.fn(),
  saveAdvisorConfiguration: jest.fn(),
  readCollectorControl: jest.fn(),
  changeCollectorControl: jest.fn(),
}));
const configuration = { revision: 1, policy: createTradingAdvisorPolicy() };
beforeEach(() => {
  readAdvisorConfiguration.mockResolvedValue(configuration);
  readCollectorControl.mockResolvedValue({
    status: 'stopped',
    canStart: true,
    canStop: false,
    message: 'Collection is stopped.',
  });
});

test('loads current configuration only when opened and saves a separate editable draft', async () => {
  const user = userEvent.setup();
  const onSaved = jest.fn();
  saveAdvisorConfiguration.mockResolvedValue({
    revision: 2,
    policy: createTradingAdvisorPolicy({ allocation: 50 }),
  });
  render(<AdvisorSetup onSaved={onSaved} />);
  expect(readAdvisorConfiguration).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Setup' }));
  const field = await screen.findByRole('spinbutton', { name: 'Paper allocation ($)' });
  await waitFor(() => expect(field).toBeEnabled());
  await user.clear(field);
  await user.type(field, '50');
  expect(saveAdvisorConfiguration).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Start collection' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Save allocation and risk' }));
  await waitFor(() =>
    expect(saveAdvisorConfiguration).toHaveBeenCalledWith(
      { allocation: 50, riskLevel: 'conservative', expectedRevision: 1 },
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByText(/Setup saved. Previous losses/)).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Start collection' })).toBeEnabled();
});

test('rejects an allocation above the ceiling without sending a command', async () => {
  const user = userEvent.setup();
  render(<AdvisorSetup />);
  await user.click(screen.getByRole('button', { name: 'Setup' }));
  const field = await screen.findByRole('spinbutton');
  await waitFor(() => expect(field).toBeEnabled());
  await user.clear(field);
  await user.type(field, '101');
  expect(screen.getByRole('button', { name: 'Save allocation and risk' })).toBeDisabled();
  expect(saveAdvisorConfiguration).not.toHaveBeenCalled();
});

test('an external collector cannot be started again or stopped by this UI', async () => {
  readCollectorControl.mockResolvedValue({
    status: 'external',
    canStart: false,
    canStop: false,
    message: 'Stop the original terminal collector first.',
  });
  const user = userEvent.setup();
  render(<AdvisorSetup />);
  await user.click(screen.getByRole('button', { name: 'Setup' }));
  await screen.findByText('Stop the original terminal collector first.');
  expect(screen.getByRole('button', { name: 'Start collection' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Stop collection' })).toBeDisabled();
  expect(changeCollectorControl).not.toHaveBeenCalled();
});

test('starts collection only on explicit click and surfaces command failure', async () => {
  changeCollectorControl.mockRejectedValue(new Error('Already owned by another collector.'));
  const user = userEvent.setup();
  render(<AdvisorSetup />);
  await user.click(screen.getByRole('button', { name: 'Setup' }));
  const start = await screen.findByRole('button', { name: 'Start collection' });
  await waitFor(() => expect(start).toBeEnabled());
  await user.click(start);
  expect(await screen.findByRole('alert')).toHaveTextContent('Already owned by another collector.');
  expect(changeCollectorControl).toHaveBeenCalledWith('start', expect.any(AbortSignal));
});

test('sell limit clearly distinguishes net proceeds from profit and respects plan expiry', () => {
  const advice = {
    action: 'hold',
    side: 'yes',
    quantity: 10,
    exitPlan: {
      side: 'no',
      quantity: 3,
      limitPrice: 0.72,
      expiresAt: 20000,
      netProceeds: 2.1,
      estimatedProfit: -0.2,
    },
  };
  const { rerender } = render(<AdvisorSellLimit advice={advice} now={10000} />);
  const plan = within(screen.getByRole('region', { name: 'Sell limit order' }));
  expect(plan.getByText('Sell 3 DOWN contracts at 72¢ or better.')).toBeInTheDocument();
  expect(plan.getByText(/Estimated proceeds after fees/)).toHaveTextContent(
    'Estimated net loss: $0.20',
  );
  rerender(<AdvisorSellLimit advice={advice} now={20000} />);
  expect(screen.queryByRole('region', { name: 'Sell limit order' })).not.toBeInTheDocument();
});

test('an unavailable price explains holding without inventing a sale price', () => {
  render(
    <AdvisorSellLimit
      advice={{
        action: 'hold',
        exitPlan: {
          available: false,
          expiresAt: 20000,
          explanation: 'No price below $1 beats holding.',
        },
      }}
      now={10000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'No suitable sell limit' })).toBeInTheDocument();
  expect(screen.getByText('No price below $1 beats holding.')).toBeInTheDocument();
});
