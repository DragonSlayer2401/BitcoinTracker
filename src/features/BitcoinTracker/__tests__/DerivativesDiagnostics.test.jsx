import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketDiagnostics from '../components/MarketDiagnostics';
import ForecastPrediction from '../components/ForecastPrediction';

test('futures diagnostics explain the current probability change and distinguish liquidation sides', async () => {
  const user = userEvent.setup();
  render(
    <MarketDiagnostics
      forecast={{
        derivatives: {
          available: true,
          applied: true,
          reason: null,
          baselineAboveProbability: 0.6,
          aboveProbability: 0.57,
          adjustmentPercentagePoints: -3,
        },
      }}
      derivatives={{
        status: 'live',
        windows: {
          60: {
            available: true,
            buyBtc: 5,
            sellBtc: 12,
            largeTradesAvailable: true,
            largeBuyBtc: 1,
            largeSellBtc: 6,
          },
        },
        liquidations: {
          available: true,
          windows: { 60: { available: true, longBtc: 2, shortBtc: 0.5 } },
        },
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Market detail' }));
  const detail = within(screen.getByRole('region', { name: 'Bitcoin futures pressure' }));
  expect(detail.getByText(/Before futures Yes:/)).toHaveTextContent(
    '60.0% · After futures Yes: 57.0% (-3.00 percentage points)',
  );
  expect(
    detail.getByRole('row', { name: '60s 5.000 12.000 1.000 6.000 2.000 0.500' }),
  ).toBeVisible();
  expect(detail.getByText(/not added to executed volume again/)).toBeVisible();
});

test('unavailable futures preserve the fallback explanation and never display old volumes as current', async () => {
  const user = userEvent.setup();
  render(
    <MarketDiagnostics
      forecast={{
        derivatives: {
          available: false,
          applied: false,
          reason: 'Futures feed unavailable; using the existing settlement calculation.',
        },
      }}
      derivatives={{
        status: 'reconnecting',
        windows: { 60: { available: true, buyBtc: 999, sellBtc: 999 } },
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Market detail' }));
  const detail = within(screen.getByRole('region', { name: 'Bitcoin futures pressure' }));
  expect(detail.getByText(/using the existing settlement calculation/)).toBeVisible();
  expect(detail.queryByText(/999/)).not.toBeInTheDocument();
  expect(detail.queryByText(/Before futures Yes/)).not.toBeInTheDocument();
});

test('a captured futures adjustment has a clear label without claiming it is an activated learner', () => {
  render(
    <ForecastPrediction
      label="Fixed prediction"
      forecast={{
        available: true,
        direction: 'below',
        aboveProbability: 0.4,
        belowProbability: 0.6,
        derivatives: { applied: true },
      }}
    />,
  );
  expect(screen.getByText('Fixed prediction · Futures pressure')).toBeVisible();
  expect(screen.queryByText(/Learned model/)).not.toBeInTheDocument();
});
