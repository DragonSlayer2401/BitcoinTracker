import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TradingAdvisor from '../index.web';
import { formatDateTime } from '../../../utils/format.utils';
import { useGetTradingAdvisorReportQuery } from '@/services/research/tradingAdvisor/tradingAdvisor.api';

jest.mock('@/services/research/tradingAdvisor/tradingAdvisor.api', () => ({
  useGetTradingAdvisorReportQuery: jest.fn(),
}));

const NOW = Date.UTC(2026, 9, 3, 22, 8);
const market = {
  ticker: 'KXBTC15M-26OCT031715-15',
  target: 50_000,
  startsAt: NOW - 480_000,
  expiresAt: NOW + 420_000,
};
const policy = {
  id: 'advisor-v1',
  totalBudget: 100,
  cashReserve: 50,
  maxOpenRisk: 20,
  maxPositionCost: 10,
  maxDailyLoss: 5,
};
const advice = {
  id: 'advice-1',
  contract: market,
  evaluatedAt: NOW,
  validUntil: NOW + 15_000,
  action: 'buy',
  side: 'yes',
  quantity: 10,
  limitPrice: 0.6,
  maxCost: 6.168,
  expectedNetValue: 1.332,
  conservativeExpectedNetValue: 0.832,
  quotedFee: 0.168,
  probability: 0.75,
  reason: 'fee_adjusted_entry_edge',
  executionStatus: 'pending',
  exitPlan: { limitPrice: 0.83, expiresAt: NOW + 15_000, reason: 'fee_adjusted_exit_target' },
};
const report = {
  startedAt: NOW - 60_000,
  asOf: NOW,
  policy,
  collector: { status: 'running', heartbeatAt: NOW },
  latestAdvice: advice,
  portfolio: {
    cash: 93.832,
    openRisk: 6.168,
    reservedCapital: 6.168,
    realizedPnl: 0,
    dailyRealizedPnl: 0,
    positions: [],
    pendingIntents: [],
  },
  performance: {
    realizedPnl: 0,
    totalFees: 0,
    maxRealizedDrawdown: 0,
    settledCount: 0,
    fillCount: 0,
    noFillCount: 0,
    pairedPositionCount: 0,
    pendingComparisonCount: 0,
  },
  recentActivity: [],
};

function mockQuery(overrides = {}) {
  const query = { data: report, refetch: jest.fn(), ...overrides };
  useGetTradingAdvisorReportQuery.mockReturnValue(query);
  return query;
}

const props = {
  market,
  now: NOW,
  chart: <p>BRTI chart</p>,
  research: <h3>Forecast research content</h3>,
};
const metric = (label) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;

beforeEach(() => mockQuery());

test('explains when a running collector still uses the removed daily-loss rule', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'wait',
        side: null,
        reason: 'daily_loss_limit',
        executionStatus: null,
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByText('Collector update needed')).toBeVisible();
  expect(screen.getByText(/Restart it to apply the update/)).toBeVisible();
  expect(screen.queryByText(/Stop new entries after/)).not.toBeInTheDocument();
});

test('puts a fresh buy, price limit, fees and paper budget ahead of forecast research', () => {
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeInTheDocument();
  expect(metric('Total budget')).toHaveTextContent('$100.00');
  expect(metric('Quantity')).toHaveTextContent('10 contracts');
  expect(metric('Maximum buy price')).toHaveTextContent('$0.60');
  expect(metric('Maximum total cost')).toHaveTextContent('$6.168');
  expect(metric('Estimated fees')).toHaveTextContent('$0.168');
  expect(screen.getByText('After the entry fills:')).toBeInTheDocument();
  expect(screen.getByText('Sell 10 UP contracts at 83¢ or better.')).toBeInTheDocument();
  expect(screen.getByText(/No order has been placed/)).toBeInTheDocument();
  expect(screen.getByText(/Paper adviser · no real orders/)).toBeInTheDocument();
  expect(screen.getByText(/not your Kalshi holdings/)).toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: 'Forecast research content' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'BUY UP' })).not.toBeInTheDocument();
  expect(screen.getByRole('timer', { name: 'Current Kalshi event closes in' })).toHaveTextContent(
    '07:00',
  );
  expect(useGetTradingAdvisorReportQuery).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({ pollingInterval: 5000, skipPollingIfUnfocused: true }),
  );
});

test('describes a sale as an advantage over holding rather than realized trade profit', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'sell',
        side: 'no',
        reason: 'sale_better_than_hold_value',
        expectedProceeds: 7.4,
        holdExpectedValue: 6.5,
        conservativeExpectedNetValue: 0.4,
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'EXIT DOWN' })).toBeInTheDocument();
  expect(metric('Estimated sale proceeds, net')).toHaveTextContent('$7.40');
  expect(metric('Expected settlement payout')).toHaveTextContent('$6.50');
  expect(metric('Sale advantage after caution margin')).toHaveTextContent('$0.40');
  expect(screen.getByText(/It is not realized profit on the position/)).toBeInTheDocument();
  expect(screen.queryByText('Expected profit if held')).not.toBeInTheDocument();
  expect(screen.getByText('Sell 10 DOWN contracts at 60¢ or better.')).toBeInTheDocument();
});

test('holds an existing position while clearly comparing expected holding and selling values', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'hold',
        reason: 'hold_value_exceeds_sale',
        limitPrice: null,
        holdExpectedValue: 7.5,
        expectedProceeds: 6.4,
      },
      portfolio: {
        ...report.portfolio,
        positions: [
          {
            id: 'position-1',
            contract: market,
            side: 'yes',
            quantity: 10,
            availableQuantity: 8,
            averagePrice: 0.58,
            costBasis: 5.968,
            entryFees: 0.168,
          },
        ],
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'HOLD UP' })).toBeInTheDocument();
  expect(screen.getByText(/Keep the position/)).toBeInTheDocument();
  expect(screen.queryByText(/required fees and uncertainty margin/)).not.toBeInTheDocument();
  expect(metric('Expected settlement payout')).toHaveTextContent('$7.50');
  expect(metric('Estimated sale proceeds, net')).toHaveTextContent('$6.40');
  const row = within(screen.getByRole('rowheader', { name: market.ticker }).closest('tr'));
  expect(row.getByText('UP')).toBeInTheDocument();
  expect(row.getByText('8')).toBeInTheDocument();
  expect(row.getByText('$5.968')).toBeInTheDocument();
  expect(screen.queryByText('Minimum sell price')).not.toBeInTheDocument();
});

test('uses the conditional exit quantity and side without describing a held position as a new entry', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'hold',
        side: 'no',
        executionStatus: null,
        exitPlan: { ...advice.exitPlan, side: 'no', quantity: 3, limitPrice: 0.72 },
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByText('Sell 3 DOWN contracts at 72¢ or better.')).toBeInTheDocument();
  expect(screen.queryByText('After the entry fills:')).not.toBeInTheDocument();
});

test('does not suggest the full pre-sale quantity again when advice reduces part of a position', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'sell',
        quantity: 3,
        reason: 'reduce_at_better_than_hold_value',
        exitPlan: { ...advice.exitPlan, side: 'yes', quantity: 10 },
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'REDUCE UP' })).toBeInTheDocument();
  expect(metric('Quantity')).toHaveTextContent('3 contracts');
  expect(screen.getByText('Sell 3 UP contracts at 60¢ or better.')).toBeInTheDocument();
  expect(screen.queryByText(/Sell 10 UP contracts/)).not.toBeInTheDocument();
});

test('HOLD uses plain language without overstating a small difference between selling and holding', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'hold',
        reason: 'hold_value_exceeds_sale',
        expectedProceeds: 7.51,
        holdExpectedValue: 7.5,
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(metric('Estimated sale proceeds, net')).toHaveTextContent('$7.51');
  expect(metric('Expected settlement payout')).toHaveTextContent('$7.50');
  expect(screen.getByText(/Keep the position/)).toBeInTheDocument();
  expect(screen.queryByText(/Holding is estimated to be worth more/)).not.toBeInTheDocument();
});

test('keeps a standing sell limit when its quote expires but the same entry plan remains active', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: { ...advice, exitPlan: { ...advice.exitPlan, expiresAt: NOW } },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Set a sell limit at 83¢' })).toBeVisible();
  expect(screen.getByText('After the entry fills:')).toBeVisible();
  expect(screen.queryByText(/Recheck by/)).not.toBeInTheDocument();
});

test('distinguishes suggestions, simulated fills, unfilled orders and completed outcomes in activity', () => {
  mockQuery({
    data: {
      ...report,
      recentActivity: [
        {
          id: 'suggestion',
          kind: 'advice',
          action: 'buy',
          side: 'yes',
          quantity: 10,
          recordedAt: NOW,
        },
        { id: 'buy-fill', kind: 'fill', action: 'buy', side: 'yes', quantity: 10, recordedAt: NOW },
        {
          id: 'sell-no-fill',
          kind: 'no-fill',
          action: 'sell',
          side: 'yes',
          quantity: 0,
          recordedAt: NOW,
        },
        {
          id: 'sell-fill',
          kind: 'fill',
          action: 'sell',
          side: 'yes',
          quantity: 7,
          recordedAt: NOW,
          realizedPnl: -1.25,
        },
        {
          id: 'settlement',
          kind: 'settlement',
          side: 'yes',
          quantity: 3,
          recordedAt: NOW,
          realizedPnl: 0,
        },
        { id: 'comparison', kind: 'comparison', recordedAt: NOW },
      ],
    },
  });
  render(<TradingAdvisor {...props} />);
  fireEvent.click(screen.getByText('Recent paper activity'));
  const activity = within(
    within(screen.getByRole('region', { name: 'Paper positions' })).getByRole('list'),
  );
  expect(activity.getByText('Suggestion · BUY UP')).toBeInTheDocument();
  expect(activity.getByText('Simulated fill · BUY UP')).toBeInTheDocument();
  expect(activity.getByText('No simulated fill · SELL UP')).toBeInTheDocument();
  expect(activity.getByText('Simulated fill · SELL UP')).toBeInTheDocument();
  expect(activity.getByText('Official settlement UP')).toBeInTheDocument();
  expect(activity.getByText('Hold comparison complete')).toBeInTheDocument();
  expect(activity.getByText('Realized net P&L: -$1.25')).toBeInTheDocument();
  expect(activity.getByText('Realized net P&L: $0.00')).toBeInTheDocument();
  expect(activity.getByText(/Closed against the official Kalshi result/)).toBeInTheDocument();
  expect(activity.getByText(/Completed comparison with holding to settlement/)).toBeInTheDocument();
  expect(activity.queryByText('Waiting for the next recorded evaluation.')).not.toBeInTheDocument();
});

test.each([
  ['expired advice', { latestAdvice: { ...advice, validUntil: NOW } }],
  ['old evaluation', { latestAdvice: { ...advice, evaluatedAt: NOW - 30_000 } }],
  ['old heartbeat', { collector: { status: 'running', heartbeatAt: NOW - 30_000 } }],
  ['future evaluation', { latestAdvice: { ...advice, evaluatedAt: NOW + 1 } }],
  ['stopped collector', { collector: { status: 'stopped', heartbeatAt: NOW } }],
  [
    'other contract',
    { latestAdvice: { ...advice, contract: { ...market, ticker: 'KXBTC15M-OTHER' } } },
  ],
  ['changed target', { latestAdvice: { ...advice, contract: { ...market, target: 49_999 } } }],
])(
  'keeps a %s plan only for its original open event without repeating old quotes',
  (_label, changes) => {
    mockQuery({ data: { ...report, ...changes } });
    render(<TradingAdvisor {...props} />);
    const appliesToCurrentEvent = ![
      'future evaluation',
      'other contract',
      'changed target',
    ].includes(_label);
    if (appliesToCurrentEvent) {
      expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeInTheDocument();
      expect(screen.getByText('Current plan')).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
      expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
    }
    expect(
      screen.queryByText(/Stale assessment|not a current instruction|evidence.*expired/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
    expect(screen.queryByText('Conditional exit plan')).not.toBeInTheDocument();
  },
);

test.each(['filled', 'no-fill'])(
  'stops asking for a new buy after its order is %s',
  (executionStatus) => {
    mockQuery({ data: { ...report, latestAdvice: { ...advice, executionStatus } } });
    render(<TradingAdvisor {...props} />);
    expect(screen.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: executionStatus === 'filled' ? 'UP PURCHASED' : 'ORDER NOT FILLED',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Current plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
    expect(screen.getByText('Recorded plan')).toBeInTheDocument();
  },
);

test.each([
  ['buy', 'yes', 'UP', 'Recorded entry cost, including fees: $5.968.'],
  ['sell', 'no', 'DOWN', 'Recorded sale proceeds, after fees: $5.632.'],
])(
  'retains the actual completed %s details alongside its historical assessment',
  (action, side, sideLabel, amountLabel) => {
    mockQuery({
      data: {
        ...report,
        latestAdvice: { ...advice, action, side, executionStatus: 'filled' },
        recentActivity: [
          {
            id: 'unrelated-fill',
            adviceId: 'other-advice',
            kind: 'fill',
            action,
            side,
            quantity: 99,
            price: 0.99,
            totalCost: 99,
            netProceeds: 99,
            fee: 0.01,
            recordedAt: NOW,
          },
          {
            id: 'matching-fill',
            adviceId: advice.id,
            kind: 'fill',
            action,
            side,
            quantity: 10,
            price: 0.58,
            totalCost: 5.968,
            netProceeds: 5.632,
            fee: 0.168,
            recordedAt: NOW + 2000,
          },
        ],
      },
    });
    render(<TradingAdvisor {...props} now={NOW + 3000} />);
    expect(
      screen.queryByRole('heading', { name: action === 'buy' ? 'BUY UP' : 'EXIT DOWN' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: action === 'buy' ? 'UP PURCHASED' : 'DOWN SOLD' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Recorded plan')).toBeInTheDocument();
    const history = within(screen.getByRole('region', { name: 'Last simulated fill' }));
    expect(
      history.getByText(
        `Completed ${action.toUpperCase()} ${sideLabel} · 10 contracts at $0.58 each`,
      ),
    ).toBeInTheDocument();
    expect(
      history.getByText(new RegExp(amountLabel.replaceAll('$', '\\$').replaceAll('.', '\\.'))),
    ).toBeInTheDocument();
    expect(history.getByText(/Estimated fill fee: \$0.168/)).toBeInTheDocument();
    expect(history.getByText(/Completed paper account history/)).toBeInTheDocument();
    expect(history.queryByText(/99 contracts/)).not.toBeInTheDocument();
    expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
    expect(screen.queryByText('Conditional exit plan')).not.toBeInTheDocument();
  },
);

test('a fresh no-trade decision explains the missing edge rather than blaming stale data', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: {
        ...advice,
        action: 'wait',
        side: null,
        reason: 'insufficient_entry_edge',
        executionStatus: null,
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'NO TRADE' })).toBeInTheDocument();
  expect(screen.getByText(/Insufficient edge/)).toBeInTheDocument();
  expect(screen.getByText('Fresh evaluation')).toBeInTheDocument();
});

test('shows startup instructions with an explicit budget and unknown balances before a report exists', () => {
  mockQuery({ data: undefined });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'Awaiting first assessment' })).toBeInTheDocument();
  expect(metric('Total budget')).toHaveTextContent('$100.00');
  expect(metric('Available cash')).toHaveTextContent('—');
  expect(
    screen.getByText(/to choose your paper allocation and start collection/),
  ).toBeInTheDocument();
  expect(screen.getByText('Position data is unavailable.')).toBeInTheDocument();
  expect(screen.queryByText(/No open simulated positions/)).not.toBeInTheDocument();
});

test('an API error retains the last buy assessment without its prices and provides a retry', () => {
  const query = mockQuery({ isError: true });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeInTheDocument();
  expect(screen.getByText('Current plan')).toBeInTheDocument();
  expect(screen.getByText(/Updates interrupted/)).toBeInTheDocument();
  expect(screen.queryByText(/Stale assessment|not a current instruction/)).not.toBeInTheDocument();
  expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh adviser' }));
  expect(query.refetch).toHaveBeenCalledTimes(1);
});

test('failed refreshes label cached balances, positions and performance as last known', () => {
  mockQuery({ isError: true });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByText('Outdated account data').closest('p')).toHaveTextContent(
    formatDateTime(NOW),
  );
  expect(screen.getByText(/Balances and positions are last known/)).toBeInTheDocument();
  expect(metric('Available cash')).toHaveTextContent('$93.832');
  expect(screen.getByText(/Last known positions from/)).toHaveTextContent(formatDateTime(NOW));
  expect(screen.getByText('No open positions were recorded in that snapshot.')).toBeInTheDocument();
  expect(screen.queryByText(/Cash stays available/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Outdated performance data');
  expect(screen.getByRole('alert')).toHaveTextContent(formatDateTime(NOW));
});

test.each([
  ['expired', NOW - 30_000],
  ['future-dated', NOW + 1000],
  ['missing timestamp', undefined],
])('marks a %s report stale even without an HTTP error', (_label, asOf) => {
  mockQuery({ data: { ...report, asOf } });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByText('Outdated account data')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeInTheDocument();
  expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
});

test('a retry keeps cached quantities marked stale until a successful fresh report arrives', () => {
  const cachedReport = {
    ...report,
    portfolio: {
      ...report.portfolio,
      positions: [
        { id: 'position-1', contract: market, side: 'yes', quantity: 10, availableQuantity: 8 },
      ],
    },
  };
  mockQuery({ data: cachedReport, isFetching: true, error: { status: 503 } });
  const { rerender } = render(<TradingAdvisor {...props} />);
  expect(screen.getByText('Outdated account data')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Last known available' })).toBeInTheDocument();
  mockQuery({ data: { ...cachedReport, asOf: NOW + 1000 } });
  rerender(<TradingAdvisor {...props} now={NOW + 1000} />);
  expect(screen.queryByText('Outdated account data')).not.toBeInTheDocument();
  expect(screen.getByText('Account snapshot').closest('p')).toHaveTextContent(
    formatDateTime(NOW + 1000),
  );
  expect(screen.getByRole('columnheader', { name: 'Available to sell' })).toBeInTheDocument();
});

test('an ordinary in-flight refresh retains a recent successful account snapshot', () => {
  mockQuery({ isFetching: true });
  render(<TradingAdvisor {...props} now={NOW + 5000} />);
  expect(screen.queryByText('Outdated account data')).not.toBeInTheDocument();
  expect(metric('Available cash')).toHaveTextContent('$93.832');
});

test('a response arriving between clock ticks does not flash an outdated-account warning', () => {
  mockQuery({ data: { ...report, asOf: NOW + 500 }, fulfilledTimeStamp: NOW + 700 });
  render(<TradingAdvisor {...props} />);
  expect(screen.queryByText('Outdated account data')).not.toBeInTheDocument();
  expect(screen.getByText('Account snapshot')).toBeInTheDocument();
});

test('opens supporting research in a keyboard-accessible modal and restores focus', async () => {
  const user = userEvent.setup();
  render(<TradingAdvisor {...props} />);
  const button = screen.getByRole('button', { name: 'Research & market details' });
  await user.click(button);
  expect(screen.getByRole('dialog', { name: 'Research & market details' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Forecast research content' })).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(button).toHaveFocus();
});

test('compares strategy results with holding only on the same completed positions', () => {
  mockQuery({
    data: {
      ...report,
      performance: {
        ...report.performance,
        pairedPositionCount: 3,
        pairedStrategyPnl: 1.42,
        pairedHoldPnl: 0.92,
        pairedAdvantage: 0.5,
        pendingComparisonCount: 2,
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
  expect(metric('Same positions compared')).toHaveTextContent('3');
  expect(metric('Adviser advantage')).toHaveTextContent('$0.50');
  expect(screen.getByText(/Awaiting comparison: 2 positions/)).toBeInTheDocument();
  expect(
    screen.getByText(/same simulated entries and their actual official outcomes/),
  ).toBeInTheDocument();
});

test('does not present zero completed comparisons as measured strategy improvement', () => {
  render(<TradingAdvisor {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
  expect(screen.getByText(/No completed comparisons yet/)).toBeInTheDocument();
  expect(screen.queryByText('Adviser advantage')).not.toBeInTheDocument();
});

function reportWithAiGuidance(overrides = {}) {
  const aiAdvice = {
    ...advice,
    id: 'ai-advice-1',
    action: 'hold',
    side: 'no',
    quantity: 2,
    reason: 'hold_value_exceeds_sale',
    exitPlan: null,
    executionStatus: null,
  };
  const guidance = {
    ...report,
    accountId: 'trial-1:language-model',
    latestAdvice: aiAdvice,
    portfolio: {
      ...report.portfolio,
      cash: 88,
      openRisk: 2,
      reservedCapital: 0,
      realizedPnl: -1,
      positions: [
        {
          id: 'ai-position-1',
          contract: market,
          side: 'no',
          quantity: 2,
          availableQuantity: 2,
          averageEntryPrice: 0.4,
          remainingCost: 0.82,
        },
      ],
    },
    performance: {
      ...report.performance,
      totalFees: 0.25,
      inferenceCost: 0.1,
      netProfit: -1.1,
    },
    source: {
      kind: 'ai',
      status: 'accepted',
      pending: false,
      providerStatus: 'configured',
      model: 'configured-model',
      decision: { rationale: 'Persistent selling pressure supports keeping DOWN.' },
    },
    ...overrides,
  };
  return {
    ...report,
    historyTrials: {
      provider: { status: 'configured', model: 'configured-model' },
      strategies: [{ id: 'language-model', label: 'AI paper account', guidance }],
    },
  };
}

test('defaults to AI guidance with its own cash, positions and costs and can switch to baseline', () => {
  mockQuery({ data: reportWithAiGuidance() });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('button', { name: 'AI-assisted' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('heading', { name: 'HOLD DOWN' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
  expect(metric('Available cash')).toHaveTextContent('$88.00');
  expect(metric('Position size')).toHaveTextContent('2 contracts');
  expect(screen.getByText('AI plan')).toBeVisible();
  expect(
    screen.queryByText('Persistent selling pressure supports keeping DOWN.'),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('rowheader', { name: market.ticker })).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
  expect(metric('Estimated fees paid')).toHaveTextContent('$0.25');
  expect(metric('AI usage cost')).toHaveTextContent('$0.10');
  expect(metric('Net P&L after AI costs')).toHaveTextContent('-$1.10');
  fireEvent.click(screen.getByRole('button', { name: 'Close performance' }));
  fireEvent.click(screen.getByRole('button', { name: 'Numerical baseline' }));
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeVisible();
  expect(metric('Available cash')).toHaveTextContent('$93.832');
  expect(screen.queryByRole('heading', { name: 'HOLD DOWN' })).not.toBeInTheDocument();
  expect(
    screen.queryByText('Persistent selling pressure supports keeping DOWN.'),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('rowheader', { name: market.ticker })).not.toBeInTheDocument();
});

test('AI account performance retains access to current and previous independent experiments', () => {
  const current = reportWithAiGuidance({ policy: { ...policy, maxEntryContracts: 1 } });
  mockQuery({
    data: {
      ...current,
      trials: {
        policyId: 'research-policy-one-contract',
        registeredAt: NOW,
        initialBankroll: 100,
        maxEntryContracts: 1,
        previousExperiments: [{ policyId: 'original-strategy-trial', registeredAt: NOW - 1000 }],
      },
      historyTrials: {
        ...current.historyTrials,
        id: 'research-history-one-contract',
        registeredAt: NOW,
        initialBankroll: 100,
        maxEntryContracts: 1,
        previousExperiments: [{ id: 'original-history-trial', registeredAt: NOW - 1000 }],
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('button', { name: 'AI-assisted' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByText(/Research entry limit: 1 contract\./)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Performance' }));
  expect(screen.getByText(/Experiment research-policy-one-contract/)).toBeVisible();
  expect(screen.getByText(/Experiment research-history-one-contract/)).toBeVisible();
  fireEvent.click(screen.getByText(/Previous strategy experiment/));
  fireEvent.click(screen.getByText(/Previous history experiment/));
  expect(screen.getByText(/Experiment original-strategy-trial/)).toBeVisible();
  expect(screen.getByText(/Experiment original-history-trial/)).toBeVisible();
});

test.each([true, false])(
  'keeps the current AI plan while pending=%s without proposal chatter or commentary',
  (pending) => {
    mockQuery({
      data: reportWithAiGuidance({
        source: {
          kind: 'ai',
          pending,
          decision: { rationale: 'Accepted hold reasoning.' },
          latestDecision: { status: 'proposed', rationale: 'Unvalidated buy proposal.' },
        },
      }),
    });
    render(<TradingAdvisor {...props} now={NOW + 20000} />);
    expect(screen.getByRole('heading', { name: 'HOLD DOWN' })).toBeVisible();
    expect(screen.getByText(/· Updating/)).toBeVisible();
    expect(screen.queryByText(/New AI assessment|New AI proposal/)).not.toBeInTheDocument();
    expect(screen.queryByText('Accepted hold reasoning.')).not.toBeInTheDocument();
    expect(screen.queryByText('Unvalidated buy proposal.')).not.toBeInTheDocument();
    expect(screen.getByText('Current plan')).toBeVisible();
    expect(screen.queryByText('Stale assessment')).not.toBeInTheDocument();
    expect(screen.queryByText('Position size')).not.toBeInTheDocument();
  },
);

test.each([
  ['event ended', { now: market.expiresAt }, 'EVENT ENDED'],
  ['new event', { market: { ...market, ticker: 'KXBTC15M-NEXT' } }, 'REVIEWING NEW EVENT'],
])(
  'moves an AI plan to history after %s without repeating its action or rationale',
  (_label, changes, heading) => {
    mockQuery({ data: reportWithAiGuidance() });
    render(<TradingAdvisor {...props} {...changes} />);
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'HOLD DOWN' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Persistent selling pressure supports keeping DOWN.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Position size')).not.toBeInTheDocument();
    expect(screen.queryByText('Plan conditions')).not.toBeInTheDocument();
    expect(screen.getByText(/Recorded for/)).toHaveTextContent(market.ticker);
  },
);

test('labels a numerical fallback as part of the AI account instead of claiming AI selected it', () => {
  mockQuery({
    data: reportWithAiGuidance({
      source: {
        kind: 'numerical-fallback',
        decision: { fallbackReason: 'request_timeout', rationale: 'Rejected AI explanation.' },
      },
    }),
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByText('Numerical fallback')).toBeVisible();
  expect(screen.getByText('request timeout')).toBeVisible();
  expect(screen.queryByText('Rejected AI explanation.')).not.toBeInTheDocument();
  expect(metric('Available cash')).toHaveTextContent('$88.00');
});

test('an enabled AI account awaiting its first report never borrows the baseline buy or balances', () => {
  mockQuery({
    data: {
      ...report,
      historyTrials: { provider: { status: 'configured' }, strategies: [] },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'Awaiting first assessment' })).toBeVisible();
  expect(metric('Available cash')).toHaveTextContent('—');
  expect(screen.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
  expect(screen.getByText('Awaiting AI assessment')).toBeVisible();
});

test('a local no-trade decision is not presented as an AI response or failed request', () => {
  mockQuery({
    data: reportWithAiGuidance({
      latestAdvice: {
        ...advice,
        action: 'wait',
        side: null,
        reason: 'insufficient_entry_edge',
        executionStatus: null,
      },
      source: {
        kind: 'numerical',
        status: 'local',
        model: 'configured-model',
        providerReason: null,
        decision: { status: 'local' },
      },
    }),
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'NO TRADE' })).toBeVisible();
  expect(screen.getByText('Numerical plan')).toBeVisible();
  expect(screen.queryByText('AI plan')).not.toBeInTheDocument();
  expect(screen.queryByText('Numerical fallback')).not.toBeInTheDocument();
  expect(screen.queryByText('Awaiting AI assessment')).not.toBeInTheDocument();
  expect(screen.queryByText(/configured-model/)).not.toBeInTheDocument();
});

test.each(['ai', 'numerical-fallback'])(
  'shows the exact provider failure alongside the retained %s assessment',
  (kind) => {
    mockQuery({
      data: reportWithAiGuidance({
        source: {
          kind,
          providerReason: 'provider_quota_exhausted',
          decision: {
            rationale: 'Previous accepted reasoning.',
            fallbackReason: 'request_failed',
          },
        },
      }),
    });
    render(<TradingAdvisor {...props} now={NOW + 20000} />);
    expect(
      screen.getByText(/no available credits or has reached its spending limit/),
    ).toBeVisible();
    expect(screen.queryByText(/request failed/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'HOLD DOWN' })).toBeVisible();
    expect(screen.getByText('Current plan')).toBeVisible();
    expect(screen.queryByText('Stale assessment')).not.toBeInTheDocument();
    if (kind === 'ai') expect(screen.getByText('AI plan')).toBeVisible();
  },
);
