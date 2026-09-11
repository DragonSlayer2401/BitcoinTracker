import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForecastRisk from '../components/ForecastRisk';
import { getReversalRisk } from '../utils/reversalRisk.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const START = Date.UTC(2026, 8, 10, 12);
const NOW = START + 180_000;
const END = START + 900_000;

function inputs() {
  const kalshiMarket = {
    ticker: 'KXBTC15M-26SEP101215-15',
    eventTicker: 'KXBTC15M-26SEP101215',
    seriesTicker: 'KXBTC15M',
    target: 50_000,
    startsAt: START,
    expiresAt: END,
    rulesVerified: true,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  return {
    now: NOW,
    ticker: { price: 50_010, time: NOW, receivedAt: NOW },
    fixedForecast: {
      id: 'kalshi-risk',
      status: 'pending',
      direction: 'above',
      target: 50_000,
      expiresAt: END,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      kalshiMarket,
    },
    forecast: {
      available: true,
      target: 50_000,
      expiresAt: END,
      aboveProbability: 0.4,
      belowProbability: 0.6,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      kalshi: {
        marketTicker: kalshiMarket.ticker,
        referencePrice: 49_990,
        referenceAt: NOW,
        referenceSource: 'cf-brti',
      },
    },
  };
}

describe('Kalshi reversal reference', () => {
  test('uses the actual BRTI side when Coinbase is on the opposite side of the target', () => {
    expect(getReversalRisk(inputs())).toMatchObject({
      available: true,
      currentSide: 'below',
      oppositeSide: 'above',
      referenceSource: 'cf-brti',
      referencePrice: 49_990,
      currentSideFlipProbability: 0.4,
      fixedFailureProbability: 0.6,
      isAgainstFixedCall: true,
    });
  });

  test('uses and identifies the explicit proxy anchor when the benchmark is unavailable', () => {
    const input = inputs();
    input.forecast.kalshi = {
      ...input.forecast.kalshi,
      referenceSource: 'coinbase-proxy',
      referencePrice: 50_005,
    };
    expect(getReversalRisk(input)).toMatchObject({
      available: true,
      currentSide: 'above',
      referenceLabel: 'Current Coinbase proxy',
      currentSideFlipProbability: 0.6,
      isAgainstFixedCall: false,
    });
  });

  test.each([
    { outcomeDefinition: 'coinbase-last-trade-at-deadline-v1' },
    { outcomeDefinition: undefined },
    { kalshi: { ...inputs().forecast.kalshi, marketTicker: 'KXBTC15M-OTHER' } },
  ])(
    'rejects the same target and deadline with a different contract or settlement definition',
    (patch) => {
      const input = inputs();
      expect(
        getReversalRisk({ ...input, forecast: { ...input.forecast, ...patch } }),
      ).toMatchObject({
        available: false,
        currentSideFlipProbability: null,
        fixedFailureProbability: null,
      });
    },
  );

  test.each([
    { referencePrice: NaN },
    { referenceAt: NOW - 5001 },
    { referenceAt: NOW + 5001 },
    { referenceSource: 'unknown' },
  ])('does not disguise an invalid reference as a Coinbase risk estimate', (patch) => {
    const input = inputs();
    input.forecast.kalshi = { ...input.forecast.kalshi, ...patch };
    expect(getReversalRisk(input).available).toBe(false);
  });

  test('allows the calculation timestamp to lead the rendered clock by a few milliseconds', () => {
    const input = inputs();
    input.forecast.kalshi.referenceAt = NOW + 10;
    expect(getReversalRisk(input).available).toBe(true);
  });

  test('risk copy distinguishes current BRTI from the final average and explains Kalshi equality', async () => {
    const user = userEvent.setup();
    render(<ForecastRisk {...inputs()} />);
    const button = screen.getByRole('button', {
      name: 'Fixed-call risk · 60.0%, view estimated deadline risk',
    });
    await user.click(button);
    const dialog = within(screen.getByRole('dialog', { name: 'Deadline and reversal risk' }));
    expect(dialog.getByText(/Current BRTI benchmark/)).toHaveTextContent(
      '$49,990.00 is below the saved target',
    );
    expect(dialog.getByText(/rounded final-minute BRTI average/)).toBeVisible();
    expect(
      dialog.getByText(/A settlement average that rounds to the target counts as Yes/),
    ).toBeVisible();
    expect(
      dialog.getByText(
        (_, element) =>
          element.tagName === 'P' &&
          element.textContent.includes('60.0% estimated chance of settling No'),
      ),
    ).toBeVisible();
    expect(
      dialog.getByText(
        (_, element) =>
          element.tagName === 'P' &&
          element.textContent.includes('40.0% estimated chance of settling Yes'),
      ),
    ).toBeVisible();
    expect(dialog.queryByText(/Currently above the saved target/)).not.toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Close forecast risk' }));
    expect(button).toHaveFocus();
  });
});
