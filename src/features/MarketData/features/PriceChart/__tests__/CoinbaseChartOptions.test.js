/** @jest-environment node */

import { init } from 'echarts/dist/echarts';
import {
  formatChartTooltip,
  getCandleDescription,
  getObservedLineData,
  getPriceChartOption,
} from '../utils/priceChart.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 3, 12);
const readings = Array.from({ length: 20 }, (_, index) => ({
  time: NOW - (19 - index) * MINUTE,
  price: 84_000 + index,
  source: 'coinbase',
}));
const candles = readings.map((reading) => ({
  time: reading.time - MINUTE,
  endTime: reading.time,
  open: reading.price - 1,
  high: reading.price + 2,
  low: reading.price - 2,
  close: reading.price,
  source: 'coinbase',
  sampleCount: 1,
  expectedSampleCount: 1,
  isPartial: false,
}));
const optionsFor = (overrides = {}) => ({
  readings,
  candles,
  source: 'coinbase',
  view: 'candles',
  target: 84_010,
  startTime: NOW - 20 * MINUTE,
  endTime: NOW,
  settlement: { points: [] },
  ...overrides,
});
const findMark = (option, name) =>
  option.series[0].markLine.data.find((mark) => mark.name === name);

describe('Coinbase chart reference prices', () => {
  test.each(['line', 'candles'])(
    '%s renders the actual Kalshi target as a labeled price line through historical zoom',
    (view) => {
      const target = 84_234.56;
      const result = getPriceChartOption(
        optionsFor({
          view,
          target,
          zoomRange: { startTime: NOW - 18 * MINUTE, endTime: NOW - 15 * MINUTE },
        }),
      );
      expect(findMark(result.option, 'Kalshi target')).toMatchObject({
        yAxis: target,
        lineStyle: { color: '#f0c577', type: 'dashed' },
        label: {
          show: true,
          position: 'end',
          formatter: 'Target $84,234.56',
          backgroundColor: '#f0c577',
        },
      });
      expect(result.option.yAxis[0].min).toBeLessThan(target);
      expect(result.option.yAxis[0].max).toBeGreaterThan(target);
      const chart = init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 400 });
      try {
        chart.setOption(result.option);
        const svg = chart.renderToSVGString();
        expect(svg).toContain('Target $84,234.56');
        expect(svg).not.toContain('NaN');
      } finally {
        chart.dispose();
      }
    },
  );

  test('updates the threshold on event rollover and removes a missing or invalid target', () => {
    const previous = getPriceChartOption(optionsFor()).option;
    const next = getPriceChartOption(optionsFor({ target: 84_025.12 })).option;
    expect(findMark(previous, 'Kalshi target').yAxis).toBe(84_010);
    expect(findMark(next, 'Kalshi target')).toMatchObject({
      yAxis: 84_025.12,
      label: { formatter: 'Target $84,025.12' },
    });
    for (const target of [null, undefined, NaN, Infinity, 0, -1]) {
      expect(
        findMark(getPriceChartOption(optionsFor({ target })).option, 'Kalshi target'),
      ).toBeUndefined();
    }
  });

  test.each([84_009.99, 84_010, 84_010.01])(
    'keeps nearby target and current price boxes readable at %s without changing their line prices',
    (price) => {
      const option = getPriceChartOption(
        optionsFor({ currentReading: { time: NOW, price }, currentPriceStatus: 'live' }),
      ).option;
      const targetMark = findMark(option, 'Kalshi target');
      const currentMark = findMark(option, 'Current Coinbase BTC/USD price');
      expect(targetMark.yAxis).toBe(84_010);
      expect(currentMark.yAxis).toBe(price);
      expect(targetMark.label.offset[1]).toBe(-currentMark.label.offset[1]);
      expect(Math.abs(targetMark.label.offset[1] - currentMark.label.offset[1])).toBeGreaterThan(
        20,
      );
      expect(currentMark.label.backgroundColor).not.toBe(targetMark.label.backgroundColor);
    },
  );

  test('uses Coinbase names and never presents the spot chart as BRTI settlement evidence', () => {
    const deadline = NOW + 5 * MINUTE;
    const result = getPriceChartOption(
      optionsFor({
        deadline,
        currentReading: { time: NOW - MINUTE, price: 84_020 },
        currentPriceStatus: 'stale',
        settlement: { points: [{ time: NOW, price: 100_000 }] },
        forecast: {
          available: true,
          expiresAt: deadline,
          kalshi: { settlementLowerBound: 10_000, settlementUpperBound: 200_000 },
        },
      }),
    );
    expect(result.option.series[0].name).toBe('Coinbase BTC/USD 1-minute candles');
    expect(findMark(result.option, 'Last observed Coinbase BTC/USD price')).toBeDefined();
    expect(result.hasModelInterval).toBe(false);
    expect(result.option.series.some((series) => series.id === 'model-range')).toBe(false);
    expect(result.option.series.some((series) => series.id === 'settlement-average')).toBe(false);
    expect(result.option.series[0].markArea.data).toEqual([]);
    expect(result.option.yAxis[0].max).toBeLessThan(100_000);
  });
});

describe('Coinbase chart observations', () => {
  test('joins consecutive completed minute closes and visibly breaks missing minute history', () => {
    const consecutive = getPriceChartOption(optionsFor({ view: 'line' })).option;
    expect(consecutive.series[0].data.every((point) => point.value[1] !== null)).toBe(true);
    const gap = getObservedLineData([readings[0], readings[2]], MINUTE);
    expect(gap.data.map((point) => point.value)).toEqual([
      [readings[0].time, readings[0].price],
      [readings[1].time, null],
      [readings[2].time, readings[2].price],
    ]);
    expect(gap.inspectionIndexes).toEqual([0, 2]);
    const historicalDefault = getObservedLineData([readings[0], readings[1]]);
    expect(historicalDefault.data[1].value).toEqual([readings[0].time + 1000, null]);
  });

  test('describes genuine completed exchange candles without inventing BRTI sample timestamps', () => {
    const candle = candles.at(-1);
    const description = getCandleDescription(candle);
    expect(description).toContain('Coinbase BTC/USD');
    expect(description).toContain('Completed candle');
    expect(description).not.toMatch(/BRTI|Observed|undefined/);
    const tooltip = formatChartTooltip({ seriesId: 'observed-candles', data: { candle } });
    expect(tooltip).toContain('Coinbase BTC/USD');
    expect(tooltip).not.toMatch(/BRTI|observed samples|First|Last|undefined/);
    expect(
      getCandleDescription({
        ...candle,
        isPartial: true,
        sampleCount: 3,
        expectedSampleCount: 5,
      }),
    ).toContain('3/5 completed minute candles · Incomplete interval');
  });

  test('identifies the line inspection as a completed Coinbase close', () => {
    const point = getPriceChartOption(optionsFor({ view: 'line' })).option.series[0].data[0];
    const tooltip = formatChartTooltip({ seriesId: 'observed-price', data: point });
    expect(tooltip).toContain('Coinbase BTC/USD · Completed minute close');
    expect(tooltip).not.toContain('BRTI');
  });
});
