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
  expect(screen.getByText(/This order is not placed/)).toBeInTheDocument();
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
  expect(screen.getByRole('heading', { name: 'SELL DOWN' })).toBeInTheDocument();
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
  expect(
    screen.getByText('Selling does not clear the required fees and uncertainty margin.'),
  ).toBeInTheDocument();
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
  expect(screen.getByRole('heading', { name: 'SELL UP' })).toBeInTheDocument();
  expect(metric('Quantity')).toHaveTextContent('3 contracts');
  expect(screen.getByText('Sell 3 UP contracts at 60¢ or better.')).toBeInTheDocument();
  expect(screen.queryByText(/Sell 10 UP contracts/)).not.toBeInTheDocument();
});

test('HOLD explains the unmet sale margin even when selling has a small positive raw advantage', () => {
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
  expect(
    screen.getByText('Selling does not clear the required fees and uncertainty margin.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Holding is estimated to be worth more/)).not.toBeInTheDocument();
});

test('does not display an expired conditional sell limit even while the main advice remains fresh', () => {
  mockQuery({
    data: {
      ...report,
      latestAdvice: { ...advice, exitPlan: { ...advice.exitPlan, expiresAt: NOW } },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'BUY UP' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Sell limit order' })).not.toBeInTheDocument();
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
  const activity = within(screen.getByRole('list'));
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
])('shows WAIT for %s without repeating the old buy or its price target', (_label, changes) => {
  mockQuery({ data: { ...report, ...changes } });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'WAIT' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
  expect(screen.queryByText('Maximum buy price')).not.toBeInTheDocument();
  expect(screen.queryByText('Conditional exit plan')).not.toBeInTheDocument();
});

test.each(['filled', 'no-fill'])(
  'does not repeat a buy that already has execution status %s',
  (executionStatus) => {
    mockQuery({ data: { ...report, latestAdvice: { ...advice, executionStatus } } });
    render(<TradingAdvisor {...props} />);
    expect(screen.getByRole('heading', { name: 'WAIT' })).toBeInTheDocument();
    expect(
      screen.getByText(
        executionStatus === 'filled' ? /recorded simulated fill/ : /last suggestion did not fill/,
      ),
    ).toBeInTheDocument();
  },
);

test.each([
  ['buy', 'yes', 'UP', 'Recorded entry cost, including fees: $5.968.'],
  ['sell', 'no', 'DOWN', 'Recorded sale proceeds, after fees: $5.632.'],
])(
  'retains the actual completed %s details while guidance remains non-actionable WAIT',
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
    expect(screen.getByRole('heading', { name: 'WAIT' })).toBeInTheDocument();
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
        reason: 'insufficient_entry_edge_or_depth',
        executionStatus: null,
      },
    },
  });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'WAIT' })).toBeInTheDocument();
  expect(screen.getByText(/No suitable entry/)).toBeInTheDocument();
  expect(screen.getByText('Fresh evaluation')).toBeInTheDocument();
});

test('shows startup instructions with an explicit budget and unknown balances before a report exists', () => {
  mockQuery({ data: undefined });
  render(<TradingAdvisor {...props} />);
  expect(metric('Total budget')).toHaveTextContent('$100.00');
  expect(metric('Available cash')).toHaveTextContent('—');
  expect(
    screen.getByText(/to choose your paper allocation and start collection/),
  ).toBeInTheDocument();
  expect(screen.getByText('Position data is unavailable.')).toBeInTheDocument();
  expect(screen.queryByText(/No open simulated positions/)).not.toBeInTheDocument();
});

test('an API error suppresses cached buy guidance and provides a retry', () => {
  const query = mockQuery({ isError: true });
  render(<TradingAdvisor {...props} />);
  expect(screen.getByRole('heading', { name: 'WAIT' })).toBeInTheDocument();
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
  expect(screen.getByRole('heading', { name: 'WAIT' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'BUY UP' })).not.toBeInTheDocument();
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
