import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KalshiPurchaseValue from '../components/KalshiPurchaseValue';
import ForecastRisk from '../components/ForecastRisk';
import { useGetKalshiPurchaseValueQuery } from '../../../services/kalshi/purchaseValue/purchaseValue.api';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('../../../services/kalshi/purchaseValue/purchaseValue.api', () => ({
  useGetKalshiPurchaseValueQuery: jest.fn(),
}));
const start = Date.UTC(2026, 8, 15, 12);
const now = start + 120_000;
const contract = {
  ticker: 'KXBTC15M-26SEP151215-15',
  eventTicker: 'KXBTC15M-26SEP151215',
  seriesTicker: 'KXBTC15M',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  rulesVerified: true,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  target: 75_000,
  startsAt: start,
  expiresAt: start + 900_000,
};
const refetch = jest.fn();
const query = () => ({
  isFetching: false,
  isError: false,
  refetch,
  currentData: {
    ticker: contract.ticker,
    receivedAt: now,
    yesAsks: [{ price: 0.5, quantity: 100 }],
    noAsks: [{ price: 0.55, quantity: 2 }],
    fee: {
      available: true,
      type: 'quadratic',
      multiplier: 1,
      checkedAt: now,
      validUntil: now + 30_000,
    },
  },
});
beforeEach(() => {
  jest.clearAllMocks();
  useGetKalshiPurchaseValueQuery.mockReturnValue(query());
});

test('keeps net value unavailable until account basis is selected, then adjusts for quantity and depth', async () => {
  const user = userEvent.setup();
  render(<KalshiPurchaseValue contract={contract} aboveProbability={0.7} now={now} />);
  expect(screen.getByText('Choose your account type to estimate fees.')).toBeVisible();
  let netRow = screen.getByRole('row', { name: /Expected value after fees/ });
  expect(within(netRow).getAllByText('—')).toHaveLength(2);
  await user.click(screen.getByRole('combobox', { name: 'Account fee basis' }));
  await user.click(screen.getByText('Using Kalshi directly'));
  netRow = screen.getByRole('row', { name: /Expected value after fees/ });
  expect(within(netRow).getByText('$0.1825')).toBeVisible();
  await user.clear(screen.getByRole('spinbutton', { name: 'Contracts to compare' }));
  await user.type(screen.getByRole('spinbutton', { name: 'Contracts to compare' }), '3');
  expect(screen.getByText(/Insufficient displayed depth/)).toBeVisible();
  expect(
    within(screen.getByRole('row', { name: /Expected value after fees/ })).getByText('—'),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Refresh prices' }));
  expect(refetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/No order is placed here/)).toBeVisible();
});

test('does not reuse prices after an error and skips queries for closed events', () => {
  useGetKalshiPurchaseValueQuery.mockReturnValue({ ...query(), isError: true });
  const { rerender } = render(
    <KalshiPurchaseValue contract={contract} aboveProbability={0.7} now={now} />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Purchase prices could not be refreshed');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  rerender(
    <KalshiPurchaseValue contract={contract} aboveProbability={0.7} now={contract.expiresAt} />,
  );
  expect(useGetKalshiPurchaseValueQuery).toHaveBeenLastCalledWith(
    contract.ticker,
    expect.objectContaining({ skip: true }),
  );
});

test('purchase reads begin only after opening the optional panel and stop on closing risk', async () => {
  const user = userEvent.setup();
  const fixedForecast = {
    id: 'purchase-risk',
    target: contract.target,
    expiresAt: contract.expiresAt,
    direction: 'above',
    status: 'pending',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshiMarket: contract,
  };
  const forecast = {
    available: true,
    target: contract.target,
    expiresAt: contract.expiresAt,
    aboveProbability: 0.7,
    belowProbability: 0.3,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    kalshi: {
      marketTicker: contract.ticker,
      referencePrice: 75_001,
      referenceAt: now,
      referenceSource: 'cf-brti',
    },
  };
  render(
    <ForecastRisk
      forecast={forecast}
      fixedForecast={fixedForecast}
      ticker={{ price: 75_001, time: now }}
      now={now}
    />,
  );
  expect(useGetKalshiPurchaseValueQuery).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /view estimated deadline risk/ }));
  expect(useGetKalshiPurchaseValueQuery).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Compare purchase value' }));
  expect(useGetKalshiPurchaseValueQuery).toHaveBeenCalledWith(
    contract.ticker,
    expect.objectContaining({ skip: false, pollingInterval: 10_000 }),
  );
  await user.click(screen.getByRole('button', { name: 'Close forecast risk' }));
  expect(
    screen.queryByRole('heading', { name: 'Purchase value at displayed asks' }),
  ).not.toBeInTheDocument();
});
