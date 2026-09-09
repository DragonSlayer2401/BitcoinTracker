import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import jStat from 'jstat';
import { getForecast } from '../src/features/BitcoinTracker/utils/forecast.utils.js';
import { loadEvaluationCandles } from './forecast-evaluation/candles.mjs';
import {
  FEATURE_GROUPS,
  FEATURE_NAMES,
  getDirectionalFeatures,
  summarizeHistory,
} from './forecast-evaluation/features.mjs';
import {
  fitLogistic,
  getBoundedProbability,
  logit,
  predictLogistic,
  scoreProbabilities,
} from './forecast-evaluation/statistics.mjs';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const HORIZONS = [3, 5, 10, 15];
const WAITS = [0, 1, 3, 5];
const THRESHOLDS = [0.55, 0.65, 0.75];
const OFFSETS = [-0.0025, -0.001, 0, 0.001, 0.0025];
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, '').split('=');
    return [key, rest.join('=') || true];
  }),
);
const end = Date.parse(options.end || '2026-09-08T00:00:00Z');
if (!Number.isSafeInteger(end) || end % DAY || end > Date.now())
  throw new Error('Use a completed UTC midnight --end.');
const start = end - 30 * DAY;
const trainEnd = start + 18 * DAY;
const calibrationStart = trainEnd + 15 * MINUTE;
const calibrationEnd = start + 24 * DAY;
const testStart = calibrationEnd + 15 * MINUTE;
const outputDirectory = path.resolve('test-artifacts/forecast-evaluation');
await mkdir(outputDirectory, { recursive: true });
const candles = await loadEvaluationCandles({
  start: start - 120 * MINUTE,
  end,
  offline: Boolean(options.offline),
});
const candleMap = new Map(candles.map((candle) => [candle.time, candle]));
const dataHash = createHash('sha256').update(JSON.stringify(candles)).digest('hex');
const rows = [];
const exclusions = {
  missingWindows: 0,
  unavailableCaptures: 0,
  equalTargets: 0,
  embargoWindows: 0,
};
for (let windowStart = start; windowStart + 15 * MINUTE <= end; windowStart += 15 * MINUTE) {
  const partition =
    windowStart + 15 * MINUTE <= trainEnd
      ? 'train'
      : windowStart >= calibrationStart && windowStart + 15 * MINUTE <= calibrationEnd
        ? 'calibration'
        : windowStart >= testStart
          ? 'test'
          : null;
  if (!partition) {
    exclusions.embargoWindows++;
    continue;
  }
  const required = Array.from({ length: 135 }, (_, index) =>
    candleMap.get(windowStart + (index - 120) * MINUTE),
  );
  if (required.some((candle) => !candle)) {
    exclusions.missingWindows++;
    continue;
  }
  const initialPrice = candleMap.get(windowStart - MINUTE).close;
  for (const horizon of HORIZONS) {
    const expiresAt = windowStart + horizon * MINUTE;
    const observedPrice = candleMap.get(expiresAt - MINUTE).close;
    for (const wait of WAITS.filter((value) => value < horizon)) {
      const capturedAt = windowStart + wait * MINUTE;
      const remainingMinutes = horizon - wait;
      const history = Array.from({ length: 120 }, (_, index) =>
        candleMap.get(capturedAt + (index - 120) * MINUTE),
      );
      const price = history.at(-1).close;
      const baseline = getForecast({
        candles: history,
        ticker: {
          price,
          bid: price,
          ask: price,
          volume: 0,
          time: capturedAt,
          receivedAt: capturedAt,
        },
        target: price,
        now: capturedAt,
        horizonMinutes: remainingMinutes,
      });
      if (!baseline.available) {
        exclusions.unavailableCaptures++;
        continue;
      }
      const summary = summarizeHistory(history);
      const captureKey = `${windowStart}:${horizon}:${wait}`;
      for (const offset of OFFSETS) {
        const target = initialPrice * (1 + offset);
        if (observedPrice === target) {
          exclusions.equalTargets++;
          continue;
        }
        const probabilities = {
          'fair-coin': 0.5,
          'current-side': price === target ? 0.5 : Number(price > target),
        };
        const intervals = {};
        for (const [name, variance] of Object.entries(summary.variances)) {
          const deviation = Math.sqrt(variance * remainingMinutes);
          probabilities[name] = getBoundedProbability(
            jStat.normal.cdf((Math.log(price) - Math.log(target)) / deviation, 0, 1),
          );
          intervals[name] =
            observedPrice >= price * Math.exp(-1.2815515655446004 * deviation) &&
            observedPrice <= price * Math.exp(1.2815515655446004 * deviation);
        }
        rows.push({
          partition,
          windowStart,
          capturedAt,
          expiresAt,
          horizon,
          wait,
          remainingMinutes,
          offset,
          captureKey,
          target,
          price,
          observedPrice,
          outcome: Number(observedPrice > target),
          currentSide: probabilities['current-side'],
          sigma: summary.sigma,
          trend: summary.trend,
          features: getDirectionalFeatures(summary, target, remainingMinutes),
          probabilities,
          intervals,
        });
      }
    }
  }
}
const training = rows.filter((row) => row.partition === 'train');
const calibration = rows.filter((row) => row.partition === 'calibration');
const testing = rows.filter((row) => row.partition === 'test');
if (!training.length || !calibration.length || !testing.length)
  throw new Error('All chronological partitions need eligible examples.');
const trainingVolatility = [
  ...new Map(training.map((row) => [row.capturedAt, row.sigma])).values(),
].sort((a, b) => a - b);
const volatilityCuts = [
  trainingVolatility[Math.floor(trainingVolatility.length / 3)],
  trainingVolatility[Math.floor((trainingVolatility.length * 2) / 3)],
];
for (const row of rows)
  row.regime = `${row.sigma < volatilityCuts[0] ? 'low' : row.sigma > volatilityCuts[1] ? 'high' : 'medium'}-volatility/${row.trend > 1 ? 'up' : row.trend < -1 ? 'down' : 'flat'}`;

const fittedModels = {};
for (const [name, indexes] of Object.entries(FEATURE_GROUPS)) {
  console.log(`Fitting ${name} on ${training.length} training examples.`);
  const model = fitLogistic(training, indexes);
  fittedModels[name] = model;
  for (const row of rows)
    row.probabilities[`logistic-${name}`] = predictLogistic(model, row.features);
}
const fittedCalibrators = {};
for (const name of Object.keys(rows[0].probabilities).filter(
  (name) => !['fair-coin', 'current-side'].includes(name),
)) {
  const calibrator = fitLogistic(
    calibration.map((row) => ({
      features: [logit(row.probabilities[name])],
      outcome: row.outcome,
    })),
    [0],
    { penalty: 0.001 },
  );
  fittedCalibrators[name] = calibrator;
  for (const row of rows)
    row.probabilities[`${name}-calibrated`] = predictLogistic(calibrator, [
      logit(row.probabilities[name]),
    ]);
}
const modelNames = Object.keys(rows[0].probabilities);
const scoredRows = (selected, model) =>
  selected.map((row) => ({
    ...row,
    probability: row.probabilities[model],
    intervalCovered: row.intervals[model],
  }));
const summaries = [];
for (const partition of ['calibration', 'test']) {
  const selected = partition === 'test' ? testing : calibration;
  for (const model of modelNames) {
    const scored = scoredRows(selected, model);
    summaries.push({
      partition,
      model,
      overall: scoreProbabilities(scored),
      byHorizon: HORIZONS.map((horizon) => ({
        horizon,
        ...scoreProbabilities(scored.filter((row) => row.horizon === horizon)),
      })),
      byRegime: [...new Set(scored.map((row) => row.regime))].sort().map((regime) => ({
        regime,
        ...scoreProbabilities(scored.filter((row) => row.regime === regime)),
      })),
      byHorizonAndRegime: HORIZONS.flatMap((horizon) =>
        [...new Set(scored.map((row) => row.regime))].sort().map((regime) => ({
          horizon,
          regime,
          ...scoreProbabilities(
            scored.filter((row) => row.horizon === horizon && row.regime === regime),
          ),
        })),
      ),
      byHorizonAndWait: HORIZONS.flatMap((horizon) =>
        WAITS.filter((wait) => wait < horizon).map((wait) => ({
          horizon,
          wait,
          ...scoreProbabilities(
            scored.filter((row) => row.horizon === horizon && row.wait === wait),
          ),
        })),
      ),
    });
  }
}

// Select waiting/threshold on calibration only. Correct-minus-incorrect calls per
// eligible example penalizes abstention; this is not a trading-profit objective.
const policies = [];
for (const model of modelNames.filter((name) => !['fair-coin', 'current-side'].includes(name))) {
  for (const horizon of HORIZONS) {
    const candidates = WAITS.filter((wait) => wait < horizon)
      .flatMap((wait) =>
        THRESHOLDS.map((threshold) => {
          const metrics = scoreProbabilities(
            scoredRows(
              calibration.filter((row) => row.horizon === horizon && row.wait === wait),
              model,
            ),
            threshold,
          );
          return {
            wait,
            threshold,
            metrics,
            utility: (metrics.callCoverage ?? 0) * (2 * (metrics.callAccuracy ?? 0.5) - 1),
          };
        }),
      )
      .sort((a, b) => b.utility - a.utility || a.wait - b.wait || a.threshold - b.threshold);
    const selection = candidates[0];
    const testRows = scoredRows(
      testing.filter((row) => row.horizon === horizon && row.wait === selection.wait),
      model,
    );
    policies.push({
      model,
      horizon,
      selectedWait: selection.wait,
      selectedThreshold: selection.threshold,
      calibrationUtility: selection.utility,
      calibrationCandidates: candidates,
      test: scoreProbabilities(testRows, selection.threshold),
      testAtOriginalSpot: scoreProbabilities(
        testRows.filter((row) => row.offset === 0),
        selection.threshold,
      ),
    });
  }
}
const selectedModels = HORIZONS.map((horizon) => {
  const ranked = policies
    .filter((policy) => policy.horizon === horizon)
    .sort(
      (a, b) =>
        b.calibrationUtility - a.calibrationUtility ||
        a.selectedWait - b.selectedWait ||
        a.model.localeCompare(b.model),
    );
  return {
    horizon,
    selected: ranked[0],
    selectionSource: 'calibration only; retrospectively inspected period',
  };
});
const sourceHashes = {};
for (const filename of [
  'scripts/evaluate-market-awareness.mjs',
  'scripts/forecast-evaluation/candles.mjs',
  'scripts/forecast-evaluation/features.mjs',
  'scripts/forecast-evaluation/statistics.mjs',
  'src/features/BitcoinTracker/utils/forecast.utils.js',
])
  sourceHashes[filename] = createHash('sha256')
    .update(await readFile(filename))
    .digest('hex');
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  study: 'market-awareness-retrospective-v1',
  outcomeDefinition: 'coinbase-minute-close-proxy-at-deadline-v1',
  promotionStatus:
    'Not approved. The test dates overlap previously inspected data; prospective validation is required.',
  consumedPriorStudy: {
    start: '2026-08-25T00:00:00Z',
    end: '2026-09-08T00:00:00Z',
    report: 'report-2026-09-08-14d.json',
  },
  bounds: Object.fromEntries(
    Object.entries({ start, trainEnd, calibrationStart, calibrationEnd, testStart, end }).map(
      ([key, value]) => [key, new Date(value).toISOString()],
    ),
  ),
  data: {
    candles: candles.length,
    expectedCandles: 30 * 1440 + 120,
    sha256: dataHash,
    exclusions,
    partitions: ['train', 'calibration', 'test'].map((partition) => ({
      partition,
      examples: rows.filter((row) => row.partition === partition).length,
      windows: new Set(
        rows.filter((row) => row.partition === partition).map((row) => row.windowStart),
      ).size,
    })),
  },
  configuration: {
    horizons: HORIZONS,
    waits: WAITS,
    thresholds: THRESHOLDS,
    offsets: OFFSETS,
    embargoMinutes: 15,
    featureNames: FEATURE_NAMES,
    featureGroups: FEATURE_GROUPS,
    volatilityCuts,
    logisticPenalty: 0.001,
    calibration: 'penalized sigmoid of logit, fitted on calibration only',
    intervalNote:
      'Intervals exist only for raw variance models. Logistic and calibrated probabilities have no inferred price interval.',
    naiveNote:
      'Current-side is deterministic0/1 (tie0.5); log loss clips only for numerical safety. Benchmark uses identical capture times and selected call subsets.',
  },
  sourceHashes,
  fittedModels,
  fittedCalibrators,
  summaries,
  policies,
  selectedModels,
};
const reportPath = path.join(
  outputDirectory,
  `market-awareness-${new Date(end).toISOString().slice(0, 10)}-30d.json`,
);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      reportPath,
      data: report.data,
      selectedModels: selectedModels.map(({ horizon, selected }) => ({
        horizon,
        model: selected.model,
        wait: selected.selectedWait,
        threshold: selected.selectedThreshold,
        test: selected.test,
        atOriginalSpot: selected.testAtOriginalSpot,
      })),
    },
    null,
    2,
  ),
);
