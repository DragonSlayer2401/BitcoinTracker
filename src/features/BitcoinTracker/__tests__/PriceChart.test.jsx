import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PriceChart from '../components/PriceChart';
import {
  getObservedLineData,
  formatChartTooltip,
  getPriceChartOption,
  getChartZoomRange,
} from '../utils/priceChart.utils';
import { getBenchmarkChartData, getBenchmarkSettlement } from '../utils/benchmarkChart.utils';
import { formatDateTime, formatPrice } from '../utils/format.utils';
import { useGetBenchmarkHistoryQuery } from '../../../services/kalshi/benchmarkHistory/benchmarkHistory.api';

let mockChartProps;
const mockDispatchAction = jest.fn();
const mockRefetchHistory = jest.fn();

jest.mock('../../../services/kalshi/benchmarkHistory/benchmarkHistory.api', () => ({
  useGetBenchmarkHistoryQuery: jest.fn(),
}));

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
jest.mock('echarts/charts', () => ({ LineChart: {}, CandlestickChart: {} }));
jest.mock('echarts/components', () => ({
  DataZoomInsideComponent: {},
  GridComponent: {},
  MarkAreaComponent: {},
  MarkLineComponent: {},
  TooltipComponent: {},
}));
jest.mock('echarts/renderers', () => ({ SVGRenderer: {} }));

const NOW = Date.UTC(2026, 8, 13, 12, 0);
const MINUTE = 60_000;
const DEADLINE = NOW + 12 * MINUTE;
const readings = Array.from({ length: 3600 }, (_, index) => ({
  time: NOW - (3599 - index) * 1000,
  price: 50_000 + (index % 4) * 20,
}));
const makeData = (samples = readings, now = NOW, available = true) =>
  getBenchmarkChartData({ available, samples }, now);
const benchmarkData = makeData();
const forecast = {
  available: true,
  expiresAt: DEADLINE,
  lowerBound: null,
  upperBound: null,
  kalshi: { settlementLowerBound: 49_925.42, settlementUpperBound: 50_075.83 },
};
const defaults = { benchmarkData, forecast, target: 50_000, now: NOW, deadline: DEADLINE };
const getSeries = (id) => mockChartProps.option.series.find((series) => series.id === id);
const getZoom = () => mockChartProps.option.dataZoom.find((item) => item.id === 'time-zoom');
const applyChartGesture = (range) => {
  act(() => {
    mockChartProps.onEvents.datazoom(
      { batch: [{ start: 10, end: 90 }] },
      {
        getOption: () => ({
          dataZoom: [
            { id: 'unrelated', startValue: 0, endValue: 1 },
            { id: 'time-zoom', start: 25, end: 75, ...range },
          ],
        }),
      },
    );
  });
};
const optionsFor = (overrides = {}) => ({
  readings,
  candles: benchmarkData.candles,
  view: 'line',
  forecast,
  target: 50_000,
  startTime: NOW - 60 * MINUTE,
  endTime: NOW,
  deadline: DEADLINE,
  settlement: getBenchmarkSettlement(readings, DEADLINE, NOW),
  ...overrides,
});

beforeEach(() => {
  mockDispatchAction.mockClear();
  mockRefetchHistory.mockReset();
  useGetBenchmarkHistoryQuery.mockReset();
  useGetBenchmarkHistoryQuery.mockReturnValue({
    currentData: undefined,
    isFetching: false,
    isError: false,
    refetch: mockRefetchHistory,
  });
});

describe('BRTI price chart', () => {
  test('charts original BRTI readings instead of Coinbase candles or trades', () => {
    render(
      <PriceChart
        {...defaults}
        candles={[{ time: NOW, close: 1 }]}
        ticker={{ time: NOW, price: 1 }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'BRTI price activity' })).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/Bitcoin BRTI price/);
    const data = getSeries('observed-price').data;
    expect(data.map((point) => point.value)).toEqual(
      readings.map((point) => [point.time, point.price]),
    );
    expect(screen.queryByText(/Coinbase|Latest trade|One-minute closes/)).not.toBeInTheDocument();
  });

  test('displays only the supplied settlement interval at the actual deadline', () => {
    render(<PriceChart {...defaults} />);
    const range = getSeries('model-range').data;
    expect(range.map((point) => point.value)).toEqual([
      [DEADLINE, forecast.kalshi.settlementLowerBound],
      [DEADLINE, forecast.kalshi.settlementUpperBound],
    ]);
    expect(getSeries('model-base')).toBeUndefined();
    expect(screen.getByRole('img')).toHaveAccessibleName(/12:00 remaining/);
    expect(screen.getByRole('img')).toHaveAccessibleName(/not the recorded prediction/);
    expect(screen.getByRole('img')).toHaveAccessibleName(/settlement-average range/);
    expect(mockChartProps.option.xAxis.max).toBe(DEADLINE);
  });

  test('uses a selected deadline more than fifteen minutes away without clamping it', () => {
    const deadline = NOW + 30 * MINUTE;
    render(
      <PriceChart
        {...defaults}
        deadline={deadline}
        forecast={{ ...forecast, expiresAt: deadline }}
      />,
    );
    expect(mockChartProps.option.xAxis.max).toBe(deadline);
    expect(getSeries('model-range').data.every((point) => point.value[0] === deadline)).toBe(true);
    expect(screen.getByRole('img')).toHaveAccessibleName(/30:00 remaining/);
    expect(getSeries('observed-price').markArea.data).toEqual([
      [{ xAxis: deadline - MINUTE }, { xAxis: deadline }],
    ]);
  });

  test.each([
    ['expired', { deadline: NOW }],
    ['invalid deadline', { deadline: NaN }],
    ['different forecast event', { forecast: { ...forecast, expiresAt: DEADLINE + MINUTE } }],
    ['unavailable model', { forecast: { ...forecast, available: false } }],
    [
      'learned probabilities without an interval model',
      { forecast: { ...forecast, learning: { applied: true } } },
    ],
    [
      'legacy spot bounds',
      { forecast: { ...forecast, lowerBound: 49_000, upperBound: 51_000, kalshi: {} } },
    ],
    [
      'reversed bounds',
      {
        forecast: {
          ...forecast,
          kalshi: { settlementLowerBound: 50_100, settlementUpperBound: 50_000 },
        },
      },
    ],
  ])('withholds an invalid settlement interval: %s', (_, override) => {
    render(<PriceChart {...defaults} {...override} />);
    expect(getSeries('model-range')).toBeUndefined();
    expect(screen.getByRole('img')).toHaveAccessibleName(
      /live model range is currently unavailable/,
    );
    expect(screen.queryByText('80% settlement range')).not.toBeInTheDocument();
  });

  test('changes history without resetting the selected deadline', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 1, endingAt: 0 },
      expect.objectContaining({ skip: true }),
    );
    await user.click(screen.getByRole('button', { name: '15m' }));
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 0.25, endingAt: 0 },
      expect.objectContaining({ skip: true }),
    );
    expect(mockChartProps.option.xAxis.min).toBe(NOW - 15 * MINUTE);
    expect(mockChartProps.option.xAxis.max).toBe(DEADLINE);
    expect(screen.getByRole('img')).toHaveAccessibleName(/last 15 minutes/);
    await user.click(screen.getByRole('button', { name: '30m' }));
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 0.5, endingAt: 0 },
      expect.objectContaining({ skip: true }),
    );
    expect(mockChartProps.option.xAxis.min).toBe(NOW - 30 * MINUTE);
    await user.click(screen.getByRole('button', { name: '1h' }));
    expect(mockChartProps.option.xAxis.min).toBe(NOW - 60 * MINUTE);
    expect(screen.getByRole('button', { name: '2h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4h' })).toBeInTheDocument();
  });

  test('supports line and candle views with OHLC values and observed coverage', async () => {
    const user = userEvent.setup();
    const partial = makeData(
      [...readings, { time: NOW + 1000, price: 50_200 }, { time: NOW + 2000, price: 50_100 }],
      NOW + 2000,
    );
    render(<PriceChart {...defaults} now={NOW + 2000} benchmarkData={partial} />);
    await user.click(screen.getByRole('button', { name: 'Candles' }));
    expect(screen.getByRole('button', { name: 'Candles' })).toHaveAttribute('aria-pressed', 'true');
    const series = getSeries('observed-candles');
    const candle = partial.candles.at(-1);
    expect(series.data.at(-1).value).toEqual([candle.time, 50_200, 50_100, 50_100, 50_200]);
    expect(series.encode).toEqual({ x: 'time', y: ['open', 'close', 'low', 'high'] });
    const slider = screen.getByRole('slider', { name: 'Inspect BRTI candles' });
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('2/60 BRTI samples'));
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Partial candle'));
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('Open $50,200.00'));
    expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('close $50,100.00'));
    const readout = screen.getByRole('status', { name: /Open \$50,200\.00/ });
    expect(readout).toHaveTextContent('$50,100.00 · Partial candle');
    expect(readout).toHaveAttribute('title', expect.stringContaining('2/60 BRTI samples'));
    fireEvent.focus(slider);
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: series.data.length - 1,
    });
    fireEvent.change(slider, { target: { value: '0' } });
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: 0,
    });
    await user.click(screen.getByRole('button', { name: 'Line' }));
    expect(getSeries('observed-price')).toBeDefined();
    expect(getSeries('observed-candles')).toBeUndefined();
  });

  test('keyboard inspection skips visual gap markers while opening the correct tooltip', () => {
    const samples = [readings.at(-6), readings.at(-5), readings.at(-1)];
    render(<PriceChart {...defaults} benchmarkData={makeData(samples)} />);
    const slider = screen.getByRole('slider', { name: 'Inspect historical BRTI readings' });
    expect(slider.max).toBe('2');
    expect(getSeries('observed-price').data[2].value[1]).toBeNull();
    fireEvent.focus(slider);
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: 3,
    });
    fireEvent.change(slider, { target: { value: '1' } });
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining(formatDateTime(samples[1].time)),
    );
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining(formatPrice(samples[1].price)),
    );
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: 1,
    });
    fireEvent.blur(slider);
    expect(mockDispatchAction).toHaveBeenLastCalledWith({ type: 'hideTip' });
  });

  test('preserves an inspected reading when the live index advances', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '20' } });
    const inspectedValue = slider.getAttribute('aria-valuetext');
    rerender(
      <PriceChart
        {...defaults}
        now={NOW + 1000}
        benchmarkData={makeData([...readings, { time: NOW + 1000, price: 50_100 }], NOW + 1000)}
      />,
    );
    expect(slider).toHaveAttribute('aria-valuetext', inspectedValue);
  });

  test('keeps stale BRTI history clearly labeled without substituting a spot quote', () => {
    render(
      <PriceChart
        {...defaults}
        benchmarkData={makeData(readings, NOW + 10_000, false)}
        now={NOW + 10_000}
      />,
    );
    expect(screen.getByText(/Stale history/)).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/history is not a live quote/);
    expect(getSeries('observed-price').data.at(-1).value).toEqual([NOW, readings.at(-1).price]);
  });

  test('waits for benchmark history instead of displaying a spot quote', () => {
    render(<PriceChart target={50_000} ticker={{ time: NOW, price: 1 }} />);
    expect(screen.getByText('Waiting for CF Benchmarks BRTI history…')).toBeInTheDocument();
    expect(screen.queryByTestId('chart-renderer')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  test('shows the developing observed final-minute average and incomplete sample count', () => {
    const deadline = NOW + 30_000;
    render(
      <PriceChart
        {...defaults}
        deadline={deadline}
        forecast={{ ...forecast, expiresAt: deadline }}
      />,
    );
    const average = getSeries('settlement-average');
    const expected = getBenchmarkSettlement(readings, deadline, NOW);
    expect(average.data.at(-1).value).toEqual([NOW, expected.average]);
    expect(average.data.at(-1).sampleCount).toBe(30);
    expect(screen.getByText(/Observed final-minute average/)).toHaveTextContent(
      formatPrice(expected.average),
    );
    expect(screen.getByText(/Official settlement is confirmed separately/)).toHaveTextContent(
      '30/60 samples · Incomplete',
    );
    expect(getSeries('observed-price').markArea.data).toEqual([
      [{ xAxis: deadline - MINUTE }, { xAxis: deadline }],
    ]);
  });
});

describe('BRTI chart zoom and pan', () => {
  test('supports keyboard zoom, bounded pan, zoom out and reset controls', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    const earlier = screen.getByRole('button', { name: 'Pan earlier' });
    const later = screen.getByRole('button', { name: 'Pan later' });
    const reset = screen.getByRole('button', { name: 'Reset zoom' });
    expect(zoomIn).toBeEnabled();
    [zoomOut, earlier, later, reset].forEach((button) => expect(button).toBeDisabled());

    zoomIn.focus();
    await user.keyboard('{Enter}');
    expect(getZoom()).toMatchObject({
      startValue: NOW - 42 * MINUTE,
      endValue: NOW - 6 * MINUTE,
    });
    expect(screen.getByRole('img')).toHaveAccessibleName(
      expect.stringContaining(formatDateTime(NOW - 42 * MINUTE)),
    );
    await user.click(earlier);
    expect(getZoom()).toMatchObject({
      startValue: NOW - 60 * MINUTE,
      endValue: NOW - 24 * MINUTE,
    });
    expect(earlier).toBeDisabled();
    await user.click(later);
    await user.click(later);
    expect(getZoom()).toMatchObject({
      startValue: NOW - 24 * MINUTE,
      endValue: DEADLINE,
    });
    expect(later).toBeDisabled();
    await user.click(zoomOut);
    expect(getZoom()).toMatchObject({ startValue: NOW - 60 * MINUTE, endValue: DEADLINE });
    expect(reset).toBeDisabled();
    await user.click(zoomIn);
    await user.click(reset);
    expect(getZoom()).toMatchObject({ startValue: NOW - 60 * MINUTE, endValue: DEADLINE });
    expect(reset).toBeDisabled();
  });

  test('stops zooming in at a one-minute view', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    for (let index = 0; index < 8; index += 1) await user.click(zoomIn);
    expect(getZoom().endValue - getZoom().startValue).toBe(MINUTE);
    expect(zoomIn).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(getZoom().endValue - getZoom().startValue).toBe(2 * MINUTE);
    expect(zoomIn).toBeEnabled();
  });

  test('uses gesture timestamps from the matching chart control and retains them during live updates', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 10 * MINUTE };
    applyChartGesture(selectedRange);
    expect(getZoom()).toMatchObject(selectedRange);
    const visiblePointCount = Number(screen.getByRole('slider').max) + 1;
    expect(visiblePointCount).toBe(601);
    rerender(
      <PriceChart
        {...defaults}
        now={NOW + 5000}
        benchmarkData={makeData([...readings, { time: NOW + 5000, price: 50_100 }], NOW + 5000)}
      />,
    );
    expect(getZoom()).toMatchObject(selectedRange);
    expect(Number(screen.getByRole('slider').max) + 1).toBe(visiblePointCount);
  });

  test('a full-range gesture resumes following the moving live chart bounds', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    applyChartGesture({ startValue: NOW - 20 * MINUTE, endValue: NOW - 10 * MINUTE });
    applyChartGesture({
      start: 0,
      end: 100,
      startValue: NOW - 60 * MINUTE,
      endValue: DEADLINE,
    });
    rerender(<PriceChart {...defaults} now={NOW + 1000} />);
    expect(getZoom()).toMatchObject({
      startValue: NOW + 1000 - 60 * MINUTE,
      endValue: DEADLINE,
    });
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
  });

  test('ignores malformed gesture ranges without losing the selected section', () => {
    render(<PriceChart {...defaults} />);
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 10 * MINUTE };
    applyChartGesture(selectedRange);
    applyChartGesture({ startValue: NaN, endValue: NOW });
    expect(getZoom()).toMatchObject(selectedRange);
  });

  test('keeps the selected duration when older data ages out of the loaded window', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    applyChartGesture({ startValue: NOW - 60 * MINUTE, endValue: NOW - 58 * MINUTE });
    rerender(<PriceChart {...defaults} now={NOW + 3 * MINUTE} />);
    expect(getZoom()).toMatchObject({
      startValue: NOW - 57 * MINUTE,
      endValue: NOW - 55 * MINUTE,
    });
    expect(screen.getByRole('button', { name: 'Pan earlier' })).toBeDisabled();
  });

  test('preserves zoom across chart views and resets it for a different history duration', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 10 * MINUTE };
    applyChartGesture(selectedRange);
    await user.click(screen.getByRole('button', { name: 'Candles' }));
    expect(getZoom()).toMatchObject(selectedRange);
    const slider = screen.getByRole('slider', { name: 'Inspect BRTI candles' });
    expect(slider.max).toBe('10');
    fireEvent.change(slider, { target: { value: '0' } });
    const firstVisibleCandleIndex = getSeries('observed-candles').data.findIndex(
      (point) => point.value[0] === selectedRange.startValue,
    );
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: firstVisibleCandleIndex,
    });
    await user.click(screen.getByRole('button', { name: 'Line' }));
    expect(getZoom()).toMatchObject(selectedRange);
    await user.click(screen.getByRole('button', { name: '2h' }));
    expect(getZoom()).toMatchObject({ startValue: NOW - 120 * MINUTE, endValue: DEADLINE });
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
  });

  test('keyboard inspection skips off-screen points and gap markers while preserving raw tooltip indexes', () => {
    const samples = [
      { time: NOW - 5 * MINUTE, price: 49_800 },
      { time: NOW - 2 * MINUTE, price: 49_900 },
      { time: NOW - 2 * MINUTE + 1000, price: 50_000 },
      { time: NOW - 2 * MINUTE + 5000, price: 50_100 },
      { time: NOW, price: 50_200 },
    ];
    render(<PriceChart {...defaults} benchmarkData={makeData(samples)} />);
    applyChartGesture({ startValue: NOW - 2 * MINUTE, endValue: NOW - MINUTE });
    const slider = screen.getByRole('slider', { name: 'Inspect historical BRTI readings' });
    expect(slider.max).toBe('2');
    fireEvent.focus(slider);
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: 5,
    });
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining(formatDateTime(samples[1].time)),
    );
    expect(mockDispatchAction).toHaveBeenLastCalledWith({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: 2,
    });
    expect(getSeries('observed-price').data[2].value).toEqual([samples[1].time, samples[1].price]);
  });

  test('a zoomed gap retains the chart and recovery controls without inventing inspectable readings', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    applyChartGesture({ startValue: NOW + MINUTE, endValue: NOW + 2 * MINUTE });
    expect(screen.getByTestId('chart-renderer')).toBeInTheDocument();
    expect(screen.getByText('No observed readings in this zoomed section.')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pan earlier' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(
      screen.queryByText('No observed readings in this zoomed section.'),
    ).not.toBeInTheDocument();
  });
});

describe('chart zoom ranges and price scale', () => {
  test.each([
    ['no selection', null],
    ['nonfinite timestamps', { startTime: NaN, endTime: NOW }],
    ['reversed timestamps', { startTime: NOW, endTime: NOW - MINUTE }],
    ['zero duration', { startTime: NOW, endTime: NOW }],
  ])('uses the full range for %s', (_, range) => {
    expect(getChartZoomRange(range, NOW - 60 * MINUTE, DEADLINE)).toEqual({
      startTime: NOW - 60 * MINUTE,
      endTime: DEADLINE,
    });
  });

  test('bounds an oversized selection to the chart and expands a tiny selection to one minute', () => {
    expect(
      getChartZoomRange(
        { startTime: NOW - 120 * MINUTE, endTime: DEADLINE + MINUTE },
        NOW - 60 * MINUTE,
        DEADLINE,
      ),
    ).toEqual({ startTime: NOW - 60 * MINUTE, endTime: DEADLINE });
    const tiny = getChartZoomRange(
      { startTime: NOW - 1000, endTime: NOW + 1000 },
      NOW - 60 * MINUTE,
      DEADLINE,
    );
    expect(tiny).toEqual({ startTime: NOW - 30_000, endTime: NOW + 30_000 });
    expect(getChartZoomRange(tiny, NOW, NOW + 10_000)).toEqual({
      startTime: NOW,
      endTime: NOW + 10_000,
    });
  });

  test('scales a historical zoom to visible prices without distant target, future range or old outliers', () => {
    const samples = [
      { time: NOW - 40 * MINUTE, price: 20_000 },
      { time: NOW - 20 * MINUTE, price: 49_990 },
      { time: NOW - 19 * MINUTE, price: 50_010 },
      { time: NOW, price: 90_000 },
    ];
    const options = optionsFor({
      readings: samples,
      target: 100_000,
      forecast: {
        ...forecast,
        kalshi: { settlementLowerBound: 99_000, settlementUpperBound: 101_000 },
      },
      settlement: { average: 150_000, points: [{ time: NOW, price: 150_000 }] },
    });
    const full = getPriceChartOption(options).option;
    const zoomed = getPriceChartOption({
      ...options,
      zoomRange: { startTime: NOW - 20 * MINUTE, endTime: NOW - 19 * MINUTE },
    }).option;
    expect(full.yAxis.min).toBeLessThan(20_000);
    expect(full.yAxis.max).toBeGreaterThan(150_000);
    expect(zoomed.yAxis.min).toBeGreaterThan(49_900);
    expect(zoomed.yAxis.min).toBeLessThan(49_990);
    expect(zoomed.yAxis.max).toBeGreaterThan(50_010);
    expect(zoomed.yAxis.max).toBeLessThan(50_100);
    expect(zoomed.series[0].data).toEqual(full.series[0].data);
  });

  test('includes visible candle extremes and settlement overlays in the price scale', () => {
    const zoomRange = { startTime: NOW - MINUTE, endTime: DEADLINE };
    const result = getPriceChartOption(
      optionsFor({
        view: 'candles',
        zoomRange,
        readings: [],
        candles: [
          { time: NOW - 30 * MINUTE, low: 1, high: 1_000_000 },
          { time: NOW - MINUTE, low: 49_000, high: 51_000 },
        ],
        forecast: {
          ...forecast,
          kalshi: { settlementLowerBound: 48_000, settlementUpperBound: 52_000 },
        },
        settlement: { points: [{ time: NOW, price: 53_000 }] },
      }),
    );
    expect(result.option.yAxis.min).toBeLessThan(48_000);
    expect(result.option.yAxis.min).toBeGreaterThan(40_000);
    expect(result.option.yAxis.max).toBeGreaterThan(53_000);
    expect(result.option.yAxis.max).toBeLessThan(60_000);
  });
});

describe('extended BRTI chart history', () => {
  const historyResult = (samples, extra = {}) => ({
    currentData: { samples, status: 'available', reason: null },
    isFetching: false,
    isError: false,
    refetch: mockRefetchHistory,
    ...extra,
  });

  test.each([2, 4])(
    'uses original older observations in the %sh line and candle views',
    async (hours) => {
      const user = userEvent.setup();
      const minuteStart = NOW - (hours * 60 - 10) * MINUTE;
      const historical = [
        { time: minuteStart + 1000, price: 49_900 },
        { time: minuteStart + 2000, price: 50_050 },
        { time: minuteStart + 3000, price: 49_800 },
      ];
      useGetBenchmarkHistoryQuery.mockReturnValue(
        historyResult([...historical, { time: NOW, price: 1 }]),
      );
      render(<PriceChart {...defaults} />);
      expect(getSeries('observed-price').data[0].value[0]).toBe(readings[0].time);

      await user.click(screen.getByRole('button', { name: `${hours}h` }));
      expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
        { hours, endingAt: NOW },
        expect.objectContaining({ skip: false }),
      );
      expect(mockChartProps.option.xAxis.min).toBe(NOW - hours * 60 * MINUTE);
      expect(mockChartProps.option.xAxis.max).toBe(DEADLINE);
      expect(screen.getByRole('img')).toHaveAccessibleName(
        new RegExp(`last ${hours * 60} minutes`),
      );
      const displayedReadings = getSeries('observed-price').data;
      expect(displayedReadings.slice(0, 3).map((point) => point.value)).toEqual(
        historical.map((point) => [point.time, point.price]),
      );
      expect(displayedReadings.at(-1).value).toEqual([NOW, readings.at(-1).price]);
      fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
      expect(screen.getByRole('slider')).toHaveAttribute(
        'aria-valuetext',
        expect.stringContaining(formatDateTime(historical[0].time)),
      );
      expect(screen.getByRole('slider')).toHaveAttribute(
        'aria-valuetext',
        expect.stringContaining('$49,900.00'),
      );

      await user.click(screen.getByRole('button', { name: 'Candles' }));
      const olderCandle = getSeries('observed-candles').data[0];
      expect(olderCandle.value).toEqual([minuteStart, 49_900, 49_800, 49_800, 50_050]);
      expect(olderCandle.candle).toMatchObject({
        firstSampleAt: historical[0].time,
        lastSampleAt: historical[2].time,
        sampleCount: 3,
        isPartial: true,
      });
      expect(getSeries('observed-candles').data.at(-1).candle.lastSampleAt).toBe(NOW);
    },
  );

  test('preserves live readings while older history loads or partially fails and supports retry', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PriceChart {...defaults} />);
    useGetBenchmarkHistoryQuery.mockReturnValue(
      historyResult([], {
        currentData: undefined,
        isFetching: true,
      }),
    );
    await user.click(screen.getByRole('button', { name: '2h' }));
    expect(screen.getByText('Loading older BRTI history…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
    expect(getSeries('observed-price').data.at(-1).value).toEqual([NOW, readings.at(-1).price]);

    const older = { time: NOW - 90 * MINUTE, price: 49_900 };
    useGetBenchmarkHistoryQuery.mockReturnValue(
      historyResult([], {
        currentData: {
          samples: [older],
          status: 'partial',
          reason: 'One historical hour is temporarily unavailable.',
        },
      }),
    );
    rerender(<PriceChart {...defaults} />);
    expect(screen.getByText('One historical hour is temporarily unavailable.')).toBeInTheDocument();
    expect(getSeries('observed-price').data[0].value).toEqual([older.time, older.price]);
    expect(getSeries('observed-price').data.at(-1).value).toEqual([NOW, readings.at(-1).price]);
    expect(screen.getByRole('img')).toHaveAccessibleName(/Live BRTI readings/);
    await user.click(screen.getByRole('button', { name: 'Retry history' }));
    expect(mockRefetchHistory).toHaveBeenCalledTimes(1);
  });

  test('an older-history request failure leaves the current chart and deadline intact', async () => {
    const user = userEvent.setup();
    useGetBenchmarkHistoryQuery.mockReturnValue(
      historyResult([], {
        currentData: undefined,
        isError: true,
      }),
    );
    render(<PriceChart {...defaults} />);
    expect(screen.queryByText(/Older BRTI history is unavailable/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '4h' }));
    expect(
      screen.getByText('Older BRTI history is unavailable. Existing readings remain visible.'),
    ).toBeInTheDocument();
    expect(getSeries('observed-price').data.map((point) => point.value)).toEqual(
      readings.map((point) => [point.time, point.price]),
    );
    expect(mockChartProps.option.xAxis.max).toBe(DEADLINE);
    await user.click(screen.getByRole('button', { name: '1h' }));
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Older BRTI history is unavailable/)).not.toBeInTheDocument();
  });

  test('does not display the previous range response while the new range is loading', async () => {
    const user = userEvent.setup();
    const older = { time: NOW - 90 * MINUTE, price: 49_900 };
    const previousData = { samples: [older], status: 'available', reason: null };
    useGetBenchmarkHistoryQuery.mockReturnValue(historyResult([], { currentData: previousData }));
    render(<PriceChart {...defaults} />);
    await user.click(screen.getByRole('button', { name: '2h' }));
    expect(getSeries('observed-price').data[0].value).toEqual([older.time, older.price]);

    useGetBenchmarkHistoryQuery.mockReturnValue(
      historyResult([], {
        currentData: undefined,
        data: previousData,
        isFetching: true,
      }),
    );
    await user.click(screen.getByRole('button', { name: '4h' }));
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 4, endingAt: NOW },
      expect.objectContaining({ skip: false }),
    );
    expect(getSeries('observed-price').data[0].value[0]).toBe(readings[0].time);
    expect(screen.getByRole('img')).toHaveAccessibleName(/last 240 minutes/);
  });

  test('requests the new completed hour only when the clock crosses its boundary', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PriceChart {...defaults} now={NOW + 1000} />);
    await user.click(screen.getByRole('button', { name: '2h' }));
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 2, endingAt: NOW },
      expect.objectContaining({ skip: false }),
    );
    rerender(<PriceChart {...defaults} now={NOW + 60 * MINUTE - 1} />);
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 2, endingAt: NOW },
      expect.objectContaining({ skip: false }),
    );
    rerender(<PriceChart {...defaults} now={NOW + 60 * MINUTE} />);
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 2, endingAt: NOW + 60 * MINUTE },
      expect.objectContaining({ skip: false }),
    );
  });
});

describe('chart data and tooltips', () => {
  test('breaks missing seconds and keeps isolated real readings visible', () => {
    const samples = [readings.at(-10), readings.at(-1)];
    const result = getObservedLineData(samples);
    expect(result.data.map((point) => point.value)).toEqual([
      [samples[0].time, samples[0].price],
      [samples[0].time + 1000, null],
      [samples[1].time, samples[1].price],
    ]);
    expect(result.inspectionIndexes).toEqual([0, 2]);
    expect(result.data[0].symbolSize).toBeGreaterThan(0);
    expect(result.data[2].symbolSize).toBeGreaterThan(0);
    expect(
      getPriceChartOption(optionsFor({ readings: samples })).option.series[0].connectNulls,
    ).toBe(false);
  });

  test('tooltip gives original reading time and price', () => {
    const tooltip = formatChartTooltip({
      seriesId: 'observed-price',
      data: { value: [NOW, 50_123.45] },
    });
    expect(tooltip).toContain(formatDateTime(NOW));
    expect(tooltip).toContain('$50,123.45 USD');
    expect(tooltip).toContain('CF Benchmarks BRTI');
    expect(tooltip).not.toContain('model');
    expect(formatChartTooltip({ seriesId: 'observed-price', data: { value: [NOW, null] } })).toBe(
      '',
    );
  });

  test('candle tooltip exposes observed open/high/low/close, sample count and actual timestamps', () => {
    const candle = makeData([
      { time: NOW - 4000, price: 100 },
      { time: NOW - 2000, price: 120 },
      { time: NOW, price: 90 },
    ]).candles[0];
    const tooltip = formatChartTooltip({ seriesId: 'observed-candles', data: { candle } });
    expect(tooltip).toContain('Open <strong>$100.00</strong>');
    expect(tooltip).toContain('Close <strong>$90.00</strong>');
    expect(tooltip).toContain('High $120.00 · Low $90.00');
    expect(tooltip).toContain('3/60 observed samples');
    expect(tooltip).toContain('Partial');
    expect(tooltip).toContain(`First ${formatDateTime(NOW - 4000)}`);
    expect(tooltip).toContain(`Last ${formatDateTime(NOW)}`);
  });

  test('range tooltip names the settlement average and never invents a future observation', () => {
    const tooltip = formatChartTooltip({
      seriesId: 'model-range',
      data: { value: [DEADLINE, 49_900], lower: 49_900, upper: 50_100 },
    });
    expect(tooltip).toContain(formatDateTime(DEADLINE));
    expect(tooltip).toContain('$49,900.00–$50,100.00 USD');
    expect(tooltip).toContain('80% settlement-average range');
    expect(tooltip).toContain('no observed future price');
  });

  test('labels an observed prefix average as incomplete, separately from the official result', () => {
    const tooltip = formatChartTooltip({
      seriesId: 'settlement-average',
      data: { value: [NOW, 50_000], sampleCount: 12 },
    });
    expect(tooltip).toContain('12/60 samples · Incomplete');
    expect(tooltip).toContain('Not the official settlement result');
  });

  test('target changes affect the target line without changing BRTI observations', () => {
    const first = getPriceChartOption(optionsFor());
    const second = getPriceChartOption(optionsFor({ target: 51_000 }));
    expect(first.option.series[0].data).toEqual(second.option.series[0].data);
    expect(second.option.series[0].markLine.data).toContainEqual(
      expect.objectContaining({ yAxis: 51_000 }),
    );
    expect(second.option.yAxis.max).toBeGreaterThan(51_000);
  });
});
