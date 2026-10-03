import { render, screen, within } from '@testing-library/react';
import ResearchPerformance from '../components/ResearchData/ResearchPerformance';
import ResearchAccuracyTable from '../components/ResearchData/ResearchAccuracyTable';
import { scoreLearningRows } from '../utils/learning/evaluation.utils';

const rows = [
  { probability: 0.7, outcome: 1, currentSide: 1 },
  { probability: 0.7, outcome: 1, currentSide: 0 },
  { probability: 0.2, outcome: 1, currentSide: 1 },
  { probability: 0.2, outcome: 0, currentSide: 1 },
  { probability: 0.5, outcome: 0, currentSide: 1 },
];

test('pairs model and current-side accuracy on exactly the same directional events', () => {
  const score = scoreLearningRows(rows);
  expect(score.currentSideComparison).toEqual({
    examples: 4,
    modelCorrect: 3,
    currentSideCorrect: 2,
    modelAccuracy: 0.75,
    currentSideAccuracy: 0.5,
    additionalCorrect: 1,
  });
  expect(score).toMatchObject({
    reversals: 3,
    reversalsCaught: 2,
    reversalAlerts: 3,
    falseReversalWarnings: 1,
    reversalRecall: 2 / 3,
    reversalFalseAlarmRate: 1 / 3,
  });
  // Existing aggregate accuracy retains its neutral-call convention for compatibility.
  expect(score.currentSideAccuracy).toBe(0.4);
  expect(score.callAccuracy).toBe(0.7);
});

test('a neutral-only group or unknown reference side does not become zero added value', () => {
  for (const input of [
    [],
    [{ probability: 0.5, outcome: 1, currentSide: 1 }],
    [{ probability: 0.8, outcome: 1, currentSide: null }],
  ]) {
    expect(scoreLearningRows(input).currentSideComparison).toEqual({
      examples: 0,
      modelCorrect: 0,
      currentSideCorrect: 0,
      modelAccuracy: null,
      currentSideAccuracy: null,
      additionalCorrect: null,
    });
  }
  expect(scoreLearningRows([{ probability: 0.8, outcome: 1, currentSide: null }])).toMatchObject({
    reversals: 0,
    reversalsCaught: 0,
    reversalAlerts: 0,
    falseReversalWarnings: 0,
  });
});

test('makes gains and harm visible without comparing against a different event sample', () => {
  render(
    <ResearchAccuracyTable
      caption="Matched calls"
      rows={[
        { label: 'Six minutes', ...scoreLearningRows(rows) },
        {
          label: 'Nine minutes',
          ...scoreLearningRows([{ probability: 0.2, outcome: 1, currentSide: 1 }]),
        },
        {
          label: 'No calls',
          ...scoreLearningRows([{ probability: 0.5, outcome: 1, currentSide: 1 }]),
        },
      ]}
    />,
  );
  const six = within(screen.getByRole('row', { name: /Six minutes/ }));
  expect(six.getByText('75.0% (4)')).toBeInTheDocument();
  expect(six.getByText('50.0% (4)')).toBeInTheDocument();
  expect(six.queryByText('40.0%')).not.toBeInTheDocument();
  expect(six.getByText('+1')).toBeInTheDocument();
  expect(six.getByText('2 / 3')).toBeInTheDocument();
  expect(six.getByText('1 / 3')).toBeInTheDocument();
  expect(
    within(screen.getByRole('row', { name: /Nine minutes/ })).getByText('-1'),
  ).toBeInTheDocument();
  expect(within(screen.getByRole('row', { name: /No calls/ })).getByText('—')).toBeInTheDocument();
});

test('explains that high late accuracy alone is not evidence of value and keeps the time breakdown', () => {
  render(
    <ResearchPerformance
      analysis={{
        primaryCohort: 'kalshi-background',
        metrics: scoreLearningRows(rows),
        byHorizon: [{ label: 'One minute remaining', ...scoreLearningRows(rows) }],
        byModel: [],
      }}
    />,
  );
  expect(screen.getByText(/High accuracy near the end/)).toHaveTextContent('same events');
  expect(screen.getByText(/High accuracy near the end/)).toHaveTextContent(
    'negative count means it did worse',
  );
  expect(screen.getByRole('rowheader', { name: 'One minute remaining' })).toBeInTheDocument();
});

test('prefers exact checkpoint results and explains why checkpoint event totals must not be summed', () => {
  render(
    <ResearchPerformance
      analysis={{
        metrics: scoreLearningRows(rows),
        byHorizon: [{ label: '6–10 minutes', ...scoreLearningRows(rows) }],
        byCheckpoint: [12, 9, 6, 3, 1].map((minutes) => ({
          label: `${minutes}m checkpoint`,
          ...scoreLearningRows(rows),
        })),
      }}
    />,
  );
  expect(screen.getByText(/Exact countdown checkpoints/)).toHaveTextContent(
    'do not add the row counts together',
  );
  expect(screen.queryByRole('rowheader', { name: '6–10 minutes' })).not.toBeInTheDocument();
  expect(screen.getByRole('rowheader', { name: '6m checkpoint' })).toBeInTheDocument();
});
