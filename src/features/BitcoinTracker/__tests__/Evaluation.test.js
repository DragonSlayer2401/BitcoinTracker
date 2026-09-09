import {
  fitLogistic,
  predictLogistic,
  scoreProbabilities,
} from '../../../../scripts/forecast-evaluation/statistics.mjs';
import {
  FEATURE_NAMES,
  getDirectionalFeatures,
  summarizeHistory,
} from '../../../../scripts/forecast-evaluation/features.mjs';

describe('offline forecast evaluation', () => {
  test('calculates Brier, log loss, calibration error, and call coverage independently', () => {
    const rows = [
      { probability: 0.8, outcome: 1, currentSide: 1 },
      { probability: 0.6, outcome: 0, currentSide: 0 },
      { probability: 0.4, outcome: 1, currentSide: 1 },
      { probability: 0.2, outcome: 0, currentSide: 0 },
    ].map((row, index) => ({ ...row, windowStart: index, captureKey: `${index}` }));
    const result = scoreProbabilities(rows, 0.65);

    expect(result.brier).toBeCloseTo(0.2, 12);
    expect(result.logLoss).toBeCloseTo(-(Math.log(0.8) + Math.log(0.4)) / 2, 12);
    expect(result.expectedCalibrationError).toBeCloseTo(0.4, 12);
    expect(result.calls).toBe(2);
    expect(result.callCoverage).toBe(0.5);
    expect(result.noCallRate).toBe(0.5);
    expect(result.callAccuracy).toBe(1);
    expect(result.currentSideAccuracyOnSameCalls).toBe(1);
    expect(result.calibrationBins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4);
  });

  test('counts an interval once per capture rather than once for every target', () => {
    const rows = [true, true, true, false, false].map((covered, index) => ({
      probability: 0.5,
      outcome: 1,
      currentSide: 0.5,
      windowStart: index < 3 ? 0 : 1,
      captureKey: index < 3 ? 'first-capture' : 'second-capture',
      intervalCovered: covered,
    }));
    const result = scoreProbabilities(rows);

    expect(result.intervalExamples).toBe(2);
    expect(result.central80IntervalCoverage).toBe(0.5);
    expect(result.calls).toBe(0);
    expect(result.callAccuracy).toBeNull();
    expect(result.noCallRate).toBe(1);
    expect(result.brier).toBe(0.25);
  });

  test('reports no metrics for absent data and rejects invalid probabilities', () => {
    expect(scoreProbabilities([])).toMatchObject({
      examples: 0,
      brier: null,
      logLoss: null,
      expectedCalibrationError: null,
      callCoverage: null,
      central80IntervalCoverage: null,
    });
    expect(() => scoreProbabilities([{ probability: NaN, outcome: 1 }])).toThrow();
    expect(() => scoreProbabilities([{ probability: 1.01, outcome: 1 }])).toThrow();
    expect(() => scoreProbabilities([{ probability: 0.5, outcome: 'above' }])).toThrow();
  });

  test('fits the known intercept-only probability without instability from a constant feature', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      features: [0],
      outcome: Number(index < 6),
    }));
    const model = fitLogistic(rows, [0]);

    expect(predictLogistic(model, [0])).toBeCloseTo(0.75, 7);
    expect(model.coefficients[0]).toBeCloseTo(Math.log(3), 6);
    expect(model.coefficients[1]).toBe(0);
    expect(model.means).toEqual([0]);
    expect(model.scales).toEqual([1]);
  });

  test('retains training normalization when later features have a different scale', () => {
    const rows = [-2, -1, 1, 2].map((value) => ({ features: [value], outcome: Number(value > 0) }));
    const model = fitLogistic(rows, [0], { penalty: 0.01 });
    const original = JSON.parse(JSON.stringify(model));

    expect(predictLogistic(model, [-1])).toBeLessThan(0.5);
    expect(predictLogistic(model, [1])).toBeGreaterThan(0.5);
    expect(predictLogistic(model, [1000])).toBe(0.99);
    expect(model).toEqual(original);
    expect(model.means).toEqual([0]);
    expect(model.scales[0]).toBeCloseTo(Math.sqrt(2.5), 12);
  });

  test('uses provided historical candles and scales target-distance features to the remaining horizon', () => {
    let close = 50_000;
    const candles = Array.from({ length: 120 }, (_, index) => {
      const open = close;
      close *= Math.exp(index % 2 ? 0.001 : -0.001);
      return { open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 10 };
    });
    const original = JSON.parse(JSON.stringify(candles));
    const summary = summarizeHistory(candles);
    const target = summary.price * 1.001;
    const shortFeatures = getDirectionalFeatures(summary, target, 3);
    const fullFeatures = getDirectionalFeatures(summary, target, 15);

    expect(shortFeatures).toHaveLength(FEATURE_NAMES.length);
    expect(shortFeatures.every(Number.isFinite)).toBe(true);
    expect(shortFeatures[0]).toBeCloseTo(fullFeatures[0] * Math.sqrt(5), 12);
    expect(shortFeatures[1]).toBe(0.2);
    expect(shortFeatures[2]).toBeCloseTo(shortFeatures[0] * 0.2, 12);
    expect(candles).toEqual(original);
  });
});
