import { formatDateTime, formatPrice } from './format.utils';
import { getPressureLocation, getPressureVolatility } from './pressureForecast.utils';

const MINUTE = 60_000;
const RANGE_MULTIPLIER = 1.2815515655;

export function getChartPoints(candles, ticker, startTime, endTime) {
  const points = candles
    .filter(
      (candle) =>
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.close) &&
        candle.close > 0 &&
        candle.time + MINUTE >= startTime &&
        candle.time + MINUTE <= endTime,
    )
    .map((candle) => ({
      time: candle.time + MINUTE,
      price: candle.close,
      source: 'One-minute close',
    }))
    .sort((first, second) => first.time - second.time);

  if (
    Number.isFinite(ticker?.price) &&
    ticker.price > 0 &&
    Number.isFinite(ticker.time) &&
    ticker.time >= startTime &&
    ticker.time <= endTime &&
    (!points.length || ticker.time >= points.at(-1).time)
  ) {
    // A delayed trade must never replace a newer completed candle.
    if (points.at(-1)?.time === ticker.time) points.pop();
    points.push({ time: ticker.time, price: ticker.price, source: 'Latest trade' });
  }
  return points;
}

export function formatChartTooltip(parameters) {
  const entries = Array.isArray(parameters) ? parameters : [parameters];
  const observed = entries.find(
    (entry) => entry.seriesId === 'observed-price' && entry.data?.source,
  );
  if (observed) {
    const [time, price] = observed.data.value;
    return `${formatDateTime(time)}<br/>${observed.data.source}<br/><strong>${formatPrice(price)} USD</strong>`;
  }

  const interval = entries.find((entry) => entry.seriesId === 'model-range');
  if (interval) {
    return `${formatDateTime(interval.data.value[0])}<br/>Live model 80% range<br/><strong>${formatPrice(interval.data.lower)}–${formatPrice(interval.data.upper)} USD</strong><br/>Model range only · no observed future price`;
  }
  return '';
}

export function getPriceChartOption({
  points,
  ticker,
  forecast,
  target,
  startTime,
  endTime,
  futureMinutes,
}) {
  const hasModelInterval = Boolean(
    forecast?.available &&
    Number.isFinite(forecast.volatility) &&
    forecast.volatility >= 0 &&
    Number.isFinite(forecast.lowerBound) &&
    Number.isFinite(forecast.upperBound) &&
    Number.isFinite(ticker?.price) &&
    ticker.price > 0 &&
    futureMinutes > 0,
  );
  const lastPoint = points.at(-1);
  const isPriceRising = !lastPoint || lastPoint.price >= points[0].price;
  const lineColor = isPriceRising ? '#4de6a2' : '#ff7a88';
  const colors = isPriceRising ? '77, 230, 162' : '255, 122, 136';
  const prices = points.map((point) => point.price);
  if (hasModelInterval) prices.push(forecast.lowerBound, forecast.upperBound);
  const minimum = prices.length ? Math.min(...prices) : 0;
  const maximum = prices.length ? Math.max(...prices) : 1;
  const padding = Math.max((maximum - minimum) * 0.2, maximum * 0.0003);
  const low = minimum - padding;
  const high = maximum + padding;
  const hasVisibleTarget = Number.isFinite(target) && target >= low && target <= high;
  const modelPoints = hasModelInterval
    ? Array.from({ length: 16 }, (_, index) => {
        const fraction = index / 15;
        const spread = RANGE_MULTIPLIER * getPressureVolatility(forecast, fraction);
        const location = getPressureLocation(forecast, fraction);
        return {
          time: endTime + fraction * futureMinutes * MINUTE,
          lower: ticker.price * Math.exp(location - spread),
          upper: ticker.price * Math.exp(location + spread),
        };
      })
    : [];
  const axisEnd = endTime + futureMinutes * MINUTE;

  return {
    hasModelInterval,
    hasVisibleTarget,
    option: {
      animation: false,
      backgroundColor: 'transparent',
      grid: { top: 16, left: 4, right: 84, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        triggerOn: 'mousemove|click',
        confine: true,
        backgroundColor: '#101a14',
        borderColor: '#506b59',
        textStyle: { color: '#e3eee6', fontSize: 12 },
        axisPointer: { type: 'line', snap: true, lineStyle: { color: '#afc3b6', type: 'dashed' } },
        formatter: formatChartTooltip,
      },
      xAxis: {
        type: 'time',
        min: startTime,
        max: axisEnd,
        splitNumber: 3,
        axisLine: { lineStyle: { color: '#2c3b33' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#afc3b6',
          fontSize: 10,
          hideOverlap: true,
          formatter: (time) =>
            new Date(time).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }),
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        position: 'right',
        min: low,
        max: high,
        splitNumber: 4,
        axisLabel: { color: '#afc3b6', fontSize: 10, formatter: formatPrice, hideOverlap: true },
        axisPointer: { show: false },
        splitLine: { lineStyle: { color: '#2c3b33', type: 'dashed' } },
      },
      series: [
        {
          id: 'observed-price',
          name: 'BTC/USD',
          type: 'line',
          data: points.map((point) => ({ value: [point.time, point.price], source: point.source })),
          showSymbol: false,
          symbolSize: 7,
          smooth: false,
          lineStyle: { color: lineColor, width: 2 },
          itemStyle: { color: lineColor },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: `rgba(${colors}, 0.3)` },
                { offset: 1, color: `rgba(${colors}, 0)` },
              ],
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            data: [
              { xAxis: endTime, lineStyle: { color: '#667e6e', type: 'dashed', width: 1 } },
              ...(hasVisibleTarget
                ? [{ yAxis: target, lineStyle: { color: '#f0c577', type: 'dashed', width: 1 } }]
                : []),
            ],
          },
          markArea: {
            silent: true,
            itemStyle: { color: `rgba(${colors}, 0.045)` },
            data: futureMinutes > 0 ? [[{ xAxis: endTime }, { xAxis: axisEnd }]] : [],
          },
        },
        ...(hasModelInterval
          ? [
              {
                id: 'model-base',
                name: 'Model lower bound',
                type: 'line',
                stack: 'model-interval',
                data: modelPoints.map((point) => [point.time, point.lower]),
                showSymbol: false,
                lineStyle: { width: 1, color: `rgba(${colors}, 0.5)`, type: 'dashed' },
                areaStyle: { opacity: 0 },
                emphasis: { disabled: true },
              },
              {
                id: 'model-range',
                name: 'Live model 80% range',
                type: 'line',
                stack: 'model-interval',
                data: modelPoints.map((point) => ({
                  value: [point.time, point.upper - point.lower],
                  lower: point.lower,
                  upper: point.upper,
                })),
                showSymbol: false,
                lineStyle: { width: 1, color: `rgba(${colors}, 0.5)`, type: 'dashed' },
                areaStyle: { color: `rgba(${colors}, 0.12)` },
                emphasis: { disabled: true },
              },
            ]
          : []),
      ],
    },
  };
}
