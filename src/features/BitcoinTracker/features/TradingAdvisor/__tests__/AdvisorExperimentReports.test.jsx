import { fireEvent, render, screen, within } from '@testing-library/react';
import AdvisorHistoryTrials from '../components/AdvisorHistoryTrials';
import AdvisorStrategyTrials from '../components/AdvisorStrategyTrials';
import { START } from './TradingAdvisor.fixtures';

test('history experiments disclose separate funding and retain prior losses under their own version', () => {
  const previous = {
    id: 'history-original',
    registeredAt: START,
    initialBankroll: 100,
    provider: { status: 'configured', model: 'test-model' },
    strategies: [{ id: 'incumbent', label: 'Numerical trial', cash: 96.58, netProfit: -3.42 }],
  };
  render(
    <AdvisorHistoryTrials
      trials={{
        ...previous,
        id: 'history-one-contract',
        registeredAt: START + 1000,
        maxEntryContracts: 1,
        strategies: [{ id: 'incumbent', label: 'Numerical trial', cash: 100, netProfit: 0 }],
        previousExperiments: [previous],
      }}
    />,
  );
  const current = within(screen.getAllByRole('region')[0]);
  expect(current.getByText(/Entry limit: 1 contract\./)).toBeVisible();
  expect(current.getByText(/separate paper funding/)).toBeVisible();
  expect(current.getByText('$0.00')).toBeVisible();
  expect(current.queryByText('-$3.42')).not.toBeInTheDocument();
  const summary = screen.getByText(/Previous history experiment/);
  fireEvent.click(summary);
  const archived = within(summary.closest('details'));
  expect(archived.getByText(/Experiment history-original/)).toBeVisible();
  expect(archived.getByText('-$3.42')).toBeVisible();
});

test('strategy experiment accounts and earlier losses remain individually identifiable', () => {
  const previous = {
    policyId: 'policy-original',
    registeredAt: START,
    initialBankroll: 100,
    strategies: [
      { id: 'standard', cash: 91, realizedPnl: -9, openPositionCount: 0, pendingOrderCount: 0 },
    ],
  };
  render(
    <AdvisorStrategyTrials
      trials={{
        ...previous,
        policyId: 'policy-one-contract',
        registeredAt: START + 1000,
        maxEntryContracts: 1,
        strategies: [
          { id: 'standard', cash: 100, realizedPnl: 0, openPositionCount: 0, pendingOrderCount: 0 },
        ],
        previousExperiments: [previous],
      }}
    />,
  );
  const current = within(screen.getAllByRole('region')[0]);
  expect(current.getByText(/Entry limit: 1 contract\./)).toBeVisible();
  expect(current.getByText('$100.00')).toBeVisible();
  expect(current.queryByText('-$9.00')).not.toBeInTheDocument();
  const summary = screen.getByText(/Previous strategy experiment/);
  fireEvent.click(summary);
  const archived = within(summary.closest('details'));
  expect(archived.getByText(/Experiment policy-original/)).toBeVisible();
  expect(archived.getByText('-$9.00')).toBeVisible();
});
