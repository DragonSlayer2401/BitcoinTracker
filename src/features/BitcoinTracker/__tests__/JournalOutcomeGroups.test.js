import {
  selectJournalOutcomeGroups,
  selectJournalSummary,
} from '../state/selectors/trackerSelectors';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const entry = (overrides = {}) => ({
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  analysis: { policyVersion: 'kalshi-snapshot-v4' },
  status: 'resolved',
  outcome: 'above',
  aboveProbability: 0.8,
  belowProbability: 0.2,
  correct: true,
  ...overrides,
});
const state = (forecasts) => ({ tracker: { forecasts } });

test('Kalshi summaries exclude old Coinbase outcomes and retain honest scores and coverage', () => {
  const data = state([
    entry(),
    entry({ outcome: 'below', correct: false }),
    entry({ status: 'pending', correct: undefined, outcome: undefined }),
    entry({ status: 'awaiting-settlement', correct: undefined, outcome: undefined }),
    entry({
      status: 'withheld',
      aboveProbability: null,
      belowProbability: null,
      correct: undefined,
    }),
    entry({
      status: 'analyzing',
      aboveProbability: null,
      belowProbability: null,
      correct: undefined,
    }),
    entry({ outcomeDefinition: 'coinbase-last-trade-at-deadline-v1' }),
  ]);
  const result = selectJournalSummary(data);
  expect(result).toMatchObject({
    scoredCount: 2,
    correctCount: 1,
    accuracy: 0.5,
    callCount: 4,
    withheldCount: 1,
    analysisCount: 1,
    coverage: 0.8,
  });
  expect(result.brierScore).toBeCloseTo(0.34);
  expect(selectJournalOutcomeGroups(data)).toEqual({ kalshi: result });
});

test('a balanced forecast receives a probability score but no directional win', () => {
  const result = selectJournalSummary(
    state([entry({ aboveProbability: 0.5, belowProbability: 0.5, correct: null })]),
  );
  expect(result).toMatchObject({ scoredCount: 0, accuracy: null, brierScore: 0.25 });
});

test('an empty journal reports unavailable accuracy rather than zero', () => {
  expect(selectJournalSummary(state([]))).toMatchObject({
    scoredCount: 0,
    accuracy: null,
    brierScore: null,
    coverage: null,
  });
});
