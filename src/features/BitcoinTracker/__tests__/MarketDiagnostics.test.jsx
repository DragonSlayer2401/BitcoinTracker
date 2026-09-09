import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MarketDiagnostics from '../components/MarketDiagnostics';

test('market detail shows warming inputs without inventing flow values and restores focus', async () => {
  const user = userEvent.setup();
  render(
    <MarketDiagnostics
      stream={{ status: 'warming', quality: { reason: 'Collecting complete trade flow.' } }}
    />,
  );
  const button = screen.getByRole('button', { name: 'Market detail' });
  await user.click(button);
  const dialog = within(screen.getByRole('dialog', { name: 'Market conditions and trade flow' }));
  expect(dialog.getByRole('row', { name: '180s · warming — — — —' })).toBeInTheDocument();
  expect(dialog.getByText(/Large-trade baseline is warming/)).toBeInTheDocument();
  await user.click(dialog.getByRole('button', { name: 'Close market detail' }));
  expect(button).toHaveFocus();
});

test('market detail separates executed pressure from displayed liquidity and discloses the experimental adjustment', async () => {
  const user = userEvent.setup();
  render(
    <MarketDiagnostics
      stream={{
        status: 'live',
        flow: {
          windows: {
            60: {
              available: true,
              buyBtc: 8,
              sellBtc: 2,
              imbalance: 0.6,
              tradeCount: 100,
            },
          },
        },
        liquidity: {
          depth: { 10: { bidBtc: 20, askBtc: 30, imbalance: -0.2 } },
          depthChange60: { available: true, totalFraction: -0.55 },
        },
      }}
      conditions={{
        available: true,
        riskFlags: [
          {
            code: 'current-price-jump',
            reason: 'Current price moved beyond the volatility guard.',
          },
        ],
      }}
      forecast={{
        aboveProbability: 0.56,
        pressure: {
          applied: true,
          adjustmentPercentagePoints: 5,
          impactSampleCount: 12,
          baselineAboveProbability: 0.5,
          unshiftedAboveProbability: 0.51,
        },
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Market detail' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('row', { name: '60s 8.000 2.000 60.0% 100' })).toBeInTheDocument();
  expect(dialog.getByRole('row', { name: '10 bps 20.000 30.000 -20.0%' })).toBeInTheDocument();
  expect(dialog.getByText(/60s depth change: -55.0%/)).toBeInTheDocument();
  expect(dialog.getByText('Current price moved beyond the volatility guard.')).toBeInTheDocument();
  expect(dialog.getByRole('heading', { name: 'Pressure in the live calculation' })).toBeVisible();
  expect(
    dialog.getByText(/Trade pressure changes Above by 5.00 percentage points/),
  ).toHaveTextContent('12 completed 15-second samples');
  expect(dialog.getByText(/not a measured improvement in accuracy/)).toHaveTextContent(
    'Current Above: 56.0%',
  );
  expect(dialog.getByText(/not a measured improvement in accuracy/)).toHaveTextContent(
    'Price-only Above: 51.0%',
  );
  expect(dialog.getByText(/not automatic vetoes/)).toHaveTextContent(
    'probabilities remain uncalibrated',
  );
});

test('market detail explains price-only fallback without displaying a fabricated pressure adjustment', async () => {
  const user = userEvent.setup();
  render(
    <MarketDiagnostics
      stream={{ status: 'warming' }}
      forecast={{
        aboveProbability: 0.51,
        pressure: {
          applied: false,
          reason: 'Using price-only probabilities while verified pressure data builds.',
          baselineAboveProbability: 0.52,
          unshiftedAboveProbability: 0.51,
        },
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Market detail' }));
  const dialog = within(screen.getByRole('dialog'));
  expect(
    dialog.getByText(/Using price-only probabilities while verified pressure data builds/),
  ).toBeVisible();
  expect(dialog.queryByText(/Trade pressure changes Above by/)).not.toBeInTheDocument();
  expect(
    dialog.getByText(/experimental adjustment, not a measured improvement in accuracy/),
  ).toHaveTextContent('Current Above: 51.0%');
});
