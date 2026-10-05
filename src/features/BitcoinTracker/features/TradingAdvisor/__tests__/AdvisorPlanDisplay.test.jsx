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
const standingHold = {
  ...hold,
  positionId: 'position-one',
  exitPlan: {
    side: 'yes',
    quantity: 5,
    limitPrice: 0.7,
    expiresAt: NOW + 15000,
    netProceeds: 3.4,
    estimatedProfit: 0.4,
  },
};
const standingReport = {
  ...report,
  latestAdvice: standingHold,
  currentPlan: createAdvisorPlan(standingHold),
  portfolio: {
    positions: [{ id: 'position-one', side: 'yes', quantity: 5, availableQuantity: 5 }],
    pendingIntents: [],
  },
};

test('holding shows an advance sell limit and model-managed loss exit beyond the quote lifetime', () => {
  render(<AdvisorAction report={standingReport} market={market} now={NOW + 20000} />);
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Set a sell limit at 70¢' })).toBeVisible();
  expect(screen.getByText('Sell 5 UP contracts at 70¢ or better.')).toBeVisible();
  expect(screen.getByText(/No order has been placed/)).toBeVisible();
  expect(screen.getByText('Loss exit: model-managed.')).toBeVisible();
  expect(screen.getByText(/No fixed stop order has been placed/)).toBeVisible();
  expect(screen.queryByText(/Recheck by/)).not.toBeInTheDocument();
  expect(screen.queryByText('Position size')).not.toBeInTheDocument();
});

test('an operational wait retains the exact recorded sell target until a new plan replaces it', () => {
  const { rerender } = render(
    <AdvisorAction
      report={{
        ...standingReport,
        latestAdvice: { ...hold, action: 'wait', reason: 'book_unavailable_or_stale' },
      }}
      market={market}
      now={NOW + 20000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Set a sell limit at 70¢' })).toBeVisible();
  const updatedHold = {
    ...standingHold,
    id: 'hold-two',
    evaluatedAt: NOW + 21000,
    validUntil: NOW + 36000,
    exitPlan: { ...standingHold.exitPlan, limitPrice: 0.74, expiresAt: NOW + 36000 },
  };
  rerender(
    <AdvisorAction
      report={{
        ...standingReport,
        latestAdvice: updatedHold,
        currentPlan: createAdvisorPlan(updatedHold),
      }}
      market={market}
      now={NOW + 22000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Set a sell limit at 74¢' })).toBeVisible();
  expect(screen.queryByText(/70¢/)).not.toBeInTheDocument();
});

test.each([
  { market: { ...market, ticker: 'BTC-NEXT' } },
  { now: market.expiresAt },
  { report: { ...standingReport, portfolio: { positions: [], pendingIntents: [] } } },
  {
    report: {
      ...standingReport,
      latestAdvice: { ...standingHold, executionStatus: 'filled' },
    },
  },
])('removes a standing sell target when its plan ends or the position changes: %j', (changes) => {
  render(<AdvisorAction report={standingReport} market={market} now={NOW + 20000} {...changes} />);
  expect(screen.queryByRole('region', { name: 'Sell limit order' })).not.toBeInTheDocument();
  expect(screen.queryByText('Loss exit: model-managed.')).not.toBeInTheDocument();
});

test('reserved contracts keep the HOLD plan but do not recommend a duplicate sell order', () => {
  render(
    <AdvisorAction
      report={{
        ...standingReport,
        portfolio: {
          ...standingReport.portfolio,
          positions: [{ id: 'position-one', side: 'yes', quantity: 5, availableQuantity: 2 }],
        },
      }}
      market={market}
      now={NOW + 20000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Sell order already pending' })).toBeVisible();
  expect(screen.queryByText(/Sell 5 UP contracts/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Set a sell limit/)).not.toBeInTheDocument();
});

test('an immediate sale loses its order quote when it expires, even while the exit plan remains', () => {
  const sell = {
    ...standingHold,
    action: 'sell',
    reason: 'sale_better_than_hold_value',
    limitPrice: 0.63,
    quantity: 2,
  };
  const saleReport = {
    ...standingReport,
    latestAdvice: sell,
    currentPlan: createAdvisorPlan(sell),
  };
  const { rerender } = render(
    <AdvisorAction report={saleReport} market={market} now={NOW + 1000} />,
  );
  expect(screen.getByRole('heading', { name: 'Set a sell limit at 63¢' })).toBeVisible();
  expect(screen.queryByText(/Sell 5 UP contracts/)).not.toBeInTheDocument();
  rerender(<AdvisorAction report={saleReport} market={market} now={NOW + 20000} />);
  expect(screen.getByRole('heading', { name: 'EXIT UP' })).toBeVisible();
  expect(screen.queryByRole('region', { name: 'Sell limit order' })).not.toBeInTheDocument();
});

test('saved AI commentary stays hidden while the active hold and application conditions remain', () => {
  render(
    <AdvisorAction
      report={{
        ...standingReport,
        currentPlan: {
          ...standingReport.currentPlan,
          invalidationConditions: ['Selling pressure persists and the expected payout falls.'],
        },
        source: {
          kind: 'ai',
          pending: true,
          decision: {
            rationale: 'Old AI holding rationale.',
            thesis: 'Old AI trade thesis.',
            invalidationConditions: ['Selling pressure persists and the expected payout falls.'],
          },
          latestDecision: { invalidationConditions: ['Unaccepted stop at 20 cents.'] },
        },
      }}
      market={market}
      now={NOW + 20000}
    />,
  );
  fireEvent.click(screen.getByText('Plan conditions'));
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Set a sell limit at 70¢' })).toBeVisible();
  expect(screen.getByText('What can change the plan:')).toBeVisible();
  expect(
    screen.getByText(/probability, executable price, fees or available position changes/),
  ).toBeVisible();
  expect(
    screen.queryByText('Selling pressure persists and the expected payout falls.'),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Old AI holding rationale.')).not.toBeInTheDocument();
  expect(screen.queryByText('Old AI trade thesis.')).not.toBeInTheDocument();
  expect(screen.queryByText(/Unaccepted stop/)).not.toBeInTheDocument();
});

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
  fireEvent.click(screen.getByText('Order details'));
  expect(screen.getByText('Cooldown')).toBeVisible();
  expect(screen.getByText(/Waiting after the last sale/)).toBeVisible();
  expect(screen.getByText(/Last reviewed/)).toBeVisible();
  expect(screen.queryByText(/Next review/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Plan conditions'));
  expect(screen.getByText(/Keep holding while the updated evidence/)).toBeVisible();
  expect(
    screen.getByText(/probability, executable price, fees or available position changes/),
  ).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'WAIT' })).not.toBeInTheDocument();
});

test('a quote expiring keeps HOLD as the current plan without repeating old prices or quantities', () => {
  render(<AdvisorAction report={report} market={market} now={NOW + 15000} />);
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
  expect(screen.getByText('Current plan')).toBeVisible();
  expect(screen.getByText(/Plan unchanged/)).toBeVisible();
  expect(
    screen.queryByText(/Stale assessment|not a current instruction|evidence.*expired/),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Position size')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Plan conditions'));
  expect(screen.getByText(/Keep holding while the updated evidence/)).toBeVisible();
});

test.each([{ isError: true }, { isLoading: true }])(
  'keeps the current plan through interrupted or pending updates',
  (changes) => {
    render(<AdvisorAction report={report} market={market} now={NOW + 1000} {...changes} />);
    expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
    expect(screen.getByText('Current plan')).toBeVisible();
    expect(
      screen.queryByText(/Stale assessment|not a current instruction/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Position size')).not.toBeInTheDocument();
    expect(screen.getByText('Plan conditions')).toBeVisible();
  },
);

test('a plan for a different event is kept in history without directing a trade in the new event', () => {
  render(
    <AdvisorAction report={report} market={{ ...market, ticker: 'BTC-NEXT' }} now={NOW + 1000} />,
  );
  expect(screen.queryByRole('heading', { name: 'HOLD UP' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'REVIEWING NEW EVENT' })).toBeVisible();
  expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
  expect(screen.getByText(/Recorded for BTC-ONE/)).toBeVisible();
  expect(screen.queryByText('Position size')).not.toBeInTheDocument();
});

test('an event closing completes the plan without continuing to direct a position', () => {
  render(<AdvisorAction report={report} market={market} now={market.expiresAt} />);
  expect(screen.getByRole('heading', { name: 'EVENT ENDED' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'HOLD UP' })).not.toBeInTheDocument();
  expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
  expect(screen.queryByText('Position size')).not.toBeInTheDocument();
  expect(screen.getByText(/Recorded for BTC-ONE/)).toBeVisible();
});

test('a buy plan stays consistent while its order waits for current prices', () => {
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
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeVisible();
  fireEvent.click(screen.getByText('Order details'));
  expect(screen.getByText('Awaiting fresh quote')).toBeVisible();
  fireEvent.click(screen.getByText('Plan conditions'));
  expect(screen.getByText(/Buy UP only at \$0.57 or less/)).toBeVisible();
});

test('a later completed assessment replaces a persistent plan and its reasoning', () => {
  const { rerender } = render(<AdvisorAction report={report} market={market} now={NOW + 20000} />);
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeVisible();
  const exit = {
    ...hold,
    id: 'exit-one',
    action: 'sell',
    reason: 'sale_better_than_hold_value',
    evaluatedAt: NOW + 21000,
    validUntil: NOW + 36000,
    limitPrice: 0.65,
  };
  rerender(
    <AdvisorAction
      report={{ ...report, latestAdvice: exit, currentPlan: createAdvisorPlan(exit) }}
      market={market}
      now={NOW + 22000}
    />,
  );
  expect(screen.getByRole('heading', { name: 'EXIT UP' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'HOLD UP' })).not.toBeInTheDocument();
  expect(screen.getByText('Minimum sell price')).toBeVisible();
});

test.each([
  ['buy', 'fee_adjusted_entry_edge', 'BUY UP', /Buy UP only at \$0.57 or less/],
  ['sell', 'sale_better_than_hold_value', 'EXIT UP', /Sell only at \$0.57 or better/],
  ['sell', 'reduce_at_better_than_hold_value', 'REDUCE UP', /Sell only at \$0.57 or better/],
])(
  'keeps the %s price condition visible when its execution quote needs refreshing',
  (action, reason, heading, condition) => {
    const recommendation = { ...hold, action, reason, limitPrice: 0.57 };
    render(
      <AdvisorAction
        report={{
          ...report,
          latestAdvice: recommendation,
          currentPlan: createAdvisorPlan(recommendation),
        }}
        market={market}
        now={NOW + 20000}
      />,
    );
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    expect(screen.getByText(condition)).toBeVisible();
    expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
    expect(screen.queryByText('Minimum sell price')).not.toBeInTheDocument();
    expect(screen.queryByText('Quantity')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Plan conditions'));
    expect(screen.getAllByText(condition)).toHaveLength(1);
  },
);

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

test('experiment history shows costs and status without AI commentary or competing action callouts', () => {
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
  fireEvent.click(screen.getByText('AI policy: costs and activity'));
  expect(screen.getByText(/Blocked by validation or risk checks/)).toBeVisible();
  expect(screen.getByText('Trading fees')).toBeVisible();
  expect(screen.getByText('Inference cost')).toBeVisible();
  expect(screen.getByText(/Last assessed/)).toBeVisible();
  expect(screen.queryByText('Last recorded experiment: BUY DOWN')).not.toBeInTheDocument();
  expect(screen.queryByText('Selling pressure increased.')).not.toBeInTheDocument();
  expect(screen.queryByText('Evaluate a move below the target.')).not.toBeInTheDocument();
  expect(screen.queryByText('Buying pressure recovers')).not.toBeInTheDocument();
});

test.each([
  ['pending', 'Updating'],
  ['proposed', 'Updating'],
  ['fallback', 'Numerical fallback'],
  ['local', 'Numerical plan'],
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
