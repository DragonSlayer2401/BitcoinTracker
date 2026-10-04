import { fireEvent, render, screen, within } from '@testing-library/react';
import CoinbaseChart from '../components/CoinbaseChart';
import { useGetBenchmarkHistoryQuery } from '../../../services/kalshi/benchmarkHistory/benchmarkHistory.api';
import {
  CHART_DRAWINGS_STORAGE_KEY,
  COINBASE_CHART_DRAWINGS_STORAGE_KEY,
  readChartDrawings,
  writeChartDrawings,
} from '../utils/chartDrawings.utils';

let mockChartProps;
const mockChartInstance = { dispatchAction: jest.fn() };

jest.mock('../../../services/kalshi/benchmarkHistory/benchmarkHistory.api', () => ({
  useGetBenchmarkHistoryQuery: jest.fn(),
}));
jest.mock('echarts-for-react/lib/core', () => {
  const React = require('react');
  return React.forwardRef(function ChartRenderer(props, ref) {
    mockChartProps = props;
    React.useImperativeHandle(ref, () => ({ getEchartsInstance: () => mockChartInstance }));
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

const NOW = Date.UTC(2026, 9, 3, 12, 0);
const MINUTE = 60_000;
const candles = Array.from({ length: 180 }, (_, index) => ({
  time: NOW - (180 - index) * MINUTE,
  open: 60_000 + index * 3,
  high: 60_015 + index * 3,
  low: 59_990 + index * 3,
  close: 60_004 + index * 3,
  volume: 3 + index / 10,
}));
const props = {
  candles,
  ticker: { time: NOW + 2_000, receivedAt: NOW + 2_000, price: 60_550 },
  now: NOW + 2_000,
  isQuoteFresh: true,
  target: 60_500,
  deadline: NOW + 10 * MINUTE,
};
const getSeries = (id) => mockChartProps.option.series.find((series) => series.id === id);
const getMarks = () => getSeries('observed-candles').markLine.data;
function chooseTool(name) {
  fireEvent.click(screen.getByRole('button', { name: 'Chart tools' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Chart tools' }));
  fireEvent.click(dialog.getByRole('button', { name }));
  fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(props.now);
  localStorage.clear();
  useGetBenchmarkHistoryQuery.mockReset();
  useGetBenchmarkHistoryQuery.mockReturnValue({
    currentData: undefined,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  });
});
afterEach(() => jest.restoreAllMocks());

test('renders actual Coinbase candles, indicators and the current-price marker with a Kalshi target', () => {
  render(<CoinbaseChart {...props} />);
  expect(screen.getByRole('heading', { name: 'Coinbase BTC/USD' })).toBeVisible();
  expect(screen.getByRole('img')).toHaveAccessibleName(/Kalshi settles using CF Benchmarks BRTI/);
  expect(screen.getByText(/Coinbase spot · Kalshi settles on BRTI/)).toBeVisible();
  const last = getSeries('observed-candles').data.at(-1);
  expect(last.value).toEqual([
    candles.at(-1).time,
    candles.at(-1).open,
    candles.at(-1).close,
    candles.at(-1).low,
    candles.at(-1).high,
  ]);
  expect(last.candle.sampleCount).toBe(1);
  expect(last.candle.firstSampleAt).toBeUndefined();
  expect(getMarks().find((mark) => mark.yAxis === props.target).label.formatter).toContain(
    'Target',
  );
  expect(getMarks().find((mark) => mark.name?.startsWith('Current Coinbase'))).toMatchObject({
    yAxis: props.ticker.price,
  });
  expect(mockChartProps.option.series.some((series) => series.id === 'settlement-average')).toBe(
    false,
  );
  expect(getSeries('model-range')).toBeUndefined();
  expect(getSeries('observed-candles').markArea.data).toEqual([]);
  expect(document.querySelector('iframe, script')).toBeNull();
});

test('supports three hours from the shared feed without any Kalshi chart-history request', () => {
  render(<CoinbaseChart {...props} />);
  chooseTool('2h');
  chooseTool('3h');
  fireEvent.click(screen.getByRole('button', { name: 'Chart tools' }));
  const tools = within(screen.getByRole('dialog', { name: 'Chart tools' }));
  expect(tools.queryByRole('button', { name: '4h' })).not.toBeInTheDocument();
  expect(tools.getByRole('button', { name: '3h' })).toHaveAttribute('aria-pressed', 'true');
  expect(useGetBenchmarkHistoryQuery.mock.calls.every(([, options]) => options.skip)).toBe(true);
  expect(getSeries('observed-candles').data.length).toBeGreaterThan(120);
});

test('updates the target without resetting zoom or chosen indicators', () => {
  const { rerender } = render(<CoinbaseChart {...props} />);
  chooseTool('RSI');
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  const zoom = mockChartProps.option.dataZoom[0];
  rerender(<CoinbaseChart {...props} now={props.now + 1_000} target={60_620} />);
  expect(getMarks().find((mark) => mark.yAxis === 60_620).label.formatter).toContain('60,620');
  expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeEnabled();
  expect(mockChartProps.option.dataZoom[0].startValue).toBe(zoom.startValue);
  fireEvent.click(screen.getByRole('button', { name: 'Chart tools' }));
  expect(
    within(screen.getByRole('dialog', { name: 'Chart tools' })).getByRole('button', {
      name: 'RSI',
    }),
  ).toHaveAttribute('aria-pressed', 'false');
});

test('line mode shows completed minute closes without inventing second-by-second prices', () => {
  render(<CoinbaseChart {...props} />);
  chooseTool('Line');
  const points = getSeries('observed-price').data;
  expect(points.every((point) => Number.isFinite(point.value[1]))).toBe(true);
  expect(points.at(-1).value).toEqual([NOW, candles.at(-1).close]);
  expect(screen.getByRole('slider', { name: 'Inspect historical Coinbase closes' })).toBeVisible();
});

test('keeps Coinbase drawings separate and preserves zoom when the chart is expanded', () => {
  const drawing = {
    id: 'index-line',
    type: 'horizontal',
    price: 60_100,
    color: '#6ea8fe',
    label: 'Index only',
  };
  writeChartDrawings([drawing], undefined, NOW);
  const coinbaseDrawing = { ...drawing, id: 'spot-line', label: 'Spot support', price: 60_200 };
  writeChartDrawings([coinbaseDrawing], undefined, NOW, COINBASE_CHART_DRAWINGS_STORAGE_KEY);
  render(<CoinbaseChart {...props} />);
  expect(getMarks().some((mark) => mark.name === 'Index only')).toBe(false);
  expect(getMarks().some((mark) => mark.name === 'Spot support')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  const zoom = mockChartProps.option.dataZoom[0];
  fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }));
  expect(screen.getByRole('dialog', { name: 'Coinbase BTC/USD' })).toBeVisible();
  expect(mockChartProps.option.dataZoom[0].startValue).toBe(zoom.startValue);
  expect(getMarks().some((mark) => mark.name === 'Spot support')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Restore chart' }));
  expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeEnabled();
  expect(readChartDrawings(undefined, NOW).drawings).toEqual([drawing]);
  expect(JSON.parse(localStorage.getItem(CHART_DRAWINGS_STORAGE_KEY)).symbol).toBe('CF-BRTI');
});

test('labels a delayed quote honestly while retaining completed candles', () => {
  render(<CoinbaseChart {...props} isQuoteFresh={false} />);
  expect(screen.getByText(/Delayed/)).toBeVisible();
  expect(getMarks().find((mark) => mark.name?.startsWith('Last observed Coinbase'))).toBeDefined();
  expect(getSeries('observed-candles').data.length).toBeGreaterThan(0);
});

test('uses the actual time when a quote arrives between dashboard clock ticks', () => {
  render(<CoinbaseChart {...props} now={NOW + 1_000} />);
  expect(getMarks().find((mark) => mark.name?.startsWith('Current Coinbase'))).toMatchObject({
    yAxis: props.ticker.price,
  });
  expect(screen.getByText(/Live quote/)).toBeVisible();
});

test('waits for the client clock before displaying price history', () => {
  render(<CoinbaseChart {...props} now={null} />);
  expect(screen.getByText('Waiting for Coinbase BTC/USD candles…')).toBeVisible();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
