import { selectJournalOutcomeGroups } from '../state/selectors/trackerSelectors';
import { DEADLINE_OUTCOME_DEFINITION } from '../utils/outcome.utils';
import { PRESSURE_POLICY_VERSION } from '../utils/fixedPrediction.utils';

const currentForecast = (overrides = {}) => ({
  outcomeDefinition: DEADLINE_OUTCOME_DEFINITION,
  analysis: { policyVersion: 'market-aware-consensus-v2' },
  status: 'resolved',
  outcome: 'above',
  aboveProbability: 0.8,
  belowProbability: 0.2,
  correct: true,
  ...overrides,
});

const summarize = (forecasts) => selectJournalOutcomeGroups({ tracker: { forecasts } });

describe('journal outcome groups', () => {
  test('keeps deadline and legacy accuracy, probability scores, and coverage separate', () => {
    const result = summarize([
      currentForecast(),
      currentForecast({ outcome: 'below', aboveProbability: 0.2, belowProbability: 0.8 }),
      currentForecast({ status: 'pending', outcome: undefined, correct: undefined }),
      currentForecast({ status: 'unobserved', outcome: undefined, correct: undefined }),
      currentForecast({
        status: 'withheld',
        outcome: undefined,
        correct: undefined,
        aboveProbability: null,
        belowProbability: null,
      }),
      currentForecast({
        status: 'analyzing',
        outcome: undefined,
        correct: undefined,
        aboveProbability: null,
        belowProbability: null,
      }),
      {
        status: 'resolved',
        outcome: 'below',
        aboveProbability: 0.9,
        belowProbability: 0.1,
        correct: false,
      },
      {
        analysis: { policyVersion: 'observed-consensus-v1' },
        status: 'resolved',
        outcome: 'below',
        aboveProbability: 0.7,
        belowProbability: 0.3,
        correct: false,
      },
      {
        analysis: { policyVersion: 'observed-consensus-v1' },
        status: 'withheld',
        aboveProbability: null,
        belowProbability: null,
      },
    ]);

    expect(result.hasLegacy).toBe(true);
    expect(result.deadline).toMatchObject({
      analysisCount: 1,
      withheldCount: 1,
      callCount: 4,
      coverage: 0.8,
      resolvedCount: 2,
      scoredCount: 2,
      correctCount: 2,
      accuracy: 1,
    });
    expect(result.deadline.brierScore).toBeCloseTo(0.04);
    expect(result.legacy).toMatchObject({
      analysisCount: 0,
      withheldCount: 1,
      callCount: 1,
      coverage: 0.5,
      resolvedCount: 2,
      scoredCount: 2,
      correctCount: 0,
      accuracy: 0,
    });
    expect(result.legacy.brierScore).toBeCloseTo(0.65);
  });

  test('does not turn an equal deadline result or a no-call into a scored prediction', () => {
    const result = summarize([
      currentForecast({
        outcome: 'equal',
        correct: null,
        aboveProbability: 0.5,
        belowProbability: 0.5,
      }),
      currentForecast({
        status: 'withheld',
        outcome: undefined,
        correct: undefined,
        aboveProbability: null,
        belowProbability: null,
      }),
    ]);

    expect(result.hasLegacy).toBe(false);
    expect(result.deadline).toMatchObject({
      resolvedCount: 1,
      scoredCount: 0,
      correctCount: 0,
      accuracy: null,
      brierScore: null,
      callCount: 1,
      withheldCount: 1,
      coverage: 0.5,
    });
    expect(result.legacy.accuracy).toBeNull();
    expect(result.legacy.coverage).toBeNull();
  });

  test('reports unavailable metrics for an empty journal instead of zero accuracy', () => {
    const result = summarize([]);

    expect(result.hasLegacy).toBe(false);
    expect(result.hasMarketAware).toBe(false);
    for (const group of [result.pressure, result.marketAware, result.deadline, result.legacy]) {
      expect(group).toMatchObject({
        resolvedCount: 0,
        scoredCount: 0,
        correctCount: 0,
        callCount: 0,
        withheldCount: 0,
        analysisCount: 0,
        accuracy: null,
        brierScore: null,
        coverage: null,
      });
    }
  });

  test('separates pressure accuracy, Brier score and call coverage from the earlier filtered policy', () => {
    const pressure = (overrides = {}) =>
      currentForecast({
        analysis: { policyVersion: PRESSURE_POLICY_VERSION },
        aboveProbability: 0.51,
        belowProbability: 0.49,
        ...overrides,
      });
    const result = summarize([
      pressure(),
      pressure({
        outcome: 'below',
        correct: false,
        aboveProbability: 0.6,
        belowProbability: 0.4,
        calculationMode: 'baseline-fallback',
      }),
      pressure({
        correct: null,
        direction: 'neutral',
        aboveProbability: 0.5,
        belowProbability: 0.5,
      }),
      pressure({
        status: 'withheld',
        correct: undefined,
        outcome: undefined,
        aboveProbability: null,
        belowProbability: null,
      }),
      pressure({
        status: 'analyzing',
        correct: undefined,
        outcome: undefined,
        aboveProbability: null,
        belowProbability: null,
      }),
      currentForecast(),
      currentForecast({
        status: 'withheld',
        correct: undefined,
        outcome: undefined,
        aboveProbability: null,
        belowProbability: null,
      }),
    ]);

    expect(result.hasMarketAware).toBe(true);
    expect(result.pressure).toMatchObject({
      accuracy: 0.5,
      scoredCount: 2,
      correctCount: 1,
      resolvedCount: 3,
      callCount: 3,
      withheldCount: 1,
      analysisCount: 1,
      coverage: 0.75,
    });
    // An exact tie has no directional correctness, but its issued 50% probability is scored.
    expect(result.pressure.brierScore).toBeCloseTo((0.49 ** 2 + 0.6 ** 2 + 0.5 ** 2) / 3);
    expect(result.marketAware).toMatchObject({
      accuracy: 1,
      scoredCount: 1,
      correctCount: 1,
      resolvedCount: 1,
      callCount: 1,
      withheldCount: 1,
      analysisCount: 0,
      coverage: 0.5,
    });
    expect(result.marketAware.brierScore).toBeCloseTo(0.04);
    expect(result.deadline.resolvedCount).toBe(4);
  });

  test('earlier policy outcomes do not become current model evidence before any pressure results exist', () => {
    const result = summarize([currentForecast()]);
    expect(result.hasMarketAware).toBe(true);
    expect(result.pressure).toMatchObject({
      scoredCount: 0,
      accuracy: null,
      brierScore: null,
      coverage: null,
    });
    expect(result.marketAware.accuracy).toBe(1);
  });
});
