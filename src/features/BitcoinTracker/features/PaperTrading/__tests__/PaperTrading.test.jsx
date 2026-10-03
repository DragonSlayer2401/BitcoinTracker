import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaperTrading from '../index.web';
import { useGetPaperTradingReportQuery } from '@/services/research/paperTrading/paperTrading.api';

jest.mock('@/services/research/paperTrading/paperTrading.api', () => ({
  useGetPaperTradingReportQuery: jest.fn(),
}));

const NOW = Date.UTC(2026, 9, 3, 22);
const emptyReport = {
  startedAt: null,
  asOf: NOW,
  collector: { status: 'not-started', heartbeatAt: null },
  policy: {
    id: 'kalshi-paper-v1',
    initialBankroll: 100,
    checkpointMinutes: 6,
    contracts: 1,
    probabilityReserve: 0.05,
    minimumNetEdge: 0.03,
    slippagePerContract: 0.01,
    minimumFillDelayMs: 2000,
    maximumFillDelayMs: 15_000,
    maxOpenRisk: 5,
    maxDailyLoss: 5,
  },
  summary: {
    initialBankroll: 100,
    cash: 100,
    reservedCapital: 0,
    openRisk: 0,
    dailyRealizedPnl: 0,
    realizedPnl: 0,
    settledCount: 0,
    openPositionCount: 0,
    pendingIntentCount: 0,
    decisionCount: 0,
    intentCount: 0,
    skippedCount: 0,
    fillCount: 0,
    noFillCount: 0,
    winCount: 0,
    lossCount: 0,
    winRate: null,
    profitFactor: null,
    maxRealizedDrawdown: 0,
    returnOnInitialCapital: 0,
    averageProfit: null,
    expectedNetValue: 0,
    conservativeExpectedNetValue: 0,
    actualNetPnl: 0,
    tradeCoverage: null,
    recentDecisions: [],
  },
};

function mockQuery(overrides = {}) {
  const query = { data: emptyReport, refetch: jest.fn(), ...overrides };
  useGetPaperTradingReportQuery.mockReturnValue(query);
  return query;
}

function getMetric(label) {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling;
}

beforeEach(() => {
  mockQuery();
});

test('loads only on opening and stops polling when dismissed, restoring keyboard focus', async () => {
  const user = userEvent.setup();
  render(<PaperTrading />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(useGetPaperTradingReportQuery).toHaveBeenLastCalledWith(
    undefined,
    expect.objectContaining({ skip: true }),
  );
  const button = screen.getByRole('button', { name: 'Paper trading' });
  await user.click(button);
  expect(screen.getByRole('dialog', { name: 'Paper trading results' })).toBeVisible();
  expect(useGetPaperTradingReportQuery).toHaveBeenLastCalledWith(
    undefined,
    expect.objectContaining({ skip: false, pollingInterval: 10_000, skipPollingIfUnfocused: true }),
  );
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  expect(useGetPaperTradingReportQuery).toHaveBeenLastCalledWith(
    undefined,
    expect.objectContaining({ skip: true }),
  );
});

test('distinguishes no evidence from measured zero performance and explains collection', () => {
  render(<PaperTrading />);
  fireEvent.click(screen.getByRole('button', { name: 'Paper trading' }));
  expect(screen.getByText('Paper collection not started')).toBeInTheDocument();
  expect(screen.getByText(/No settled trades yet/)).toBeInTheDocument();
  expect(
    screen.getByText(/Earlier forecast research is not treated as simulated trade history/),
  ).toBeInTheDocument();
  expect(getMetric('Realized net profit / loss')).toHaveTextContent('$0.00');
  expect(getMetric('Settled win rate')).toHaveTextContent('—');
  expect(getMetric('Trade coverage')).toHaveTextContent('—');
  expect(screen.getByText('pnpm research:collect --paper-trading')).toBeInTheDocument();
  expect(screen.getByText(/stop it first and restart with this flag/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Experiment assumptions and limits'));
  expect(screen.getByText(/not a statistically validated confidence bound/)).toBeInTheDocument();
});

test('shows net results, open exposure, fees and missing results without inventing zero values', () => {
  mockQuery({
    data: {
      ...emptyReport,
      startedAt: NOW - 3_600_000,
      collector: { status: 'stopped', heartbeatAt: NOW - 60_000 },
      summary: {
        ...emptyReport.summary,
        cash: 101.2643,
        reservedCapital: 0.6,
        openRisk: 0.6,
        settledCount: 3,
        openPositionCount: 1,
        decisionCount: 10,
        skippedCount: 6,
        intentCount: 4,
        fillCount: 4,
        winCount: 2,
        lossCount: 1,
        realizedPnl: 1.8643,
        dailyRealizedPnl: 0,
        winRate: 2 / 3,
        profitFactor: 2.2,
        maxRealizedDrawdown: 0.25,
        returnOnInitialCapital: 0.018643,
        averageProfit: 1.8643 / 3,
        expectedNetValue: 0.9,
        conservativeExpectedNetValue: 0.75,
        actualNetPnl: 1.8643,
        tradeCoverage: 0.4,
        recentDecisions: [
          {
            id: 'filled',
            decidedAt: NOW,
            marketTicker: 'KXBTC15M-EXAMPLE',
            side: 'yes',
            quantity: 1,
            status: 'filled',
            reason: 'Displayed liquidity available.',
            filledQuantity: 1,
            averageFillPrice: 0.58,
            fees: 0.0171,
            expectedNetValue: 0.1029,
            realizedPnl: null,
          },
          {
            id: 'skipped',
            decidedAt: NOW - 900_000,
            marketTicker: 'KXBTC15M-SKIPPED',
            side: null,
            quantity: 1,
            status: 'skipped',
            reason: 'insufficient_conservative_edge_or_depth',
            filledQuantity: 0,
            averageFillPrice: null,
            fees: null,
            expectedNetValue: null,
            realizedPnl: null,
          },
        ],
      },
    },
  });
  render(<PaperTrading />);
  fireEvent.click(screen.getByRole('button', { name: 'Paper trading' }));
  expect(getMetric('Settled win rate')).toHaveTextContent('66.7%');
  expect(getMetric('Profit factor')).toHaveTextContent('2.20');
  expect(getMetric('Trade coverage')).toHaveTextContent('40.0%');
  expect(getMetric('Open positions awaiting settlement')).toHaveTextContent('1');
  expect(
    screen.getByText(/expected net \$0.90, cautious expected net \$0.75, realized net \$1.8643/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/drawdown exclude changes in the market value of open positions/),
  ).toBeInTheDocument();
  const trade = within(screen.getByRole('rowheader', { name: /KXBTC15M-EXAMPLE/ }).closest('tr'));
  expect(trade.getByText('YES')).toBeInTheDocument();
  expect(trade.getByText('$0.0171')).toBeInTheDocument();
  expect(trade.getByText('—')).toBeInTheDocument();
  expect(
    screen.getByText('Expected profit or displayed liquidity was too low.'),
  ).toBeInTheDocument();
  expect(getMetric('Daily realized profit / loss (UTC)')).toHaveTextContent('$0.00');
});

test('a stale running heartbeat is not presented as a confirmed running collector', () => {
  jest.useFakeTimers({ now: NOW });
  try {
    mockQuery({ data: { ...emptyReport, collector: { status: 'running', heartbeatAt: NOW } } });
    render(<PaperTrading />);
    fireEvent.click(screen.getByRole('button', { name: 'Paper trading' }));
    expect(screen.getByText('Collecting paper decisions · recent heartbeat')).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(31_000));
    expect(
      screen.getByText('Collector heartbeat stale · collection not confirmed'),
    ).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

test('shows an error and retries without treating an unavailable archive as empty', () => {
  const query = mockQuery({ data: undefined, isError: true });
  render(<PaperTrading />);
  fireEvent.click(screen.getByRole('button', { name: 'Paper trading' }));
  expect(screen.getByRole('alert')).toHaveTextContent('report is unavailable');
  expect(screen.queryByText(/No settled trades yet/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }));
  expect(query.refetch).toHaveBeenCalledTimes(1);
});

test('keeps previous results after a refresh error and labels them as last loaded', () => {
  mockQuery({ isError: true });
  render(<PaperTrading />);
  fireEvent.click(screen.getByRole('button', { name: 'Paper trading' }));
  expect(screen.getByText(/Showing the last loaded results/)).toBeInTheDocument();
  expect(getMetric('Available cash')).toHaveTextContent('$100.00');
});

test('represents loading separately from an empty experiment', () => {
  mockQuery({ data: undefined, isLoading: true, isFetching: true });
  render(<PaperTrading />);
  fireEvent.click(screen.getByRole('button', { name: 'Paper trading' }));
  expect(screen.getByRole('status')).toHaveTextContent('Loading paper trading results');
  expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  expect(screen.queryByText(/No paper decisions recorded/)).not.toBeInTheDocument();
});
