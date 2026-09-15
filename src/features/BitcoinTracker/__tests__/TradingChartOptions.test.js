/** @jest-environment node */

import { init } from 'echarts/dist/echarts';
import { getPriceChartOption } from '../utils/priceChart.utils';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 14, 12);
const DEADLINE = NOW + 6 * MINUTE;
const readings = Array.from({ length: 20 }, (_, index) => ({
  time: NOW - (19 - index) * MINUTE,
  price: 50_000 + index,
}));
const candles = readings.map((reading) => ({
  time: reading.time,
  endTime: reading.time + MINUTE,
  open: reading.price,
  close: reading.price + 2,
  low: reading.price - 3,
  high: reading.price + 5,
  isPartial: false,
}));
const points = readings.map((reading, index) => ({
  time: reading.time,
  ema9: reading.price - 2,
  ema21: reading.price - 3,
  macd: index - 10,
  signal: index - 9,
  histogram: index % 2 ? -1 : 1,
  rsi: 40 + index,
}));
const optionsFor = (overrides = {}) => ({
  readings,
  candles,
  view: 'candles',
  target: 50_000,
  startTime: NOW - 20 * MINUTE,
  endTime: NOW,
  deadline: DEADLINE,
  settlement: { points: [] },
  indicators: { points },
  ...overrides,
});
const getSeries = (option, id) => option.series.find((series) => series.id === id);

describe('trading chart options', () => {
  test.each([130, 200, 230, 240, 247, 270, 400, 680])(
    'fits synchronized price, MACD and RSI panes inside %spx',
    (chartHeight) => {
      const result = getPriceChartOption(
        optionsFor({ showMacd: true, showRsi: true, chartHeight }),
      );
      const { option } = result;
      expect(result.axisEndTime).toBe(DEADLINE);
      expect(option.grid).toHaveLength(3);
      expect(option.xAxis).toHaveLength(3);
      expect(option.yAxis).toHaveLength(3);
      expect(result.indicatorPanels.map((panel) => [panel.id, panel.label])).toEqual([
        ['macd', 'MACD (12, 26, 9)'],
        ['rsi', 'RSI (14)'],
      ]);
      result.indicatorPanels.forEach((panel, index) => {
        const plot = option.grid[index + 1];
        expect(panel.headerHeight).toBeGreaterThan(0);
        expect(panel.headerHeight).toBeLessThanOrEqual(18);
        if (chartHeight >= 200) expect(panel.headerHeight).toBe(18);
        expect(panel.top).toBeCloseTo(
          option.grid[index].top + option.grid[index].height + Math.min(8, chartHeight * 0.04),
        );
        expect(plot.top).toBeCloseTo(panel.top + panel.headerHeight + 6);
        expect(plot.height).toBeCloseTo(panel.height - panel.headerHeight - 6);
        expect(panel.top + panel.height).toBeLessThan(chartHeight);
        expect(plot.show).toBe(true);
        expect(plot.backgroundColor).toBeTruthy();
        expect(plot.borderWidth).toBeGreaterThan(0);
        expect(option.yAxis[index + 1].name).toBe('');
      });
      expect(option.grid[1].backgroundColor).not.toBe(option.grid[2].backgroundColor);
      option.grid.forEach((grid, index) => {
        expect(grid.top).toBeGreaterThanOrEqual(0);
        expect(grid.height).toBeGreaterThan(0);
        expect(grid.top + grid.height).toBeLessThan(chartHeight);
        expect(grid.left).toBe(option.grid[0].left);
        expect(grid.right).toBe(option.grid[0].right);
        if (index)
          expect(grid.top).toBeGreaterThan(
            option.grid[index - 1].top + option.grid[index - 1].height,
          );
        expect(option.xAxis[index]).toMatchObject({
          gridIndex: index,
          min: NOW - 20 * MINUTE,
          max: DEADLINE,
        });
        expect(option.yAxis[index].gridIndex).toBe(index);
      });
      expect(option.dataZoom[0].xAxisIndex).toEqual([0, 1, 2]);
      expect(option.axisPointer.link).toEqual([{ xAxisIndex: 'all' }]);
      expect(option.tooltip).toMatchObject({
        show: true,
        showContent: false,
        renderMode: 'richText',
        axisPointer: { type: 'cross' },
      });
      expect(option.xAxis.map((axis) => axis.axisLabel.show)).toEqual([false, false, true]);
      expect(option.yAxis.every((axis) => axis.axisPointer.label.show)).toBe(true);
    },
  );

  test('retains array axes when indicators are hidden and routes RSI to the second pane when MACD is hidden', () => {
    const plainResult = getPriceChartOption(optionsFor());
    const plain = plainResult.option;
    expect(plainResult.indicatorPanels).toEqual([]);
    expect(plain.grid).toHaveLength(1);
    expect(plain.xAxis).toHaveLength(1);
    expect(plain.yAxis).toHaveLength(1);
    expect(plain.dataZoom[0].xAxisIndex).toEqual([0]);
    expect(getSeries(plain, 'rsi')).toBeUndefined();
    const rsiResult = getPriceChartOption(optionsFor({ showRsi: true }));
    const rsi = rsiResult.option;
    expect(getSeries(rsi, 'rsi')).toMatchObject({ xAxisIndex: 1, yAxisIndex: 1 });
    expect(rsi.yAxis[1]).toMatchObject({ min: 0, max: 100, name: '' });
    expect(rsiResult.indicatorPanels).toEqual([
      expect.objectContaining({ id: 'rsi', label: 'RSI (14)', headerHeight: 18 }),
    ]);
    expect(rsi.grid[1].top).toBe(rsiResult.indicatorPanels[0].top + 18 + 6);
    const macdResult = getPriceChartOption(optionsFor({ showMacd: true }));
    expect(macdResult.indicatorPanels).toEqual([
      expect.objectContaining({ id: 'macd', label: 'MACD (12, 26, 9)', headerHeight: 18 }),
    ]);
    expect(getSeries(macdResult.option, 'macd').xAxisIndex).toBe(1);
  });

  test('shows the supplied indicator values with a signed histogram and explicit RSI thresholds', () => {
    const option = getPriceChartOption(
      optionsFor({ showMacd: true, showRsi: true, showEma: true }),
    ).option;
    expect(getSeries(option, 'ema9').data[0].value).toEqual([points[0].time, points[0].ema9]);
    expect(getSeries(option, 'ema21').data[0].value).toEqual([points[0].time, points[0].ema21]);
    expect(getSeries(option, 'macd').data.at(-1).value).toEqual([NOW, points.at(-1).macd]);
    expect(getSeries(option, 'macd-signal').data.at(-1).value).toEqual([NOW, points.at(-1).signal]);
    const histogram = getSeries(option, 'macd-histogram');
    expect(histogram.type).toBe('bar');
    expect(histogram.data[0]).toMatchObject({
      value: [points[0].time, 1],
      itemStyle: { color: '#4de6a2' },
    });
    expect(histogram.data[1]).toMatchObject({
      value: [points[1].time, -1],
      itemStyle: { color: '#ff7a88' },
    });
    expect(
      getSeries(option, 'rsi')
        .markLine.data.filter((mark) => Number.isFinite(mark.yAxis))
        .map((mark) => mark.yAxis),
    ).toEqual([30, 70]);
  });

  test('does not invent indicator values during warm-up, missing candles or future periods', () => {
    const input = {
      points: [
        { time: NOW - 3 * MINUTE, macd: null },
        { time: NOW - MINUTE, macd: 2 },
        { time: NOW + MINUTE, macd: 999 },
      ],
    };
    const option = getPriceChartOption(optionsFor({ showMacd: true, indicators: input })).option;
    expect(getSeries(option, 'macd').data.map((point) => point.value)).toEqual([
      [NOW - 3 * MINUTE, null],
      [NOW - 2 * MINUTE, null],
      [NOW - MINUTE, 2],
    ]);
    expect(getSeries(option, 'macd').connectNulls).toBe(false);
    expect(input.points).toHaveLength(3);
    expect(
      getSeries(
        getPriceChartOption(optionsFor({ indicators: null, showMacd: true })).option,
        'macd',
      ).data,
    ).toEqual([]);
  });

  test.each([1, 5])(
    'Line indicators appear at their %s-minute close and exclude closes beyond the displayed end',
    (candleMinutes) => {
      const interval = candleMinutes * MINUTE;
      const suppliedPoints = points.slice(-3).map((point, index) => ({
        ...point,
        time: NOW - (2 - index) * interval,
      }));
      const shared = optionsFor({
        candleMinutes,
        indicators: { points: suppliedPoints },
        showMacd: true,
        showRsi: true,
        showEma: true,
      });
      const line = getPriceChartOption({ ...shared, view: 'line' }).option;
      const candle = getPriceChartOption({ ...shared, view: 'candles' }).option;
      for (const [id, field] of [
        ['ema9', 'ema9'],
        ['ema21', 'ema21'],
        ['macd', 'macd'],
        ['macd-signal', 'signal'],
        ['macd-histogram', 'histogram'],
        ['rsi', 'rsi'],
      ]) {
        expect(getSeries(line, id).data.map((point) => point.value)).toEqual(
          suppliedPoints.slice(0, 2).map((point) => [point.time + interval, point[field]]),
        );
        expect(getSeries(candle, id).data.map((point) => point.value)).toEqual(
          suppliedPoints.map((point) => [point.time, point[field]]),
        );
        expect(getSeries(line, id).data.every((point) => point.value[0] <= NOW)).toBe(true);
      }
      expect(suppliedPoints.map((point) => point.time)).toEqual([
        NOW - 2 * interval,
        NOW - interval,
        NOW,
      ]);
    },
  );

  test('shares exact time zoom across panes without rescaling price for drawings or older indicator extremes', () => {
    const zoomRange = { startTime: NOW - 5 * MINUTE, endTime: NOW };
    const base = getPriceChartOption(optionsFor({ zoomRange, showMacd: true })).option;
    const changed = getPriceChartOption(
      optionsFor({
        zoomRange,
        showMacd: true,
        showRsi: true,
        endTime: NOW + 1000,
        indicators: { points: [{ ...points[0], macd: 1_000_000 }, ...points.slice(1)] },
        annotations: [
          { id: 'outlier', type: 'horizontal', price: 1_000_000 },
          {
            id: 'distant',
            type: 'trend',
            start: { time: NOW - 5 * MINUTE, price: 2_000_000 },
            end: { time: NOW, price: 3_000_000 },
          },
        ],
      }),
    ).option;
    expect(changed.dataZoom[0]).toMatchObject({
      startValue: zoomRange.startTime,
      endValue: zoomRange.endTime,
    });
    expect(changed.yAxis[0].min).toBe(base.yAxis[0].min);
    expect(changed.yAxis[0].max).toBe(base.yAxis[0].max);
    expect(changed.yAxis[1].max).toBeLessThan(20);
    expect(changed.series[0].data).toEqual(base.series[0].data);
  });

  test('adds vertical drawings and comparison pins to every pane while keeping trends out of price inspection', () => {
    const time = NOW - 5 * MINUTE;
    const option = getPriceChartOption(
      optionsFor({
        showMacd: true,
        showRsi: true,
        comparisonTime: NOW - MINUTE,
        annotations: [
          { id: 'h', type: 'horizontal', price: 50_010, color: '#f4c56a' },
          { id: 'v', type: 'vertical', time, color: '#6ea8fe' },
          {
            id: 't',
            type: 'trend',
            start: { time, price: 50_002 },
            end: { time: NOW, price: 50_012 },
            label: 'Trend',
          },
          {
            id: 'invalid',
            type: 'trend',
            start: { time, price: NaN },
            end: { time: NOW, price: 50_012 },
          },
        ],
      }),
    ).option;
    for (const id of ['observed-candles', 'macd-histogram', 'rsi']) {
      expect(getSeries(option, id).markLine.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            xAxis: time,
            lineStyle: { color: '#6ea8fe', width: 1, type: 'solid' },
          }),
          expect.objectContaining({ xAxis: NOW - MINUTE, name: 'Comparison' }),
          expect.objectContaining({ xAxis: DEADLINE }),
        ]),
      );
      expect(getSeries(option, id).markLine.silent).toBe(true);
    }
    expect(option.series[0].markLine.data).toContainEqual(
      expect.objectContaining({ yAxis: 50_010 }),
    );
    expect(getSeries(option, 'annotation-t')).toMatchObject({
      data: [
        [time, 50_002],
        [NOW, 50_012],
      ],
      silent: true,
      clip: true,
      tooltip: { show: false, trigger: 'none' },
    });
    expect(getSeries(option, 'annotation-invalid')).toBeUndefined();
  });

  test.each(['line', 'candles'])(
    '%s horizontal drawings show their exact price in a matching right-axis box across zoom',
    (view) => {
      const drawing = {
        id: 'priced-level',
        type: 'horizontal',
        price: 50_012.34,
        color: '#6ea8fe',
        label: 'My support level',
      };
      const baseline = getPriceChartOption(optionsFor({ view })).option;
      const original = getPriceChartOption(
        optionsFor({
          view,
          annotations: [drawing, { id: 'time', type: 'vertical', time: NOW - MINUTE }],
        }),
      ).option;
      const mark = original.series[0].markLine.data.find((item) => item.yAxis === drawing.price);
      expect(mark.label).toMatchObject({
        show: true,
        position: 'end',
        formatter: '$50,012.34',
        color: drawing.color,
        borderColor: drawing.color,
        borderWidth: 1,
        borderRadius: 2,
      });
      expect(mark.label.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(original.yAxis[0].min).toBe(baseline.yAxis[0].min);
      expect(original.yAxis[0].max).toBe(baseline.yAxis[0].max);
      expect(original.series[0].markLine.label.show).toBe(false);
      expect(
        original.series[0].markLine.data
          .filter((item) => item !== mark)
          .every((item) => item.label?.show !== true),
      ).toBe(true);
      const zoomRange = { startTime: NOW - 5 * MINUTE, endTime: NOW - 2 * MINUTE };
      const zoomed = getPriceChartOption(
        optionsFor({ view, zoomRange, annotations: [drawing] }),
      ).option;
      expect(zoomed.series[0].markLine.data.find((item) => item.yAxis === drawing.price)).toEqual(
        mark,
      );
      expect(zoomed.dataZoom[0]).toMatchObject({
        startValue: zoomRange.startTime,
        endValue: zoomRange.endTime,
      });

      const chart = init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 240 });
      try {
        for (const option of [original, zoomed]) {
          chart.setOption(option, { notMerge: true });
          const svg = chart.renderToSVGString();
          expect(svg).toContain('$50,012.34');
          expect(svg).not.toContain(drawing.label);
          const shapes = [...svg.matchAll(/<(?:path|rect)\b[^>]*>/g)].map((match) => match[0]);
          expect(
            shapes.some(
              (shape) =>
                shape.includes(`fill="${mark.label.backgroundColor}"`) &&
                shape.includes(`stroke="${drawing.color}"`),
            ),
          ).toBe(true);
        }
        const offscreen = getPriceChartOption(
          optionsFor({
            view,
            annotations: [{ ...drawing, price: 500_000.12 }],
          }),
        ).option;
        expect(offscreen.yAxis[0].min).toBe(baseline.yAxis[0].min);
        expect(offscreen.yAxis[0].max).toBe(baseline.yAxis[0].max);
        chart.setOption(offscreen, { notMerge: true });
        expect(chart.renderToSVGString()).not.toContain('$500,000.12');
      } finally {
        chart.dispose();
      }
    },
  );

  test('drawing disables chart gestures while retaining a crosshair, original candle metadata and settlement overlays', () => {
    const partial = { ...candles.at(-1), isPartial: true };
    const result = getPriceChartOption(
      optionsFor({
        isDrawing: true,
        candleMinutes: 5,
        candles: [...candles.slice(0, -1), partial],
        forecast: {
          available: true,
          expiresAt: DEADLINE,
          kalshi: { settlementLowerBound: 49_950, settlementUpperBound: 50_050 },
        },
        settlement: { points: [{ time: NOW, price: 50_012, sampleCount: 3 }] },
      }),
    );
    const { option } = result;
    expect(option.dataZoom[0]).toMatchObject({
      disabled: true,
      moveOnMouseMove: false,
      zoomOnMouseWheel: false,
    });
    expect(option.tooltip.axisPointer.type).toBe('cross');
    expect(option.series[0].name).toBe('BRTI 5-minute candles');
    expect(option.series[0].data.at(-1)).toMatchObject({
      candle: partial,
      itemStyle: { opacity: 0.65 },
    });
    expect(result.inspectionIndexes).toEqual(candles.map((_, index) => index));
    expect(getSeries(option, 'settlement-average').data[0].sampleCount).toBe(3);
    expect(result.hasModelInterval).toBe(true);
    expect(getSeries(option, 'model-range').data.map((point) => point.value)).toEqual([
      [DEADLINE, 49_950],
      [DEADLINE, 50_050],
    ]);
    expect(option.series[0].markArea.data).toEqual([
      [{ xAxis: DEADLINE - MINUTE }, { xAxis: DEADLINE }],
    ]);
  });

  test('renders all three panes through ECharts SVG without invalid coordinates', () => {
    const chart = init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 240 });
    try {
      chart.setOption(
        getPriceChartOption(
          optionsFor({ showMacd: true, showRsi: true, showEma: true, chartHeight: 240 }),
        ).option,
      );
      const svg = chart.renderToSVGString();
      expect(svg).toContain('#0d171b');
      expect(svg).toContain('#171320');
      expect(svg).not.toContain('MACD 12/26/9');
      expect(svg).not.toContain('RSI 14');
      expect(svg).not.toContain('NaN');
      expect(svg).not.toContain('Infinity');
    } finally {
      chart.dispose();
    }
  });
});
