import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PriceChart from '../components/PriceChart';
import {
  getObservedLineData,
  formatChartTooltip,
  getPriceChartOption,
  getChartZoomRange,
} from '../utils/priceChart.utils';
import { getBenchmarkChartData, getBenchmarkSettlement } from '../utils/benchmarkChart.utils';
import { aggregateChartCandles, getChartIndicators } from '../utils/chartIndicators.utils';
import {
  DEFAULT_DRAWING_COLOR,
  readChartDrawings,
  writeChartDrawings,
} from '../utils/chartDrawings.utils';
import { formatDateTime, formatPrice, formatTime } from '../utils/format.utils';
import { useGetBenchmarkHistoryQuery } from '../../../services/kalshi/benchmarkHistory/benchmarkHistory.api';

let mockChartProps;
const mockDispatchAction = jest.fn();
const mockRefetchHistory = jest.fn();
const mockChartInstance = { dispatchAction: mockDispatchAction };

jest.mock('../../../services/kalshi/benchmarkHistory/benchmarkHistory.api', () => ({
  useGetBenchmarkHistoryQuery: jest.fn(),
}));

jest.mock('echarts-for-react/lib/core', () => {
  const React = require('react');
  return React.forwardRef(function ChartRenderer(props, ref) {
    mockChartProps = props;
    React.useImperativeHandle(ref, () => ({
      getEchartsInstance: () => mockChartInstance,
    }));
    React.useEffect(() => props.onChartReady?.(mockChartInstance), [props.onChartReady]);
    return <div data-testid="chart-renderer" />;
  });
});
jest.mock('echarts/core', () => ({ use: jest.fn() }));
jest.mock('echarts/charts', () => ({ LineChart: {}, CandlestickChart: {}, BarChart: {} }));
jest.mock('echarts/components', () => ({
  AxisPointerComponent: {},
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
function openChartTools() {
  if (!screen.queryByRole('dialog', { name: 'Chart tools' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Chart tools' }));
  }
  return within(screen.getByRole('dialog', { name: 'Chart tools' }));
}
function closeChartTools() {
  const dialog = screen.queryByRole('dialog', { name: 'Chart tools' });
  if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
}
function clickChartTool(name) {
  fireEvent.click(openChartTools().getByRole('button', { name }));
  closeChartTools();
}
function getChartToolState(name) {
  const control = openChartTools().getByRole('button', { name });
  const state = { disabled: control.disabled, pressed: control.getAttribute('aria-pressed') };
  closeChartTools();
  return state;
}
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
  localStorage.clear();
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
    clickChartTool('Line');
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
    expect(mockChartProps.option.xAxis[0].max).toBe(DEADLINE);
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
    expect(mockChartProps.option.xAxis[0].max).toBe(deadline);
    expect(getSeries('model-range').data.every((point) => point.value[0] === deadline)).toBe(true);
    expect(screen.getByRole('img')).toHaveAccessibleName(/30:00 remaining/);
    expect(getSeries('observed-candles').markArea.data).toEqual([
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
    clickChartTool('15m');
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 0.25, endingAt: 0 },
      expect.objectContaining({ skip: true }),
    );
    expect(mockChartProps.option.xAxis[0].min).toBe(NOW - 15 * MINUTE);
    expect(mockChartProps.option.xAxis[0].max).toBe(DEADLINE);
    expect(screen.getByRole('img')).toHaveAccessibleName(/last 15 minutes/);
    clickChartTool('30m');
    expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
      { hours: 0.5, endingAt: 0 },
      expect.objectContaining({ skip: true }),
    );
    expect(mockChartProps.option.xAxis[0].min).toBe(NOW - 30 * MINUTE);
    clickChartTool('1h');
    expect(mockChartProps.option.xAxis[0].min).toBe(NOW - 60 * MINUTE);
    expect(openChartTools().getByRole('button', { name: '2h' })).toBeInTheDocument();
    expect(openChartTools().getByRole('button', { name: '4h' })).toBeInTheDocument();
    closeChartTools();
  });

  test('supports line and candle views with OHLC values and observed coverage', async () => {
    const user = userEvent.setup();
    const partial = makeData(
      [...readings, { time: NOW + 1000, price: 50_200 }, { time: NOW + 2000, price: 50_100 }],
      NOW + 2000,
    );
    render(<PriceChart {...defaults} now={NOW + 2000} benchmarkData={partial} />);
    clickChartTool('Candles');
    expect(getChartToolState('Candles').pressed).toBe('true');
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
    clickChartTool('Line');
    expect(getSeries('observed-price')).toBeDefined();
    expect(getSeries('observed-candles')).toBeUndefined();
  });

  test('keyboard inspection skips visual gap markers while opening the correct tooltip', () => {
    const samples = [readings.at(-6), readings.at(-5), readings.at(-1)];
    render(<PriceChart {...defaults} benchmarkData={makeData(samples)} />);
    clickChartTool('Line');
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
    clickChartTool('Line');
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
    clickChartTool('Line');
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
    expect(getSeries('observed-candles').markArea.data).toEqual([
      [{ xAxis: deadline - MINUTE }, { xAxis: deadline }],
    ]);
  });
});

describe('trading chart inspection and controls', () => {
  test('keeps display settings and placement in Tools while zoom and Drawings remain directly accessible', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    expect(screen.queryByRole('dialog', { name: 'Chart tools' })).not.toBeInTheDocument();
    for (const name of ['Candles', 'MACD', 'RSI', 'EMA', '5 minute candles', 'Pin comparison']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('group', { name: 'Chart zoom and pan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Manage drawings' })).toHaveTextContent('Drawings');
    const trigger = screen.getByRole('button', { name: 'Chart tools' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const popup = screen.getByRole('dialog', { name: 'Chart tools' });
    const tools = within(popup);
    expect(tools.getByRole('group', { name: 'Chart view' })).toBeInTheDocument();
    expect(tools.getByRole('group', { name: 'Candle interval' })).toBeInTheDocument();
    expect(tools.getByRole('group', { name: 'Chart history' })).toBeInTheDocument();
    expect(tools.getByRole('group', { name: 'Chart indicators' })).toBeInTheDocument();
    expect(tools.queryByRole('group', { name: 'Chart zoom and pan' })).not.toBeInTheDocument();
    expect(tools.getByRole('group', { name: 'Chart drawing tools' })).toBeInTheDocument();
    expect(tools.queryByRole('list', { name: 'Saved chart drawings' })).not.toBeInTheDocument();
    expect(tools.queryByRole('button', { name: /Clear all drawings/ })).not.toBeInTheDocument();
    expect(tools.queryByRole('button', { name: 'Manage drawings' })).not.toBeInTheDocument();
    await user.click(tools.getByRole('button', { name: '5 minute candles' }));
    await user.click(tools.getByRole('button', { name: 'EMA' }));
    expect(popup).toBeInTheDocument();
    expect(tools.getByRole('button', { name: '5 minute candles' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(tools.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Chart tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'EMA' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Inspect BRTI candles' })).toBeInTheDocument();
    expect(getSeries('ema9')).toBeDefined();
    expect(getSeries('observed-candles').data.at(-1).candle.expectedSampleCount).toBe(300);
    await user.click(screen.getByRole('button', { name: 'Chart tools' }));
    const reopened = within(screen.getByRole('dialog', { name: 'Chart tools' }));
    expect(reopened.getByRole('button', { name: '5 minute candles' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(reopened.getByRole('button', { name: 'EMA' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(reopened.getByRole('button', { name: 'Done' }));
  });

  test('the separate Drawings manager deletes one saved line and persists clear-all without affecting chart settings', async () => {
    const user = userEvent.setup();
    const support = {
      id: 'chart-support',
      type: 'horizontal',
      label: 'Support',
      color: DEFAULT_DRAWING_COLOR,
      price: 50_020,
    };
    const deadline = {
      id: 'chart-deadline',
      type: 'vertical',
      label: 'Deadline',
      color: '#f4c56a',
      time: DEADLINE,
    };
    expect(writeChartDrawings([support, deadline])).toBeNull();
    const first = render(<PriceChart {...defaults} />);
    clickChartTool('3 minute candles');
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 5 * MINUTE };
    applyChartGesture(selectedRange);
    await user.click(screen.getByRole('button', { name: 'Manage drawings' }));
    const manager = within(screen.getByRole('dialog', { name: 'Chart drawings' }));
    expect(screen.queryByRole('dialog', { name: 'Chart tools' })).not.toBeInTheDocument();
    expect(manager.queryByRole('group', { name: 'Chart drawing tools' })).not.toBeInTheDocument();
    expect(manager.queryByRole('group', { name: 'Chart indicators' })).not.toBeInTheDocument();
    expect(manager.getByRole('list', { name: 'Saved chart drawings' })).toBeInTheDocument();
    await user.click(manager.getByRole('button', { name: 'Delete Support' }));
    expect(manager.queryByRole('button', { name: 'Delete Support' })).not.toBeInTheDocument();
    expect(manager.getByRole('button', { name: 'Delete Deadline' })).toBeInTheDocument();
    expect(readChartDrawings().drawings).toEqual([deadline]);
    await user.click(manager.getByRole('button', { name: 'Done' }));
    expect(getZoom()).toMatchObject(selectedRange);
    expect(getChartToolState('3 minute candles').pressed).toBe('true');
    expect(
      getSeries('observed-candles').markLine.data.some((mark) => mark.name === 'Support'),
    ).toBe(false);
    first.unmount();

    const restored = render(<PriceChart {...defaults} />);
    await user.click(screen.getByRole('button', { name: 'Manage drawings' }));
    const reopened = within(screen.getByRole('dialog', { name: 'Chart drawings' }));
    expect(reopened.queryByRole('button', { name: 'Delete Support' })).not.toBeInTheDocument();
    expect(reopened.getByRole('button', { name: 'Delete Deadline' })).toBeInTheDocument();
    await user.click(reopened.getByRole('button', { name: 'Clear all drawings' }));
    expect(reopened.queryByRole('list', { name: 'Saved chart drawings' })).not.toBeInTheDocument();
    expect(readChartDrawings().drawings).toEqual([]);
    expect(reopened.getByRole('button', { name: 'Clear all drawings' })).toBeDisabled();
    await user.click(reopened.getByRole('button', { name: 'Done' }));
    restored.unmount();

    render(<PriceChart {...defaults} />);
    await user.click(screen.getByRole('button', { name: 'Manage drawings' }));
    const cleared = within(screen.getByRole('dialog', { name: 'Chart drawings' }));
    expect(cleared.queryByRole('list', { name: 'Saved chart drawings' })).not.toBeInTheDocument();
    expect(cleared.getByRole('button', { name: 'Clear all drawings' })).toBeDisabled();
    expect(readChartDrawings().drawings).toEqual([]);
  });

  test.each([
    ['Draw horizontal price line', 'Click the price chart to place a horizontal line.'],
    ['Draw vertical time line', 'Click the price chart to place a vertical line.'],
    ['Draw trend line', 'Click two points for a trend line.'],
  ])(
    'choosing %s closes Tools so the chart is available for placement',
    async (name, instruction) => {
      const user = userEvent.setup();
      render(<PriceChart {...defaults} />);
      await user.click(screen.getByRole('button', { name: 'Chart tools' }));
      const tools = within(screen.getByRole('dialog', { name: 'Chart tools' }));
      await user.click(tools.getByRole('button', { name }));
      expect(screen.queryByRole('dialog', { name: 'Chart tools' })).not.toBeInTheDocument();
      expect(screen.getByText(instruction, { exact: false })).toBeInTheDocument();
      expect(screen.getByRole('img')).toBeInTheDocument();
      expect(mockChartProps.option.dataZoom[0].disabled).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Cancel drawing' }));
      expect(screen.queryByRole('button', { name: 'Cancel drawing' })).not.toBeInTheDocument();
      expect(mockChartProps.option.dataZoom[0].disabled).toBe(false);
    },
  );

  test('Line inspection uses only indicator closes available by the inspected second', async () => {
    const user = userEvent.setup();
    const accelerating = readings.map((reading, index) => ({
      ...reading,
      price: 50_000 + Math.floor(index / 60) ** 2,
    }));
    const data = makeData(accelerating);
    const completed = aggregateChartCandles(data.candles, 1, NOW);
    const indicatorPoints = getChartIndicators(completed).points;
    const closedAt = NOW - 20 * MINUTE;
    const inspectedAt = closedAt + 10_000;
    const previous = indicatorPoints.find((point) => point.time === closedAt - MINUTE);
    const later = indicatorPoints.find((point) => point.time === closedAt);
    const macdText = (point) =>
      `MACD ${point.macd.toFixed(2)} / ${point.signal.toFixed(2)} / ${point.histogram.toFixed(2)}`;
    expect(macdText(previous)).not.toBe(macdText(later));
    render(<PriceChart {...defaults} benchmarkData={data} />);
    clickChartTool('Line');
    clickChartTool('EMA');
    act(() =>
      mockChartProps.onEvents.updateAxisPointer({
        axesInfo: [{ axisDim: 'x', value: inspectedAt }],
      }),
    );
    const readout = screen.getByLabelText('Indicator values at inspected candle');
    expect(readout).toHaveTextContent(`Close ${formatTime(closedAt)}`);
    expect(within(readout).getByText(`Close ${formatTime(closedAt)}`)).toHaveAttribute(
      'title',
      formatDateTime(closedAt),
    );
    const macdPanel = screen.getByRole('region', { name: 'MACD (12, 26, 9)' });
    expect(macdPanel).toHaveTextContent(macdText(previous));
    expect(macdPanel).not.toHaveTextContent(macdText(later));
    expect(readout).toHaveTextContent(
      `EMA 9/21 ${previous.ema9.toFixed(2)} / ${previous.ema21.toFixed(2)}`,
    );
    const observedPrice = accelerating.find((reading) => reading.time === inspectedAt).price;
    expect(
      screen.getByRole('status', {
        name: `${formatDateTime(inspectedAt)} · ${formatPrice(observedPrice)} · CF Benchmarks BRTI`,
      }),
    ).toHaveTextContent(formatPrice(observedPrice));
    act(() =>
      mockChartProps.onEvents.updateAxisPointer({
        axesInfo: [{ axisDim: 'x', value: closedAt + MINUTE }],
      }),
    );
    expect(macdPanel).toHaveTextContent(macdText(later));
    expect(readout).toHaveTextContent(`Close ${formatTime(closedAt + MINUTE)}`);
  });

  test('an interval with insufficient complete candles shows unavailable values and an explicit warm-up message', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    clickChartTool('15 minute candles');
    const readout = screen.getByLabelText('Indicator values at inspected candle');
    expect(getSeries('observed-candles').data).toHaveLength(4);
    expect(getSeries('observed-candles').data.every((point) => point.candle.isComplete)).toBe(true);
    expect(screen.getByRole('region', { name: 'MACD (12, 26, 9)' })).toHaveTextContent(
      'MACD — / — / —',
    );
    expect(screen.getByRole('region', { name: 'RSI (14)' })).toHaveTextContent('RSI 14 —');
    expect(readout).toHaveTextContent('Warming up · complete candles required');
    expect(getSeries('macd').data.every((point) => point.value[1] === null)).toBe(true);
    expect(getSeries('rsi').data.every((point) => point.value[1] === null)).toBe(true);
    clickChartTool('MACD');
    clickChartTool('RSI');
    expect(screen.queryByText('Warming up · complete candles required')).not.toBeInTheDocument();
  });

  test('defaults to candles with MACD and RSI panes without a floating tooltip', () => {
    render(<PriceChart {...defaults} />);
    expect(getChartToolState('Candles').pressed).toBe('true');
    expect(getChartToolState('MACD').pressed).toBe('true');
    expect(getChartToolState('RSI').pressed).toBe('true');
    expect(getChartToolState('EMA').pressed).toBe('false');
    expect(getSeries('observed-candles')).toBeDefined();
    expect(getSeries('macd-histogram')).toBeDefined();
    expect(getSeries('rsi')).toBeDefined();
    expect(getSeries('observed-price')).toBeUndefined();
    expect(mockChartProps.option.grid).toHaveLength(3);
    expect(mockChartProps.option.tooltip).toMatchObject({
      showContent: false,
      axisPointer: { type: 'cross' },
    });
    const macdPanel = screen.getByRole('region', { name: 'MACD (12, 26, 9)' });
    const rsiPanel = screen.getByRole('region', { name: 'RSI (14)' });
    expect(
      within(macdPanel).getByRole('heading', { name: 'MACD (12, 26, 9)' }),
    ).toBeInTheDocument();
    expect(within(rsiPanel).getByRole('heading', { name: 'RSI (14)' })).toBeInTheDocument();
    expect(macdPanel).toHaveTextContent('MACD 0.00 / 0.00 / 0.00');
    expect(rsiPanel).toHaveTextContent('RSI 14 50.00');
    expect(macdPanel).not.toHaveTextContent('RSI 14');
    expect(rsiPanel).not.toHaveTextContent('MACD');
  });

  test('crosshair movement updates the docked OHLC readout from any pane and leaves future gaps empty', () => {
    render(<PriceChart {...defaults} />);
    const candle = getSeries('observed-candles').data[10].candle;
    act(() =>
      mockChartProps.onEvents.updateAxisPointer({
        axesInfo: [
          { axisDim: 'y', axisIndex: 1, value: 5 },
          { axisDim: 'x', axisIndex: 1, value: candle.time },
        ],
      }),
    );
    const readout = screen.getByRole('status', { name: /Open/ });
    expect(readout).toHaveAttribute('title', expect.stringContaining(formatDateTime(candle.time)));
    expect(readout).toHaveTextContent(`O ${formatPrice(candle.open)}`);
    expect(readout).toHaveTextContent(`H ${formatPrice(candle.high)}`);
    expect(readout).toHaveTextContent(`L ${formatPrice(candle.low)}`);
    expect(readout).toHaveTextContent(`C ${formatPrice(candle.close)}`);
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      readout.getAttribute('title'),
    );
    act(() =>
      mockChartProps.onEvents.updateAxisPointer({
        axesInfo: [{ axisDim: 'x', value: NOW + 5 * MINUTE }],
      }),
    );
    expect(
      screen.getByRole('status', { name: 'No observed reading at the crosshair.' }),
    ).toBeInTheDocument();
    expect(getChartToolState('Pin comparison').disabled).toBe(true);
    expect(mockChartProps.option.tooltip.showContent).toBe(false);
  });

  test('pins an observation for comparison while inspecting a different candle and clears the pin explicitly', async () => {
    const user = userEvent.setup();
    const rising = readings.map((point, index) => ({ ...point, price: 50_000 + index }));
    render(<PriceChart {...defaults} benchmarkData={makeData(rising)} />);
    const original = getSeries('observed-candles').data[10].candle;
    const compared = getSeries('observed-candles').data[20].candle;
    const slider = screen.getByRole('slider', { name: 'Inspect BRTI candles' });
    fireEvent.change(slider, { target: { value: '10' } });
    await user.click(screen.getByRole('button', { name: 'Chart tools' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Chart tools' })).getByRole('button', {
        name: 'Pin comparison',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Chart tools' })).not.toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '20' } });
    const comparison = screen.getByRole('status', { name: 'Pinned candle comparison' });
    expect(comparison).toHaveTextContent(formatPrice(original.close));
    expect(comparison).toHaveTextContent(`Δ +${formatPrice(compared.close - original.close)}`);
    for (const id of ['observed-candles', 'macd-histogram', 'rsi']) {
      expect(getSeries(id).markLine.data).toContainEqual(
        expect.objectContaining({ name: 'Comparison', xAxis: original.time }),
      );
    }
    clickChartTool('Clear comparison');
    expect(
      screen.queryByRole('status', { name: 'Pinned candle comparison' }),
    ).not.toBeInTheDocument();
    expect(
      getSeries('observed-candles').markLine.data.some((mark) => mark.name === 'Comparison'),
    ).toBe(false);
    expect(getChartToolState('Pin comparison').pressed).toBe('false');
  });

  test('changes the candle interval with actual aggregated sample coverage and retains the selected zoom', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    const originalCount = getSeries('observed-candles').data.length;
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 5 * MINUTE };
    applyChartGesture(selectedRange);
    clickChartTool('5 minute candles');
    expect(getChartToolState('5 minute candles').pressed).toBe('true');
    const aggregated = getSeries('observed-candles').data;
    expect(aggregated.length).toBeLessThan(originalCount);
    expect(aggregated.at(-1).candle.expectedSampleCount).toBe(300);
    expect(aggregated.at(-1).candle.endTime - aggregated.at(-1).candle.time).toBe(5 * MINUTE);
    expect(getZoom()).toMatchObject(selectedRange);
    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('/300 BRTI samples'),
    );
    clickChartTool('1 minute candles');
    expect(getSeries('observed-candles').data).toHaveLength(originalCount);
    expect(getZoom()).toMatchObject(selectedRange);
  });

  test('toggles each indicator without replacing observations, changing the deadline or resetting zoom', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    const original = getSeries('observed-candles').data;
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 5 * MINUTE };
    applyChartGesture(selectedRange);
    clickChartTool('MACD');
    expect(getSeries('macd')).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'MACD (12, 26, 9)' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'RSI (14)' })).toBeInTheDocument();
    expect(getSeries('rsi').xAxisIndex).toBe(1);
    expect(mockChartProps.option.grid).toHaveLength(2);
    clickChartTool('RSI');
    expect(getSeries('rsi')).toBeUndefined();
    expect(screen.queryByRole('region', { name: 'RSI (14)' })).not.toBeInTheDocument();
    expect(mockChartProps.option.grid).toHaveLength(1);
    clickChartTool('EMA');
    expect(getSeries('ema9')).toBeDefined();
    expect(getSeries('ema21')).toBeDefined();
    expect(getChartToolState('EMA').pressed).toBe('true');
    expect(getSeries('observed-candles').data).toEqual(original);
    expect(mockChartProps.option.xAxis[0].max).toBe(DEADLINE);
    expect(getZoom()).toMatchObject(selectedRange);
    clickChartTool('MACD');
    expect(getSeries('macd')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'MACD (12, 26, 9)' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'RSI (14)' })).not.toBeInTheDocument();
    expect(mockChartProps.option.grid).toHaveLength(2);
  });

  test('expanded view keeps the selected interval, indicators, zoom and pinned observation when restored', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    clickChartTool('3 minute candles');
    clickChartTool('RSI');
    clickChartTool('EMA');
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 5 * MINUTE };
    applyChartGesture(selectedRange);
    clickChartTool('Pin comparison');
    const pinned = screen.getByRole('status', { name: 'Pinned candle comparison' }).textContent;
    await user.click(screen.getByRole('button', { name: 'Expand chart' }));
    const dialog = screen.getByRole('dialog', { name: 'BRTI price activity' });
    expect(within(dialog).getByRole('button', { name: 'Manage drawings' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: 'Chart zoom and pan' })).toBeInTheDocument();
    expect(getChartToolState('3 minute candles').pressed).toBe('true');
    expect(getChartToolState('RSI').pressed).toBe('false');
    expect(getChartToolState('EMA').pressed).toBe('true');
    expect(getZoom()).toMatchObject(selectedRange);
    expect(screen.getAllByTestId('chart-renderer')).toHaveLength(1);
    expect(
      within(dialog).getByRole('status', { name: 'Pinned candle comparison' }),
    ).toHaveTextContent(pinned);
    await user.click(within(dialog).getByRole('button', { name: 'Restore chart' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand chart' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand chart' })).toHaveFocus();
    expect(getChartToolState('3 minute candles').pressed).toBe('true');
    expect(getZoom()).toMatchObject(selectedRange);
    expect(screen.getByRole('status', { name: 'Pinned candle comparison' })).toHaveTextContent(
      pinned,
    );
    expect(getSeries('ema9')).toBeDefined();
    expect(getSeries('rsi')).toBeUndefined();
  });
});

describe('BRTI chart zoom and pan', () => {
  test('supports keyboard zoom, bounded pan, zoom out and reset without opening Tools', async () => {
    const user = userEvent.setup();
    render(<PriceChart {...defaults} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
    expect(getZoom().endValue - getZoom().startValue).toBe(36 * MINUTE);
    await user.click(reset);
    expect(getZoom()).toMatchObject({ startValue: NOW - 60 * MINUTE, endValue: DEADLINE });
    expect(reset).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(
      expect.stringContaining(formatDateTime(NOW - 60 * MINUTE)),
    );
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('uses gesture timestamps from the matching chart control and retains them during live updates', () => {
    const { rerender } = render(<PriceChart {...defaults} />);
    clickChartTool('Line');
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
    clickChartTool('Line');
    const selectedRange = { startValue: NOW - 20 * MINUTE, endValue: NOW - 10 * MINUTE };
    applyChartGesture(selectedRange);
    clickChartTool('Candles');
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
    clickChartTool('Line');
    expect(getZoom()).toMatchObject(selectedRange);
    clickChartTool('2h');
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
    clickChartTool('Line');
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
    expect(full.yAxis[0].min).toBeLessThan(20_000);
    expect(full.yAxis[0].max).toBeGreaterThan(150_000);
    expect(zoomed.yAxis[0].min).toBeGreaterThan(49_900);
    expect(zoomed.yAxis[0].min).toBeLessThan(49_990);
    expect(zoomed.yAxis[0].max).toBeGreaterThan(50_010);
    expect(zoomed.yAxis[0].max).toBeLessThan(50_100);
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
    expect(result.option.yAxis[0].min).toBeLessThan(48_000);
    expect(result.option.yAxis[0].min).toBeGreaterThan(40_000);
    expect(result.option.yAxis[0].max).toBeGreaterThan(53_000);
    expect(result.option.yAxis[0].max).toBeLessThan(60_000);
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
      clickChartTool('Line');
      expect(getSeries('observed-price').data[0].value[0]).toBe(readings[0].time);

      clickChartTool(`${hours}h`);
      expect(useGetBenchmarkHistoryQuery).toHaveBeenLastCalledWith(
        { hours, endingAt: NOW },
        expect.objectContaining({ skip: false }),
      );
      expect(mockChartProps.option.xAxis[0].min).toBe(NOW - hours * 60 * MINUTE);
      expect(mockChartProps.option.xAxis[0].max).toBe(DEADLINE);
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

      clickChartTool('Candles');
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
    clickChartTool('Line');
    useGetBenchmarkHistoryQuery.mockReturnValue(
      historyResult([], {
        currentData: undefined,
        isFetching: true,
      }),
    );
    clickChartTool('2h');
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
    clickChartTool('Line');
    expect(screen.queryByText(/Older BRTI history is unavailable/)).not.toBeInTheDocument();
    clickChartTool('4h');
    expect(
      screen.getByText('Older BRTI history is unavailable. Existing readings remain visible.'),
    ).toBeInTheDocument();
    expect(getSeries('observed-price').data.map((point) => point.value)).toEqual(
      readings.map((point) => [point.time, point.price]),
    );
    expect(mockChartProps.option.xAxis[0].max).toBe(DEADLINE);
    clickChartTool('1h');
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Older BRTI history is unavailable/)).not.toBeInTheDocument();
  });

  test('does not display the previous range response while the new range is loading', async () => {
    const user = userEvent.setup();
    const older = { time: NOW - 90 * MINUTE, price: 49_900 };
    const previousData = { samples: [older], status: 'available', reason: null };
    useGetBenchmarkHistoryQuery.mockReturnValue(historyResult([], { currentData: previousData }));
    render(<PriceChart {...defaults} />);
    clickChartTool('Line');
    clickChartTool('2h');
    expect(getSeries('observed-price').data[0].value).toEqual([older.time, older.price]);

    useGetBenchmarkHistoryQuery.mockReturnValue(
      historyResult([], {
        currentData: undefined,
        data: previousData,
        isFetching: true,
      }),
    );
    clickChartTool('4h');
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
    clickChartTool('2h');
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
    expect(second.option.yAxis[0].max).toBeGreaterThan(51_000);
  });
});
