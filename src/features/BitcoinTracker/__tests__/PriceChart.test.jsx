import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PriceChart from '../components/PriceChart';
import { getChartPoints, formatChartTooltip, getPriceChartOption } from '../utils/priceChart.utils';
import { formatDateTime, formatPrice } from '../utils/format.utils';

let mockChartProps;
const mockDispatchAction = jest.fn();

jest.mock('echarts-for-react/lib/core', () => {
  const React = require('react');
  return React.forwardRef(function ChartRenderer(props, ref) {
    mockChartProps = props;
    React.useImperativeHandle(ref, () => ({
      getEchartsInstance: () => ({ dispatchAction: mockDispatchAction }),
    }));
    return <div data-testid="chart-renderer" />;
  });
});
jest.mock('echarts/core', () => ({ use: jest.fn() }));
jest.mock('echarts/charts', () => ({ LineChart: {} }));
jest.mock('echarts/components', () => ({
  GridComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
jest.mock('echarts/renderers', () => ({ SVGRenderer: {} }));

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

const defaults = { candles, ticker, forecast, target: 50_000, now: NOW, horizonMinutes: 15 };
const getSeries = (id) => mockChartProps.option.series.find((series) => series.id === id);

describe('PriceChart', () => {
  test.each([0.002, -0.002])(
    'shows a shifted forecast range at the deadline (%s)',
    (locationLogReturn) => {
      const shifted = {
        ...forecast,
        locationLogReturn,
        pressure: { applied: false },
        lowerBound: ticker.price * Math.exp(locationLogReturn - 1.2815515655 * forecast.volatility),
        upperBound: ticker.price * Math.exp(locationLogReturn + 1.2815515655 * forecast.volatility),
      };
      render(<PriceChart {...defaults} forecast={shifted} />);
      const range = getSeries('model-range').data;
      expect(range[0].lower).toBe(ticker.price);
      expect(range[0].upper).toBe(ticker.price);
      expect(range.at(-1).lower).toBeCloseTo(shifted.lowerBound, 6);
      expect(range.at(-1).upper).toBeCloseTo(shifted.upperBound, 6);
      expect(range.at(-1).value[0]).toBe(NOW + 15 * MINUTE);
    },
  );

  test('ends the live model interval at the selected deadline while observed data ends at now', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    expect(mockChartProps.option.xAxis.max).toBe(NOW + 15 * MINUTE);
    expect(getSeries('model-range').data.at(-1).value[0]).toBe(NOW + 15 * MINUTE);
    expect(screen.getByRole('img')).toHaveAccessibleName(/15:00 remaining/);
    expect(screen.getByRole('img')).toHaveAccessibleName(/not the recorded prediction/);

    rerender(<PriceChart {...defaults} horizonMinutes={12} />);
    expect(mockChartProps.option.xAxis.max).toBe(NOW + 12 * MINUTE);
    expect(getSeries('model-range').data.at(-1).value[0]).toBe(NOW + 12 * MINUTE);
    expect(getSeries('observed-price').data.every((point) => point.value[0] <= NOW)).toBe(true);
    expect(screen.getByRole('img')).toHaveAccessibleName(/12:00 remaining/);
    expect(screen.getByText('End')).toBeInTheDocument();
    expect(screen.queryByText('+15m')).not.toBeInTheDocument();
  });

  test('keeps a fifteen-minute preview for a future window more than fifteen minutes away', () => {
    render(<PriceChart {...defaults} horizonMinutes={30} />);
    expect(mockChartProps.option.xAxis.max).toBe(NOW + 15 * MINUTE);
    expect(screen.getByRole('img')).toHaveAccessibleName(/15:00 remaining/);
    expect(screen.getByText('+15m')).toBeInTheDocument();
  });

  test.each([0, -1, NaN, Infinity])(
    'removes the forward interval for an expired or invalid horizon %s',
    (horizonMinutes) => {
      render(<PriceChart {...defaults} horizonMinutes={horizonMinutes} />);
      expect(mockChartProps.option.xAxis.max).toBe(NOW);
      expect(getSeries('model-range')).toBeUndefined();
      expect(getSeries('observed-price').markArea.data).toEqual([]);
      expect(screen.getByRole('img')).toHaveAccessibleName(
        /live model range is currently unavailable/,
      );
      expect(screen.queryByText('Live model 80% range')).not.toBeInTheDocument();
      expect(screen.queryByText('End')).not.toBeInTheDocument();
    },
  );

  test('retains the deadline but removes model values when market data becomes unavailable', () => {
    const { rerender } = render(<PriceChart {...defaults} horizonMinutes={12} />);
    rerender(<PriceChart {...defaults} horizonMinutes={12} forecast={{ available: false }} />);
    expect(mockChartProps.option.xAxis.max).toBe(NOW + 12 * MINUTE);
    expect(getSeries('model-range')).toBeUndefined();
    expect(screen.getByText('End')).toBeInTheDocument();
    expect(screen.queryByText('Live model 80% range')).not.toBeInTheDocument();
  });

  test('changes history without resetting the selected deadline', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} horizonMinutes={12} />);
    await user.click(screen.getByRole('button', { name: '30m' }));
    expect(mockChartProps.option.xAxis.min).toBe(NOW - 30 * MINUTE);
    expect(mockChartProps.option.xAxis.max).toBe(NOW + 12 * MINUTE);
    expect(screen.getByRole('img')).toHaveAccessibleName(/last 30 minutes/);
    await user.click(screen.getByRole('button', { name: '2h' }));
    expect(mockChartProps.option.xAxis.min).toBe(NOW - 120 * MINUTE);
    expect(mockChartProps.option.xAxis.max).toBe(NOW + 12 * MINUTE);
  });

  test('exposes each exact observed price to the native keyboard slider and its chart tooltip', () => {
    render(<PriceChart {...defaults} />);
    const slider = screen.getByRole('slider', { name: 'Inspect historical price points' });
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Latest trade'));
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining(formatPrice(ticker.price)),
    );

    fireEvent.focus(slider);
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: Number(slider.max),
    });
    fireEvent.change(slider, { target: { value: '0' } });
    const firstPoint = getSeries('observed-price').data[0];
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining(formatDateTime(firstPoint.value[0])),
    );
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining(formatPrice(firstPoint.value[1])),
    );
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('One-minute close'));
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: 0,
    });
    fireEvent.blur(slider);
    expect(mockDispatchAction).toHaveBeenLastCalledWith({ type: 'hideTip' });
  });

  test('preserves the inspected observation when a newer trade arrives', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '2' } });
    const inspectedValue = slider.getAttribute('aria-valuetext');
    rerender(
      <PriceChart {...defaults} now={NOW + 5_000} ticker={{ time: NOW + 5_000, price: 50_100 }} />,
    );
    expect(slider).toHaveAttribute('aria-valuetext', inspectedValue);
  });

  test('waits for verified history instead of inventing chart points', () => {
    render(<PriceChart {...defaults} candles={[]} ticker={undefined} />);
    expect(screen.getByText('Waiting for verified price history…')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-renderer')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});

describe('observed chart data', () => {
  test('uses completed candle closes at their close times, excluding invalid and unfinished candles', () => {
    const points = getChartPoints(
      [
        { time: NOW, close: 55_000 },
        { time: NOW - 2 * MINUTE, close: 50_000 },
        { time: NOW - MINUTE, close: 50_020 },
        { time: NOW - 3 * MINUTE, close: NaN },
        { time: NOW - 4 * MINUTE, close: -1 },
      ],
      null,
      NOW - 60 * MINUTE,
      NOW,
    );
    expect(points).toEqual([
      { time: NOW - MINUTE, price: 50_000, source: 'One-minute close' },
      { time: NOW, price: 50_020, source: 'One-minute close' },
    ]);
  });

  test('preserves newer candles if the trade feed is delayed', () => {
    const points = getChartPoints(
      candles,
      { time: NOW - MINUTE, price: 1 },
      NOW - 60 * MINUTE,
      NOW,
    );
    expect(points.at(-1)).toEqual({
      time: NOW,
      price: candles.at(-1).close,
      source: 'One-minute close',
    });
    expect(points.some((point) => point.price === 1)).toBe(false);
  });

  test('replaces a coincident candle with the actual trade and labels its source', () => {
    const points = getChartPoints(candles, ticker, NOW - 60 * MINUTE, NOW);
    expect(points.filter((point) => point.time === NOW)).toEqual([
      { ...ticker, source: 'Latest trade' },
    ]);
  });

  test('ignores a future ticker timestamp', () => {
    const points = getChartPoints(candles, { time: NOW + 1, price: 1 }, NOW - 60 * MINUTE, NOW);
    expect(points.at(-1).source).toBe('One-minute close');
  });
});

describe('chart tooltips', () => {
  test.each(['One-minute close', 'Latest trade'])(
    'shows the exact timestamp and USD price for %s',
    (source) => {
      const tooltip = formatChartTooltip([
        { seriesId: 'observed-price', data: { value: [NOW, 50_123.45], source } },
      ]);
      expect(tooltip).toContain(formatDateTime(NOW));
      expect(tooltip).toContain('$50,123.45 USD');
      expect(tooltip).toContain(source);
      expect(tooltip).not.toContain('model');
    },
  );

  test('shows future bounds as a model range, never as an observed future price', () => {
    const tooltip = formatChartTooltip([
      { seriesId: 'model-base', data: [NOW + 12 * MINUTE, 49_900] },
      {
        seriesId: 'model-range',
        data: { value: [NOW + 12 * MINUTE, 200], lower: 49_900, upper: 50_100 },
      },
    ]);
    expect(tooltip).toContain(formatDateTime(NOW + 12 * MINUTE));
    expect(tooltip).toContain('$49,900.00–$50,100.00 USD');
    expect(tooltip).toContain('Live model 80% range');
    expect(tooltip).toContain('Model range only · no observed future price');
    expect(tooltip).not.toContain('One-minute close');
    expect(tooltip).not.toContain('Latest trade');
  });

  test('does not expose a stacked range offset as a Bitcoin price', () => {
    expect(formatChartTooltip([{ seriesId: 'model-base', data: [NOW, 49_900] }])).toBe('');
  });

  test('keeps target changes separate from observed prices', () => {
    const points = getChartPoints(candles, ticker, NOW - 60 * MINUTE, NOW);
    const options = {
      points,
      ticker,
      forecast,
      target: 50_010,
      startTime: NOW - 60 * MINUTE,
      endTime: NOW,
      futureMinutes: 12,
    };
    const first = getPriceChartOption(options);
    const second = getPriceChartOption({ ...options, target: 50_050 });
    expect(first.option.series[0].data).toEqual(second.option.series[0].data);
    expect(second.option.series[0].markLine.data.find((line) => line.yAxis)).toMatchObject({
      yAxis: 50_050,
    });
  });
});
