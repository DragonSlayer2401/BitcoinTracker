import { fireEvent, render, screen, within } from '@testing-library/react';
import ResearchExperiments from '../components/ResearchData/ResearchExperiments';

const comparison = {
  checkpoints: [
    {
      checkpointMinutes: 9,
      decisions: 50,
      variants: {
        combined: {
          callCoverage: 0.9,
          metrics: {
            examples: 40,
            accuracy: 0.7,
            brier: 0.2,
            reversals: 10,
            reversalRecall: 0.4,
            reversalAlerts: 8,
            reversalFalseAlarmRate: 0.5,
          },
        },
        'reversal-candidate': {
          callCoverage: 0.6,
          metrics: {
            examples: 20,
            accuracy: 0.75,
            brier: 0.18,
            reversals: 5,
            reversalRecall: 0.6,
            reversalAlerts: 5,
            reversalFalseAlarmRate: 0.4,
          },
          comparisons: { combined: { scoredPairs: 18, delta: { brier: -0.012 } } },
        },
        'market-only': { callCoverage: 0, metrics: { examples: 0 } },
      },
    },
    {
      checkpointMinutes: 3,
      decisions: 10,
      variants: {
        combined: { callCoverage: 1, metrics: { examples: 10, accuracy: 0.8, brier: 0.12 } },
      },
    },
  ],
};

test('shows the nine-minute experimental comparison with paired scores and honest denominators', () => {
  render(<ResearchExperiments comparison={comparison} />);
  expect(screen.getByText(/Challenger activation status is unavailable/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '9m' })).toHaveAttribute('aria-pressed', 'true');
  const candidate = within(
    screen.getByRole('rowheader', { name: 'Reversal candidate' }).closest('tr'),
  );
  expect(candidate.getByText('20')).toBeInTheDocument();
  expect(candidate.getByText('75.0%')).toBeInTheDocument();
  expect(candidate.getByText('0.180')).toBeInTheDocument();
  expect(candidate.getByText('-0.012')).toBeInTheDocument();
  expect(candidate.getByText('18 paired')).toBeInTheDocument();
  expect(candidate.getByText('5 reversals')).toBeInTheDocument();
  expect(candidate.getByText('5 alerts')).toBeInTheDocument();
  expect(candidate.getAllByText('60.0%')).toHaveLength(2);
  expect(screen.getByText(/same events only/)).toHaveTextContent(
    'different sample counts are not directly comparable',
  );
  const unavailable = within(
    screen.getByRole('rowheader', { name: 'Kalshi market midpoint' }).closest('tr'),
  );
  expect(unavailable.getByText('0')).toBeInTheDocument();
  expect(unavailable.getAllByText('—')).toHaveLength(7);
  expect(unavailable.getByText('0.0%')).toBeInTheDocument();
});

test('switches checkpoints without mixing their outcomes or scores', () => {
  render(<ResearchExperiments comparison={comparison} />);
  fireEvent.click(screen.getByRole('button', { name: '3m' }));
  expect(screen.getByRole('button', { name: '3m' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '9m' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('0.120')).toBeInTheDocument();
  expect(screen.getByText('80.0%')).toBeInTheDocument();
  expect(screen.queryByRole('rowheader', { name: 'Reversal candidate' })).not.toBeInTheDocument();
  expect(screen.getByText(/3 minutes remaining/)).toHaveTextContent('10 recorded decisions');
});

test('shows checkpoint gains against the current side on the same available directional events', () => {
  render(
    <ResearchExperiments
      comparison={{
        checkpoints: [
          {
            checkpointMinutes: 6,
            decisions: 5,
            variants: {
              combined: {
                callCoverage: 1,
                metrics: {
                  examples: 5,
                  accuracy: 0.7,
                  directionalAccuracy: 0.75,
                  directionalCalls: 4,
                  currentSideAccuracy: 0.4,
                  currentSideComparison: {
                    examples: 4,
                    modelAccuracy: 0.75,
                    currentSideAccuracy: 0.5,
                    additionalCorrect: 1,
                  },
                  reversalsCaught: 2,
                  reversals: 3,
                  falseReversalWarnings: 1,
                  reversalAlerts: 3,
                },
              },
            },
          },
        ],
      }}
    />,
  );
  const row = within(screen.getByRole('row', { name: /Combined pressure/ }));
  expect(row.getByText('75.0%')).toBeInTheDocument();
  expect(row.getByText('50.0%')).toBeInTheDocument();
  expect(row.queryByText('40.0%')).not.toBeInTheDocument();
  expect(row.getByText('4 same events')).toBeInTheDocument();
  expect(row.getByText('+1')).toBeInTheDocument();
  expect(row.getByText('2 / 3')).toBeInTheDocument();
  expect(row.getByText('1 / 3')).toBeInTheDocument();
  expect(screen.getByText(/High accuracy late in the event/)).toBeInTheDocument();
});

test('does not fabricate zero scores when comparison data is missing or unscored', () => {
  const { rerender } = render(<ResearchExperiments />);
  expect(screen.getByRole('status')).toHaveTextContent('No verified experimental results yet.');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  rerender(
    <ResearchExperiments
      comparison={{
        checkpoints: [
          {
            checkpointMinutes: 6,
            decisions: 2,
            variants: { combined: { metrics: { examples: 0 } } },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    'No verified experimental results at the 6-minute checkpoint yet.',
  );
  expect(screen.getByRole('button', { name: '6m' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

test('keeps prospective candidate validation separate from model activation', () => {
  const { rerender } = render(
    <ResearchExperiments
      comparison={comparison}
      challengers={{
        candidates: [
          {
            id: 'candidate-1',
            kind: 'reversal-candidate',
            status: 'shadow',
            reason: 'Waiting for later outcomes.',
          },
        ],
        active: null,
      }}
    />,
  );
  expect(screen.getByText(/No challenger is currently in use/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Candidate validation · 1 candidate'));
  expect(screen.getByText('Waiting for later outcomes.')).toBeInTheDocument();
  rerender(
    <ResearchExperiments
      comparison={comparison}
      challengers={{
        candidates: [],
        active: { kind: 'forward-pressure-candidate', id: 'forward-1' },
      }}
    />,
  );
  expect(screen.getByText(/Active challenger: Forward pressure candidate/)).toBeInTheDocument();
  expect(screen.queryByText(/No challenger is currently in use/)).not.toBeInTheDocument();
});

test('shows every approach report and separates training from scored future validation', () => {
  render(
    <ResearchExperiments
      challengers={{
        active: null,
        candidates: [{ id: 'reversal-1', kind: 'reversal' }],
        requirements: { minimumTrainingWindows: 60 },
        reports: [
          {
            kind: 'reversal',
            id: 'reversal-1',
            status: 'shadow',
            reason: 'Waiting for later outcomes.',
            counts: { independentWindows: 75 },
            evaluation: {
              scoredWindows: 20,
              resolvedWindows: 23,
              requiredWindows: 60,
              reasons: ['Waiting for later outcomes.'],
            },
          },
          {
            kind: 'forward-pressure',
            status: 'insufficient-data',
            reason: 'More forward samples are required.',
            counts: { independentWindows: 12 },
          },
          { kind: 'reduced-pressure', status: 'collecting' },
          { kind: 'fast-decay', status: 'candidate-rejected', reason: 'Did not improve error.' },
          { kind: 'market-blend', status: 'disabled', reason: 'Later performance worsened.' },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText('Candidate validation · 1 candidate'));
  expect(screen.getByText('Forward pressure candidate')).toBeInTheDocument();
  expect(screen.getByText('Training events: 75 / 60')).toBeInTheDocument();
  expect(screen.getByText('Scored future events: 20 / 60 · 23 resolved')).toBeInTheDocument();
  expect(screen.getAllByText('Waiting for later outcomes.')).toHaveLength(1);
  expect(screen.getByText('More forward samples are required.')).toBeInTheDocument();
  expect(screen.getByText(/Not approved/)).toBeInTheDocument();
  expect(screen.getByText(/Suspended/)).toBeInTheDocument();
  expect(screen.getByText(/No challenger is currently in use/)).toBeInTheDocument();
});

test('explains direct reversal learning and shows checkpoint gains only for matched directional events', () => {
  render(
    <ResearchExperiments
      challengers={{
        active: null,
        candidates: [{ id: 'directional-1', kind: 'directional-reversal' }],
        reports: [
          {
            id: 'directional-1',
            kind: 'directional-reversal',
            status: 'shadow',
            evaluation: {
              phase: 'development',
              requiredWindows: 60,
              checkpoints: [
                {
                  checkpointMinutes: 12,
                  scoredWindows: 0,
                  candidate: { currentSideComparison: { examples: 0, additionalCorrect: 0 } },
                },
                ...[
                  [9, 2],
                  [6, -1],
                  [3, 0],
                ].map(([checkpointMinutes, additionalCorrect]) => ({
                  checkpointMinutes,
                  scoredWindows: 10,
                  candidate: {
                    currentSideComparison: { examples: 8, additionalCorrect },
                  },
                })),
                {
                  checkpointMinutes: 1,
                  scoredWindows: 10,
                  candidate: { callAccuracy: 0.8 },
                  currentSide: { callAccuracy: 0.6 },
                },
              ],
            },
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText('Candidate validation · 1 candidate'));
  expect(screen.getByText('Directional reversal')).toBeInTheDocument();
  expect(screen.getByText(/Learns whether the final Kalshi result/)).toHaveTextContent(
    'It can change the predicted direction.',
  );
  expect(screen.getByText(/Learns whether the final Kalshi result/)).toHaveTextContent(
    'It stays experimental until it beats choosing the current side on future events.',
  );
  expect(screen.getByText(/No challenger is currently in use/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Development validation by countdown time'));
  const table = within(
    screen.getByRole('table', { name: 'Development validation checkpoint coverage and decisions' }),
  );
  expect(table.getByRole('columnheader', { name: 'Extra correct calls' })).toBeInTheDocument();
  for (const [minutes, difference] of [
    [9, '+2'],
    [6, '-1'],
    [3, '0'],
  ]) {
    const row = within(table.getByRole('row', { name: new RegExp(`^${minutes}m `) }));
    expect(row.getByText(difference)).toBeInTheDocument();
    expect(row.getByText('8 same events')).toBeInTheDocument();
  }
  for (const minutes of [12, 1]) {
    const row = within(table.getByRole('row', { name: new RegExp(`^${minutes}m `) }));
    expect(row.getAllByRole('cell')[1]).toHaveTextContent('—');
    expect(row.queryByText(/same events/)).not.toBeInTheDocument();
  }
});

test('separates approved active timings from a replacement confirmation and shows future probability reliability', () => {
  render(
    <ResearchExperiments
      challengers={{
        active: {
          id: 'active-reversal',
          kind: 'reversal',
          activation: { shadowEvaluation: { approvedCheckpoints: [9, 6] } },
        },
        candidates: [{ id: 'replacement-reversal', kind: 'reversal' }],
        reports: [
          {
            id: 'replacement-reversal',
            kind: 'reversal',
            status: 'confirmation',
            trial: { attemptNumber: 3, status: 'collecting' },
            calibration: { checkpoints: [{ checkpointMinutes: 6, status: 'fitted', samples: 25 }] },
            monitoring: {
              status: 'healthy',
              independentWindows: 40,
              reason: 'Current model remains healthy.',
            },
            evaluation: {
              phase: 'confirmation',
              independentWindows: 14,
              requiredWindows: 60,
              checkpoints: [
                {
                  checkpointMinutes: 6,
                  scoredWindows: 14,
                  requiredWindows: 60,
                  status: 'collecting',
                  reason: 'Waiting for the fixed cohort.',
                  reliability: [
                    {
                      lower: 0.6,
                      upper: 0.8,
                      samples: 10,
                      predictedProbability: 0.7,
                      observedFrequency: 0.6,
                      observedFrequencyInterval: [0.313, 0.832],
                      confidenceLevel: 0.95,
                    },
                    {
                      lower: 0.8,
                      upper: 1,
                      samples: 0,
                      predictedProbability: null,
                      observedFrequency: null,
                      observedFrequencyInterval: null,
                      confidenceLevel: 0.95,
                    },
                  ],
                },
              ],
            },
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/Active at approved checkpoints/)).toHaveTextContent('9m, 6m');
  expect(screen.getByText(/Active at approved checkpoints/)).toHaveTextContent(
    'Other countdown times use the baseline',
  );
  fireEvent.click(screen.getByText('Candidate validation · 1 candidate'));
  expect(
    screen.getByText('Replacement candidate; the current active model remains in use.'),
  ).toBeInTheDocument();
  expect(screen.getByText('Stage: Final confirmation on fresh events')).toBeInTheDocument();
  expect(screen.getByText('Confirmation attempt 3 · collecting')).toBeInTheDocument();
  expect(screen.getByText(/Active model monitoring: Healthy/)).toHaveTextContent('40 later events');
  fireEvent.click(screen.getByText('Final confirmation by countdown time'));
  const validation = screen.getByRole('table', {
    name: 'Final confirmation checkpoint coverage and decisions',
  });
  expect(within(validation).getByRole('row', { name: /6m 14 \/ 60/ })).toHaveTextContent(
    'Waiting for the fixed cohort.',
  );
  expect(within(validation).getByRole('row', { name: /12m/ })).toHaveTextContent(
    'Not nominated; uses baseline',
  );
  fireEvent.click(screen.getByText('6m probability reliability'));
  expect(screen.getByText(/Probability correction fitted/)).toHaveTextContent(
    '25 earlier calibration events',
  );
  const reliability = screen.getByRole('table', { name: /6m future outcome reliability/ });
  const bin = within(reliability).getByRole('row', { name: /60%–80%/ });
  expect(bin).toHaveTextContent('10');
  expect(bin).toHaveTextContent('70.0%');
  expect(bin).toHaveTextContent('60.0%');
  expect(bin).toHaveTextContent('31.3%–83.2%');
  expect(
    within(within(reliability).getByRole('row', { name: /80%–100%/ })).getAllByText('—'),
  ).toHaveLength(3);
});

test('labels development separately and does not imply calibration fitting passed future validation', () => {
  render(
    <ResearchExperiments
      challengers={{
        candidates: [{ id: 'new', kind: 'fast-decay' }],
        reports: [
          {
            id: 'new',
            kind: 'fast-decay',
            status: 'shadow',
            calibration: {
              checkpoints: [{ checkpointMinutes: 9, status: 'identity', samples: 3 }],
            },
            evaluation: {
              phase: 'development',
              checkpoints: [
                {
                  checkpointMinutes: 9,
                  scoredWindows: 0,
                  requiredWindows: 60,
                  status: 'collecting',
                  reason: 'Still collecting.',
                  reliability: [
                    {
                      lower: 0,
                      upper: 0.2,
                      samples: 0,
                      predictedProbability: null,
                      observedFrequency: null,
                      observedFrequencyInterval: null,
                    },
                  ],
                },
              ],
            },
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText('Candidate validation · 1 candidate'));
  expect(screen.getByText('Stage: Development validation')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Development validation by countdown time'));
  fireEvent.click(screen.getByText('9m probability reliability'));
  expect(screen.getByText(/No probability correction fitted/)).toHaveTextContent(
    '3 earlier calibration events',
  );
  expect(screen.queryByText(/Active at approved checkpoints/)).not.toBeInTheDocument();
});

test('distinguishes collector readiness and missing evidence from poor model performance', () => {
  render(
    <ResearchExperiments
      challengers={{
        candidates: [{ id: 'waiting', kind: 'reversal' }],
        reports: [
          {
            id: 'waiting',
            kind: 'reversal',
            status: 'awaiting-collector',
            readiness: { required: true, status: 'waiting' },
          },
          {
            id: 'scheduled',
            kind: 'fast-decay',
            status: 'awaiting-start',
            readiness: {
              required: true,
              status: 'scheduled',
              startsAt: Date.UTC(2026, 8, 16, 12, 15),
            },
          },
          {
            id: 'incomplete',
            kind: 'market-blend',
            status: 'unusable-evidence',
            infrastructureRecovery: true,
            evaluation: {
              failureCategory: 'evidence',
              reasons: ['Required recorded predictions are missing.'],
            },
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText('Candidate validation · 1 candidate'));
  expect(screen.getByText(/Waiting for collector/)).toBeInTheDocument();
  expect(
    screen.getByText('Collector check: waiting for a matching saved prediction.'),
  ).toBeInTheDocument();
  expect(screen.getByText(/Scheduled future evaluation/)).toBeInTheDocument();
  expect(
    screen.getByText(/Collector check passed. Evaluation begins with the event starting/),
  ).not.toHaveTextContent('—');
  expect(screen.getByText(/Incomplete evidence/)).toBeInTheDocument();
  expect(screen.getByText(/This is an evidence problem/)).toHaveTextContent(
    'not proof that the candidate made worse predictions',
  );
  expect(screen.getByText(/Recovering from incomplete evidence/)).toHaveTextContent(
    'fresh set of future events',
  );
});
