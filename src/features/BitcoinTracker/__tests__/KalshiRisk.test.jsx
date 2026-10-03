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
  test.each([
    [49_999.994, 'below', 'above', 0.4],
    [49_999.999, 'above', 'below', 0.6],
    [50_000, 'above', 'below', 0.6],
    [50_000.001, 'above', 'below', 0.6],
    [50_000.006, 'above', 'below', 0.6],
    [49_990, 'below', 'above', 0.4],
    [50_010, 'above', 'below', 0.6],
  ])(
    'cent-rounded reference %s identifies %s without changing stored-call loss risk',
    (price, currentSide, oppositeSide, flipProbability) => {
      const input = inputs();
      input.forecast.kalshi.referencePrice = price;
      expect(getReversalRisk(input)).toMatchObject({
        available: true,
        referencePrice: price,
        currentSide,
        oppositeSide,
        currentSideFlipProbability: flipProbability,
        fixedFailureSide: 'below',
        fixedFailureProbability: 0.6,
        isAgainstFixedCall: currentSide === 'below',
      });
      input.fixedForecast.direction = 'below';
      expect(getReversalRisk(input)).toMatchObject({
        currentSide,
        oppositeSide,
        currentSideFlipProbability: flipProbability,
        fixedFailureSide: 'above',
        fixedFailureProbability: 0.4,
        isAgainstFixedCall: currentSide === 'above',
      });
    },
  );

  test.each([
    [49_999.999, 'below', 'above', 0.4],
    [50_000, 'at', null, null],
    [50_000.001, 'above', 'below', 0.6],
  ])(
    'non-Kalshi reference %s keeps raw-price and exact-tie behavior',
    (price, currentSide, oppositeSide, flipProbability) => {
      const input = inputs();
      delete input.fixedForecast.outcomeDefinition;
      delete input.forecast.outcomeDefinition;
      input.ticker.price = price;
      expect(getReversalRisk(input)).toMatchObject({
        available: true,
        currentSide,
        oppositeSide,
        currentSideFlipProbability: flipProbability,
        fixedFailureProbability: 0.6,
      });
    },
  );

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

  test.each([49_999.999, 50_000])(
    'risk copy keeps a reference rounding to the target (%s) on the Yes side',
    async (price) => {
      const user = userEvent.setup();
      const input = inputs();
      input.forecast.kalshi.referencePrice = price;
      render(<ForecastRisk {...input} />);
      await user.click(screen.getByRole('button', { name: /view estimated deadline risk/ }));
      const dialog = within(screen.getByRole('dialog', { name: 'Deadline and reversal risk' }));
      expect(dialog.getByText(/Current BRTI benchmark/)).toHaveTextContent(
        '$50,000.00 is at or above the saved target after rounding to cents.',
      );
      expect(dialog.queryByText(/there is no current side to flip from/)).not.toBeInTheDocument();
      expect(dialog.queryByText(/side opposite the fixed call/)).not.toBeInTheDocument();
      expect(
        dialog.getByText(
          (_, element) =>
            element.tagName === 'P' &&
            element.textContent.includes(
              '60.0% estimated chance of settling No, opposite the current reference price side.',
            ),
        ),
      ).toBeVisible();
    },
  );

  test('risk copy distinguishes current BRTI from the final average and explains Kalshi equality', async () => {
    const user = userEvent.setup();
    render(<ForecastRisk {...inputs()} />);
    const button = screen.getByRole('button', {
      name: 'Fixed loss risk · 60.0%, view estimated deadline risk',
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

  test('does not show fixed-loss changes for a different Kalshi contract', async () => {
    const user = userEvent.setup();
    const input = inputs();
    input.fixedForecast = { ...input.fixedForecast, aboveProbability: 0.7, belowProbability: 0.3 };
    input.forecast.kalshi.marketTicker = 'KXBTC15M-OTHER';
    render(<ForecastRisk {...input} />);
    const button = screen.getByRole('button', {
      name: 'Forecast risk, view estimated deadline risk',
    });
    expect(button).not.toHaveTextContent('pp');
    await user.click(button);
    expect(screen.getByText(/Waiting for an estimate for the same saved contract/)).toBeVisible();
    expect(screen.queryByText(/Saved loss risk/)).not.toBeInTheDocument();
  });
});
