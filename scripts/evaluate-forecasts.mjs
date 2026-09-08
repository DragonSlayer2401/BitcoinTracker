import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import jStat from 'jstat';
import { getForecast } from '../src/features/BitcoinTracker/utils/forecast.utils.js';
import { parseCandles } from '../src/services/coinbase/coinbase.service.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WINDOW_MINUTES = 15;
const HISTORY_MINUTES = 120;
const TARGET_OFFSETS = [-0.0025, -0.001, 0, 0.001, 0.0025];
const CAPTURE_DELAYS = [0, 3];
const CANDIDATE_MINUTES = [0, 2, 3, 4, 5];
const MODEL_NAMES = ['normal-120', 'ewma-10', 'ewma-30', 'blend-30-120', 'student-t-5'];
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, '').split('=');
    return [key, value.join('=') || true];
  }),
);
const days = Number(options.days || 14);
const end = options.end ? Date.parse(options.end) : Math.floor(Date.now() / DAY) * DAY;
if (!Number.isInteger(days) || days < 3 || days > 30 || !Number.isSafeInteger(end) || end % DAY) {
  throw new Error('Use --days=3..30 and an optional --end=YYYY-MM-DDT00:00:00Z.');
}
if (end > Date.now()) throw new Error('The evaluation end must be in the past.');
const start = end - days * DAY;
const split = start + Math.floor((days * 2) / 3) * DAY;
const outputDirectory = path.resolve('test-artifacts/forecast-evaluation');
const cacheDirectory = path.join(outputDirectory, 'candles');
await mkdir(cacheDirectory, { recursive: true });

async function getCandlePage(pageStart, pageEnd) {
  const cachePath = path.join(cacheDirectory, `${pageStart}-${pageEnd}.json`);
  let payload;
  try {
    payload = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (options.offline) throw new Error(`Missing cached candle page: ${cachePath}`);
    const parameters = new URLSearchParams({
      granularity: '60',
      start: new Date(pageStart).toISOString(),
      end: new Date(pageEnd).toISOString(),
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      await delay(attempt === 0 ? 1000 : 2000 * 2 ** attempt);
      try {
        const response = await fetch(
          `https://api.exchange.coinbase.com/products/BTC-USD/candles?${parameters}`,
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
        );
        if (!response.ok) throw new Error(`Coinbase HTTP ${response.status}`);
        payload = await response.json();
        parseCandles(payload);
        await writeFile(cachePath, `${JSON.stringify(payload)}\n`);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
  }
  return parseCandles(payload).filter(
    (candle) => candle.time >= pageStart && candle.time < pageEnd,
  );
}

const candleMap = new Map();
let pages = 0;
for (let pageStart = start - HISTORY_MINUTES * MINUTE; pageStart < end; pageStart += 299 * MINUTE) {
  const pageEnd = Math.min(end, pageStart + 299 * MINUTE);
  for (const candle of await getCandlePage(pageStart, pageEnd)) candleMap.set(candle.time, candle);
  pages++;
  if (pages % 10 === 0) console.log(`Loaded ${pages} pages / ${candleMap.size} minute candles`);
}
const candles = [...candleMap.values()].sort((first, second) => first.time - second.time);

function getWeightedVariance(returns, halfLifeMinutes) {
  const weights = returns.map((_, index) => 2 ** (-(returns.length - 1 - index) / halfLifeMinutes));
  const weightSum = jStat.sum(weights);
  const mean = jStat.sum(returns.map((value, index) => value * weights[index])) / weightSum;
  const squaredErrors = jStat.sum(
    returns.map((value, index) => weights[index] * (value - mean) ** 2),
  );
  // Weighted sample correction; equal weights reduce to the n - 1 denominator.
  return squaredErrors / (weightSum - jStat.sumsqrd(weights) / weightSum);
}

function getModelProbability(model, history, price, target, horizonMinutes, baseline) {
  if (model === 'normal-120') return baseline.aboveProbability;
  const returns = history
    .slice(1)
    .map((candle, index) => Math.log(candle.close / history[index].close));
  const fullVariance = jStat.variance(returns, true);
  const variance =
    model === 'ewma-10'
      ? getWeightedVariance(returns, 10)
      : model === 'ewma-30'
        ? getWeightedVariance(returns, 30)
        : model === 'blend-30-120'
          ? (jStat.variance(returns.slice(-30), true) + fullVariance) / 2
          : fullVariance;
  const volatility = Math.sqrt(variance * horizonMinutes);
  const distance = (Math.log(target) - Math.log(price)) / volatility;
  // Scale the t distribution to the same variance as the normal baseline.
  const probability =
    model === 'student-t-5'
      ? 1 - jStat.studentt.cdf(distance / Math.sqrt(3 / 5), 5)
      : 1 - jStat.normal.cdf(distance, 0, 1);
  return Math.max(0.01, Math.min(0.99, probability));
}

const records = [];
const policyRecords = [];
const windows = {
  development: 0,
  test: 0,
  missing: 0,
  unavailable: 0,
  purged: 0,
  equalOutcomes: 0,
};
for (
  let windowStart = start;
  windowStart + WINDOW_MINUTES * MINUTE <= end;
  windowStart += WINDOW_MINUTES * MINUTE
) {
  const windowEnd = windowStart + WINDOW_MINUTES * MINUTE;
  // Keep forecast outcomes entirely before development cutoff; leave a 15-minute gap.
  const partition =
    windowEnd <= split ? 'development' : windowStart >= split + 15 * MINUTE ? 'test' : null;
  if (!partition) {
    windows.purged++;
    continue;
  }
  const required = Array.from({ length: HISTORY_MINUTES + WINDOW_MINUTES }, (_, index) =>
    candleMap.get(windowStart + (index - HISTORY_MINUTES) * MINUTE),
  );
  if (required.some((candle) => !candle)) {
    windows.missing++;
    continue;
  }
  const initialPrice = candleMap.get(windowStart - MINUTE).close;
  const observedPrice = candleMap.get(windowEnd - MINUTE).close;
  const captures = CANDIDATE_MINUTES.map((captureDelay) => {
    const capturedAt = windowStart + captureDelay * MINUTE;
    const history = Array.from({ length: HISTORY_MINUTES }, (_, index) =>
      candleMap.get(capturedAt + (index - HISTORY_MINUTES) * MINUTE),
    );
    const price = history.at(-1).close;
    const input = {
      candles: history,
      ticker: {
        price,
        bid: price,
        ask: price,
        volume: 0,
        time: capturedAt,
        receivedAt: capturedAt,
      },
      target: initialPrice,
      now: capturedAt,
      horizonMinutes: WINDOW_MINUTES - captureDelay,
    };
    return { captureDelay, history, price, input, baseline: getForecast(input) };
  });
  if (captures.some((capture) => !capture.baseline.available)) {
    windows.unavailable++;
    continue;
  }
  windows[partition]++;
  for (const targetOffset of TARGET_OFFSETS) {
    const target = initialPrice * (1 + targetOffset);
    if (observedPrice === target) {
      windows.equalOutcomes++;
      continue;
    }
    for (const model of MODEL_NAMES) {
      const predictions = captures.map((capture) => {
        const baseline = getForecast({ ...capture.input, target });
        const probability = getModelProbability(
          model,
          capture.history,
          capture.price,
          target,
          capture.input.horizonMinutes,
          baseline,
        );
        if (!Number.isFinite(probability))
          throw new Error('A candidate produced an invalid probability.');
        return {
          partition,
          windowStart,
          targetOffset,
          captureDelay: capture.captureDelay,
          model,
          probability,
          outcome: Number(observedPrice > target),
        };
      });
      records.push(...predictions.filter((record) => CAPTURE_DELAYS.includes(record.captureDelay)));
      const stablePrediction = predictions.find((prediction, index) => {
        if (prediction.captureDelay < 3) return false;
        const previous = predictions[index - 1];
        return (
          (prediction.probability >= 0.65 && previous.probability >= 0.65) ||
          (prediction.probability <= 0.35 && previous.probability <= 0.35)
        );
      });
      policyRecords.push({
        partition,
        windowStart,
        targetOffset,
        model,
        probability: stablePrediction?.probability ?? null,
        captureDelay: stablePrediction?.captureDelay ?? null,
        outcome: Number(observedPrice > target),
        immediateProbability: predictions.find((prediction) => prediction.captureDelay === 0)
          .probability,
        delayedProbability: predictions.find((prediction) => prediction.captureDelay === 3)
          .probability,
      });
    }
  }
}

function summarize(selected) {
  const calls = selected.filter(
    (record) => Math.max(record.probability, 1 - record.probability) >= 0.55,
  );
  return {
    forecasts: selected.length,
    windows: new Set(selected.map((record) => record.windowStart)).size,
    brier: selected.length
      ? jStat.mean(selected.map((record) => (record.probability - record.outcome) ** 2))
      : null,
    directionalAccuracy: selected.length
      ? jStat.mean(
          selected.map((record) =>
            Math.abs(record.probability - 0.5) <= 1e-12
              ? 0.5
              : Number(Number(record.probability > 0.5) === record.outcome),
          ),
        )
      : null,
    callAccuracy: calls.length
      ? jStat.mean(
          calls.map((record) => Number(Number(record.probability > 0.5) === record.outcome)),
        )
      : null,
    callCoverage: selected.length ? calls.length / selected.length : null,
    noCallRate: selected.length ? 1 - calls.length / selected.length : null,
  };
}

const results = [];
for (const partition of ['development', 'test']) {
  for (const captureDelay of CAPTURE_DELAYS) {
    for (const model of MODEL_NAMES) {
      const selected = records.filter(
        (record) =>
          record.partition === partition &&
          record.captureDelay === captureDelay &&
          record.model === model,
      );
      results.push({
        partition,
        captureDelay,
        model,
        ...summarize(selected),
        byTarget: TARGET_OFFSETS.map((targetOffset) => ({
          targetOffset,
          ...summarize(selected.filter((record) => record.targetOffset === targetOffset)),
        })),
      });
    }
  }
}
const selections = CAPTURE_DELAYS.map((captureDelay) => {
  const development = results
    .filter(
      (result) =>
        result.partition === 'development' &&
        result.captureDelay === captureDelay &&
        result.brier !== null,
    )
    .sort((first, second) => first.brier - second.brier);
  return {
    captureDelay,
    selectedModel: development[0]?.model ?? null,
    developmentBrier: development[0]?.brier ?? null,
  };
});
function summarizePolicy(selected) {
  const emitted = selected.filter((record) => record.probability !== null);
  return {
    eligibleForecasts: selected.length,
    emittedForecasts: emitted.length,
    callCoverage: selected.length ? emitted.length / selected.length : null,
    noCallRate: selected.length ? 1 - emitted.length / selected.length : null,
    meanCaptureDelay: emitted.length
      ? jStat.mean(emitted.map((record) => record.captureDelay))
      : null,
    emitted: summarize(emitted),
    immediateOnSameCalls: summarize(
      emitted.map((record) => ({ ...record, probability: record.immediateProbability })),
    ),
    delayedOnSameCalls: summarize(
      emitted.map((record) => ({ ...record, probability: record.delayedProbability })),
    ),
  };
}
const policyResults = ['development', 'test'].flatMap((partition) =>
  MODEL_NAMES.map((model) => {
    const selected = policyRecords.filter(
      (record) => record.partition === partition && record.model === model,
    );
    return {
      partition,
      model,
      ...summarizePolicy(selected),
      byTarget: TARGET_OFFSETS.map((targetOffset) => ({
        targetOffset,
        ...summarizePolicy(selected.filter((record) => record.targetOffset === targetOffset)),
      })),
    };
  }),
);
const report = {
  generatedAt: new Date().toISOString(),
  source: 'Coinbase Exchange BTC-USD 60-second candles',
  baselineModelVersion: getForecast({}).modelVersion,
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  developmentEnd: new Date(split).toISOString(),
  testStart: new Date(split + 15 * MINUTE).toISOString(),
  candles: candles.length,
  expectedCandles: (end - start) / MINUTE + HISTORY_MINUTES,
  candleSha256: createHash('sha256').update(JSON.stringify(candles)).digest('hex'),
  targetOffsets: TARGET_OFFSETS,
  windows,
  selections,
  results,
  policy:
    'First minute 3, 4, or 5 with same-direction probability at least 65% at that minute and one minute earlier; otherwise abstain. Minute-close proxy only.',
  policyResults,
  metricNotes:
    'Brier is mean squared probability error. Call accuracy excludes probabilities between 45% and 55%; directional accuracy assigns half credit to exact 50/50 ties. Policy Brier is conditional on emitted calls and must be read with coverage.',
};
const reportPath = path.join(
  outputDirectory,
  `report-${new Date(end).toISOString().slice(0, 10)}-${days}d.json`,
);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    { reportPath, windows, selections, results: results.map(({ byTarget, ...result }) => result) },
    null,
    2,
  ),
);
