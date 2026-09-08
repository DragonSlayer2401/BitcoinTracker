import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PriceChart from '../components/PriceChart';

const NOW = Date.UTC(2026, 8, 8, 12, 0);
const MINUTE = 60_000;
const candles = Array.from({ length: 120 }, (_, index) => ({
  time: NOW - (120 - index) * MINUTE,
  close: 50_000 + (index % 4) * 20,
}));
const ticker = { time: NOW, price: 50_000 };
const forecast = {
  available: true,
  volatility: 0.004,
  lowerBound: 50_000 * Math.exp(-1.2815515655 * 0.004),
  upperBound: 50_000 * Math.exp(1.2815515655 * 0.004),
};

function getIntervalTimePositions() {
  const interval = screen.getByText('Model interval endpoint').parentElement;
  return [...interval.getAttribute('d').matchAll(/[ML]([\d.]+),/g)].map((match) =>
    Number(match[1]),
  );
}

describe('PriceChart forecast horizon', () => {
  test('fits a shorter interval to the selected end instead of extending another fifteen minutes', () => {
    const { rerender } = render(
      <PriceChart
        candles={candles}
        ticker={ticker}
        forecast={forecast}
        target={50_000}
        now={NOW}
        horizonMinutes={15}
      />,
    );
    const fullWindowPositions = getIntervalTimePositions();
    expect(screen.getByText('+15m')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/15:00 remaining/);

    rerender(
      <PriceChart
        candles={candles}
        ticker={ticker}
        forecast={forecast}
        target={50_000}
        now={NOW}
        horizonMinutes={12}
      />,
    );
    const shorterWindowPositions = getIntervalTimePositions();

    expect(screen.getByText('End')).toBeInTheDocument();
    expect(screen.queryByText('+15m')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/12:00 remaining/);
    // The shorter future occupies less time-axis space but still ends at the same chart boundary.
    expect(shorterWindowPositions[0]).toBeGreaterThan(fullWindowPositions[0]);
    expect(Math.max(...shorterWindowPositions)).toBeCloseTo(Math.max(...fullWindowPositions));
  });

  test('keeps a fifteen-minute preview for a future window more than fifteen minutes away', () => {
    render(
      <PriceChart
        candles={candles}
        ticker={ticker}
        forecast={forecast}
        target={50_000}
        now={NOW}
        horizonMinutes={30}
      />,
    );

    expect(screen.getByText('+15m')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/15:00 remaining/);
    expect(screen.getByText('Model interval endpoint')).toBeInTheDocument();
  });

  test.each([0, -1, NaN, Infinity])(
    'omits the future interval and endpoint for an expired or invalid horizon %s',
    (horizonMinutes) => {
      render(
        <PriceChart
          candles={candles}
          ticker={ticker}
          forecast={forecast}
          target={50_000}
          now={NOW}
          horizonMinutes={horizonMinutes}
        />,
      );

      expect(screen.getByRole('img')).toHaveAccessibleName(
        /Bitcoin price over the last 60 minutes/,
      );
      expect(screen.getByRole('img')).toHaveAccessibleName(/forecast is currently unavailable/);
      expect(screen.queryByText('Model interval endpoint')).not.toBeInTheDocument();
      expect(screen.queryByText('Model 80% range')).not.toBeInTheDocument();
      expect(screen.queryByText('End')).not.toBeInTheDocument();
      expect(screen.queryByText('+15m')).not.toBeInTheDocument();
    },
  );

  test('retains the selected window endpoint while unavailable market data hides the model range', () => {
    render(
      <PriceChart
        candles={candles}
        ticker={ticker}
        forecast={{ available: false }}
        target={50_000}
        now={NOW}
        horizonMinutes={12}
      />,
    );

    expect(screen.getByText('End')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/forecast is currently unavailable/);
    expect(screen.queryByText('Model interval endpoint')).not.toBeInTheDocument();
    expect(screen.queryByText('Model 80% range')).not.toBeInTheDocument();
  });

  test('changes displayed history without resetting the remaining forecast horizon', async () => {
    const user = userEvent.setup();
    render(
      <PriceChart
        candles={candles}
        ticker={ticker}
        forecast={forecast}
        target={50_000}
        now={NOW}
        horizonMinutes={12}
      />,
    );
    await user.click(screen.getByRole('button', { name: '30m' }));

    expect(screen.getByRole('img')).toHaveAccessibleName(/Bitcoin price over the last 30 minutes/);
    expect(screen.getByRole('img')).toHaveAccessibleName(/12:00 remaining/);
    expect(screen.getByText('End')).toBeInTheDocument();
  });
});
