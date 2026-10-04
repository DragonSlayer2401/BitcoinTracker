import { fireEvent, render, screen, within } from '@testing-library/react';
import AdvisorAction from '../components/AdvisorAction';
import AdvisorHistoryTrials from '../components/AdvisorHistoryTrials';
import { createAdvisorPlan } from '../utils/advisorPlan.utils';

const NOW = Date.UTC(2026, 9, 3, 12, 5);
const market = {
  ticker: 'BTC-ONE',
  target: 80000,
  startsAt: NOW - 300000,
  expiresAt: NOW + 600000,
};
const hold = {
  id: 'hold-one',
  contract: market,
  action: 'hold',
  side: 'yes',
  quantity: 5,
  reason: 'hold_value_exceeds_sale',
  evaluatedAt: NOW,
  validUntil: NOW + 15000,
};
const report = {
  startedAt: NOW - 60000,
  policy: {},
  collector: { status: 'running', heartbeatAt: NOW },
  latestAdvice: hold,
  currentPlan: createAdvisorPlan(hold),
  portfolio: { positions: [], pendingIntents: [] },
};

test('shows a valid HOLD alongside a separate cooldown blocker and review details', () => {
  render(
    <AdvisorAction
      report={{
        ...report,
        latestAdvice: { ...hold, id: 'waiting', action: 'wait', reason: 'reentry_cooldown' },
      }}
      market={market}
      now={NOW + 1000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
  expect(screen.getByText('Cooldown')).toBeVisible();
  expect(screen.getByText(/Waiting after the last sale/)).toBeVisible();
  expect(screen.getByText(/Last assessment/)).toBeVisible();
  expect(screen.getByText(/Next review/)).toBeVisible();
  fireEvent.click(screen.getByText('Plan conditions and invalidation'));
  expect(screen.getByText(/Keep holding while the updated evidence/)).toBeVisible();
  expect(
    screen.getByText(/probability, executable price, fees or available position changes/),
  ).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'WAIT' })).not.toBeInTheDocument();
});

test('expired plans are labeled historical and no longer expose active trade quantities', () => {
  render(<AdvisorAction report={report} market={market} now={NOW + 15000} />);
  expect(screen.getByRole('heading', { name: 'Assessment unavailable' })).toBeVisible();
  expect(screen.getByText('Stale assessment')).toBeVisible();
  expect(screen.getByText(/Previous plan \(historical\)/)).toHaveTextContent('HOLD UP');
  expect(screen.queryByText('Position size')).not.toBeInTheDocument();
});

test('a conditional buy exposes its actual price condition without implying the quote is ready', () => {
  const buy = {
    ...hold,
    id: 'buy-one',
    action: 'buy',
    reason: 'fee_adjusted_entry_edge',
    limitPrice: 0.57,
  };
  render(
    <AdvisorAction
      report={{
        ...report,
        currentPlan: createAdvisorPlan(buy),
        latestAdvice: {
          ...buy,
          id: 'quote-wait',
          action: 'wait',
          reason: 'book_unavailable_or_stale',
        },
      }}
      market={market}
      now={NOW + 1000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'BUY UP IF…' })).toBeVisible();
  expect(screen.getByText('Awaiting fresh quote')).toBeVisible();
  fireEvent.click(screen.getByText('Plan conditions and invalidation'));
  expect(screen.getByText(/Buy UP only at \$0.57 or less/)).toBeVisible();
});

test('shadow results remain distinct from the incumbent and disabled AI is not scored as success', () => {
  render(
    <AdvisorHistoryTrials
      trials={{
        status: 'collecting',
        contractCount: 3,
        settledCount: 1,
        requiredContracts: 120,
        provider: { status: 'disabled' },
        strategies: [
          {
            id: 'incumbent',
            label: 'Incumbent',
            netProfit: 1.2,
            drawdown: 0.3,
            fillCount: 2,
            failureCount: 0,
          },
          {
            id: 'history-rules',
            label: 'History rules',
            netProfit: 0.4,
            drawdown: 0.2,
            fillCount: 1,
            failureCount: 0,
          },
          {
            id: 'language-model',
            label: 'AI policy',
            netProfit: 0,
            drawdown: 0,
            fillCount: 0,
            failureCount: 0,
          },
        ],
      }}
    />,
  );
  expect(screen.getByText('Simulated trading experiments.')).toBeVisible();
  expect(
    screen.getByText(/Each policy buys, holds and sells in its own paper account/),
  ).toBeVisible();
  expect(screen.getByText(/AI candidate is disabled/)).toBeVisible();
  const aiRow = within(screen.getByRole('rowheader', { name: /^AI policy/ }).closest('tr'));
  expect(aiRow.getByText('Not evaluated')).toBeVisible();
  expect(aiRow.queryByText('$0.00')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /promote|activate/i })).not.toBeInTheDocument();
});

test('experimental proposals show vetoes and recorded rationale without becoming current instructions', () => {
  render(
    <AdvisorHistoryTrials
      trials={{
        provider: { status: 'configured', model: 'test-model' },
        strategies: [
          {
            id: 'language-model',
            label: 'AI policy',
            latestDecision: {
              status: 'vetoed',
              action: 'BUY_NO',
              assessedAt: NOW,
              rationale: 'Selling pressure increased.',
              thesis: 'Evaluate a move below the target.',
              invalidationConditions: ['Buying pressure recovers'],
              reviewAt: NOW + 10000,
            },
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText('AI policy: evidence and last experimental plan'));
  expect(screen.getByText('Last recorded experiment: BUY DOWN')).toBeVisible();
  expect(screen.getAllByText(/Blocked by validation or risk checks/)).toHaveLength(2);
  expect(screen.getByText('Selling pressure increased.')).toBeVisible();
  expect(
    screen.getByText(/Historical experimental output, not a current trade instruction/),
  ).toBeVisible();
});

test.each([
  ['pending', 'Awaiting AI response'],
  ['proposed', 'Proposal recorded; awaiting current market checks'],
  ['fallback', 'Fallback: current rules used'],
])(
  'shows the %s state and independent account balances without opening details',
  (status, label) => {
    render(
      <AdvisorHistoryTrials
        trials={{
          provider: { status: 'configured', model: 'test-model' },
          strategies: [
            {
              id: 'language-model',
              label: 'AI paper account',
              cash: 92.5,
              openPositionCount: 1,
              pendingOrderCount: 2,
              latestDecision: { status, assessedAt: NOW },
            },
          ],
        }}
      />,
    );
    const row = within(screen.getByRole('rowheader', { name: /^AI paper account/ }));
    expect(row.getByText(label)).toBeVisible();
    expect(row.getByText('$92.50 cash · 1 open · 2 pending')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Realized net P&L' })).toBeVisible();
  },
);

test('recording and cost problems visibly label the experiment as incomplete', () => {
  render(
    <AdvisorHistoryTrials
      trials={{
        provider: { status: 'configured' },
        recordingError: 'shadow_recording_unavailable',
        costDiscrepancy: true,
        strategies: [],
      }}
    />,
  );
  const warning = within(screen.getByRole('alert'));
  expect(warning.getByText(/This comparison is incomplete/)).toBeVisible();
  expect(warning.getByText(/Results need cost reconciliation before review/)).toBeVisible();
});

test('a historical recording gap remains visible after a successful later observation', () => {
  render(
    <AdvisorHistoryTrials
      trials={{
        provider: { status: 'configured' },
        recordingError: null,
        recordingGaps: 1,
        strategies: [],
      }}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('This comparison is incomplete');
});
