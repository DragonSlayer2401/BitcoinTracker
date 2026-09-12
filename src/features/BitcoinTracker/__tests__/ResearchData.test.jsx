import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ResearchData from '../components/ResearchData';
import KalshiModelRules from '../components/KalshiModelRules';
import { requestResearch, runResearchLearning } from '@/services/research/research.client.service';

jest.mock('@/services/research/research.client.service', () => ({
  requestResearch: jest.fn(),
  runResearchLearning: jest.fn(),
  readResearchExport: jest.fn(),
}));

const report = {
  active: null,
  candidate: null,
  training: {
    reason: 'Collect more independent windows.',
    counts: { training: 12, calibration: 6, test: 6 },
  },
  requirements: {
    minimumTrainingWindows: 120,
    minimumCalibrationWindows: 60,
    minimumTestWindows: 60,
    minimumShadowWindows: 120,
  },
  analysis: {
    primaryCohort: 'kalshi-background',
    callCoverage: 0.9,
    outcomeCoverage: 0.8,
    metrics: {
      examples: 24,
      directionalCalls: 23,
      directionalAccuracy: 0.7,
      currentSideAccuracy: 0.6,
      brier: 0.21,
      reversals: 5,
      reversalAlerts: 4,
      reversalRecall: 0.4,
      reversalFalseAlarmRate: 0.5,
      calibrationBins: [{ lower: 0.6, count: 10, meanProbability: 0.65, observedAboveRate: 0.6 }],
    },
    savedJournal: {
      groups: [
        {
          label: 'Official Kalshi contract outcomes',
          examples: 3,
          directionalCalls: 3,
          directionalAccuracy: 2 / 3,
          brier: 0.3,
        },
      ],
    },
    byHorizon: [],
    byModel: [],
  },
};

const earlyReport = {
  active: null,
  candidate: null,
  training: {
    status: 'insufficient-data',
    reason: 'Early learning needs more independent events.',
    counts: { independentWindows: 18, training: 18, classes: { above: 12, below: 6 } },
  },
  shadow: null,
  monitoring: null,
  requirements: {
    minimumTrainingWindows: 40,
    minimumClassExamples: 8,
    minimumShadowWindows: 40,
    minimumShadowModelUses: 20,
    maximumProbabilityAdjustment: 0.05,
    blendWeight: 0.2,
    minimumNewWindowsForRetraining: 20,
    minimumMonitoringWindows: 40,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  requestResearch.mockResolvedValue(report);
});

test('loads archived outcomes on opening and distinguishes measured scores from training readiness', async () => {
  render(<ResearchData researchStatus={{ lastSyncedAt: 1_800_000_000_000 }} />);
  expect(requestResearch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  await screen.findByText('Collect more independent windows.');
  expect(requestResearch).toHaveBeenCalledWith('analysis');
  expect(screen.getByText('12 / 120')).toBeInTheDocument();
  expect(screen.getByText(/No learned adjustment is currently active/)).toBeInTheDocument();
  const automatic = screen.getByRole('rowheader', { name: 'Automatic windows' }).closest('tr');
  expect(within(automatic).getByText('70.0% (23)')).toBeInTheDocument();
  expect(within(automatic).getByText('0.210')).toBeInTheDocument();
  expect(
    screen.getByRole('rowheader', { name: 'Official Kalshi contract outcomes' }),
  ).toBeInTheDocument();
  expect(screen.getByText(/Clearing the visible journal does not erase/)).toBeInTheDocument();
});

test('runs outcome analysis and reports a rejected candidate without claiming activation', async () => {
  runResearchLearning.mockResolvedValue({
    ...report,
    lastRun: { status: 'candidate-rejected', reason: 'Candidate did not improve the Brier score.' },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  await screen.findByText('Collect more independent windows.');
  fireEvent.click(screen.getByRole('button', { name: 'Analyze saved forecasts' }));
  expect(
    await screen.findByText('Last analysis: Candidate did not improve the Brier score.'),
  ).toBeInTheDocument();
  expect(runResearchLearning).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/No learned adjustment is currently active/)).toBeInTheDocument();
});

test('shows archive errors and permits another analysis attempt', async () => {
  requestResearch.mockRejectedValue(new Error('Research sign-in is required.'));
  runResearchLearning.mockResolvedValue(report);
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Research sign-in is required.');
  expect(screen.getByRole('link', { name: 'Check archive access' })).toHaveAttribute(
    'href',
    '/api/research/status',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Analyze saved forecasts' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  expect(await screen.findByText('12 / 120')).toBeInTheDocument();
});

test('distinguishes BRTI training progress and measured results from older price sources', async () => {
  requestResearch.mockResolvedValue({
    ...report,
    training: {
      ...report.training,
      counts: {
        ...report.training.counts,
        pipeline: {
          baselineModelVersion: 'kalshi-brti-average-v2',
          referenceSource: 'cf-brti',
          featureInputSource: 'cf-brti-history',
        },
      },
    },
    analysis: {
      ...report.analysis,
      byInputSource: [
        {
          baselineModelVersion: 'kalshi-brti-average-v2',
          referenceSource: 'cf-brti',
          featureInputSource: 'cf-brti-history',
          examples: 12,
          directionalCalls: 12,
          directionalAccuracy: 0.5,
          brier: 0.25,
        },
      ],
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  await screen.findByText(/Training price history: BRTI/);
  fireEvent.click(screen.getByText('Results by remaining time, model and price source'));
  const row = screen
    .getByRole('rowheader', {
      name: 'BRTI history · BRTI price · kalshi-brti-average-v2',
    })
    .closest('tr');
  expect(within(row).getByText('50.0% (12)')).toBeInTheDocument();
  expect(within(row).getByText('0.250')).toBeInTheDocument();
});

test('separates early event collection from the unchanged full model requirements', async () => {
  requestResearch.mockResolvedValue({ ...report, early: earlyReport });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  const early = await screen.findByRole('region', { name: 'Early learning' });
  expect(within(early).getByText('18 / 40')).toBeInTheDocument();
  expect(within(early).getByText('12 / 8')).toBeInTheDocument();
  expect(within(early).getByText('6 / 8')).toBeInTheDocument();
  expect(within(early).getByText(/Each event counts once/)).toBeInTheDocument();
  expect(within(early).getByText(/at least 8 Yes and 8 No outcomes/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Full model learning' })).toBeInTheDocument();
  expect(screen.getByText('12 / 120')).toBeInTheDocument();
  expect(screen.getByText(/No learned adjustment is currently active/)).toBeInTheDocument();
});

test('shows a candidate as experimental and scores its recorded future results against the baseline', async () => {
  requestResearch.mockResolvedValue({
    ...report,
    early: {
      ...earlyReport,
      candidate: { id: 'early-candidate', version: 'outcome-early-kalshi-v1' },
      training: {
        status: 'shadow',
        reason: 'Waiting for the remaining future outcomes.',
        counts: { independentWindows: 48 },
      },
      shadow: {
        independentWindows: 24,
        eligibleWindows: 25,
        modelUses: 21,
        evaluationComplete: false,
        reasons: ['Waiting for the remaining future outcomes.'],
        candidate: { examples: 24, directionalCalls: 24, directionalAccuracy: 0.75, brier: 0.19 },
        current: { examples: 24, directionalCalls: 24, directionalAccuracy: 0.7, brier: 0.21 },
        benchmark: { examples: 24, directionalCalls: 24, directionalAccuracy: 0.6, brier: 0.4 },
      },
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  const early = await screen.findByRole('region', { name: 'Early learning' });
  expect(
    within(early).getByText(/experimental and does not change displayed predictions/),
  ).toBeInTheDocument();
  expect(within(early).getByText('25 / 40')).toBeInTheDocument();
  const scored = within(early).getByText('Scored validation predictions').closest('div');
  expect(within(scored).getByText('24 / 40')).toBeInTheDocument();
  expect(within(early).getByText('21 / 20')).toBeInTheDocument();
  expect(within(early).getAllByText(/Waiting for the remaining future outcomes/)).toHaveLength(1);
  const candidate = within(early)
    .getByRole('rowheader', { name: 'Early model future validation: early adjustment' })
    .closest('tr');
  const baseline = within(early)
    .getByRole('rowheader', { name: 'Early model future validation: settlement baseline' })
    .closest('tr');
  expect(within(candidate).getByText('75.0% (24)')).toBeInTheDocument();
  expect(within(candidate).getByText('0.190')).toBeInTheDocument();
  expect(within(baseline).getByText('0.210')).toBeInTheDocument();
  expect(screen.getByText(/No learned adjustment is currently active/)).toBeInTheDocument();
});

test('identifies an active early adjustment and retains its completed future validation', async () => {
  const active = {
    id: 'early-active',
    version: 'outcome-early-kalshi-v1',
    activation: {
      shadowEvaluation: {
        eligibleWindows: 40,
        independentWindows: 40,
        eligibleForPromotion: true,
        evaluationComplete: true,
        modelUses: 40,
      },
    },
  };
  requestResearch.mockResolvedValue({
    ...report,
    active,
    early: {
      ...earlyReport,
      active,
      training: { status: 'active', counts: { independentWindows: 40 } },
      monitoring: {
        status: 'monitoring',
        independentWindows: 12,
        reason: 'Collecting later outcomes.',
      },
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  expect(await screen.findByText(/Early learning model early-active/)).toBeInTheDocument();
  const early = screen.getByRole('region', { name: 'Early learning' });
  expect(within(early).getByText('Active limited adjustment.')).toBeInTheDocument();
  expect(within(early).getByText(/blends in 20%.*at most 5 percentage points/)).toBeInTheDocument();
  expect(within(early).getByRole('status')).toHaveTextContent('12 / 40 events');
  const validation = within(early).getByText('Selected future events').closest('div');
  expect(within(validation).getByText('40 / 40')).toBeInTheDocument();
  expect(screen.getByText(/Saved fixed calls stay unchanged/)).toBeInTheDocument();
  expect(screen.getByText('12 / 120')).toBeInTheDocument();
});

test('keeps the full model identity clear when it supersedes early learning', async () => {
  requestResearch.mockResolvedValue({
    ...report,
    active: { id: 'full-active', version: 'outcome-logistic-kalshi-v2' },
    early: {
      ...earlyReport,
      training: { status: 'superseded', reason: 'The full learned model is active.' },
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  expect(await screen.findByText(/Learned model full-active/)).toBeInTheDocument();
  const early = screen.getByRole('region', { name: 'Early learning' });
  expect(within(early).getByText('Full model in use.')).toBeInTheDocument();
  expect(within(early).queryByText('Active limited adjustment.')).not.toBeInTheDocument();
});

test('explains a completed unsuccessful validation group without promising eventual activation', async () => {
  requestResearch.mockResolvedValue({
    ...report,
    early: {
      ...earlyReport,
      candidate: { id: 'rejected-early', version: 'outcome-early-kalshi-v1' },
      shadow: {
        independentWindows: 39,
        eligibleWindows: 40,
        evaluationComplete: true,
        eligibleForPromotion: false,
        reasons: ['The fixed group lacks a recorded prediction for one event.'],
      },
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  const early = await screen.findByRole('region', { name: 'Early learning' });
  expect(within(early).getByText('Candidate not approved.')).toBeInTheDocument();
  expect(within(early).getByText('40 / 40')).toBeInTheDocument();
  expect(within(early).getByText(/lacks a recorded prediction for one event/)).toBeInTheDocument();
  expect(
    within(early).getByText(/repeated checks cannot extend a failed group/),
  ).toBeInTheDocument();
});

test('shows suspension and baseline fallback after early learning performance degrades', async () => {
  requestResearch.mockResolvedValue({
    ...report,
    early: {
      ...earlyReport,
      training: { status: 'disabled', counts: { independentWindows: 80 } },
      monitoring: {
        status: 'disabled',
        reason: 'Probability error increased on later events.',
        independentWindows: 40,
      },
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  expect(
    await screen.findByText(/settlement-average model. The early adjustment is suspended/),
  ).toBeInTheDocument();
  const early = screen.getByRole('region', { name: 'Early learning' });
  expect(within(early).getByText('Adjustment suspended.')).toBeInTheDocument();
  expect(within(early).getByRole('status')).toHaveTextContent(
    'Probability error increased on later events.',
  );
});

test('distinguishes a pending suspension from an adjustment that has already stopped', async () => {
  const active = { id: 'early-pending-suspension', version: 'outcome-early-kalshi-v1' };
  requestResearch.mockResolvedValue({
    ...report,
    active,
    early: {
      ...earlyReport,
      active,
      monitoring: {
        status: 'disabled',
        reason: 'Probability error increased on later events.',
        independentWindows: 40,
      },
    },
  });
  render(<ResearchData />);
  fireEvent.click(screen.getByRole('button', { name: 'Research data' }));
  expect(
    await screen.findByText(/The adjustment is still active, but its latest outcome check failed/),
  ).toBeInTheDocument();
  const early = screen.getByRole('region', { name: 'Early learning' });
  expect(within(early).getByText('Suspension pending.')).toBeInTheDocument();
  expect(within(early).getByRole('status')).toHaveTextContent(
    'The next analysis cycle will disable this adjustment.',
  );
  expect(within(early).queryByText('Adjustment suspended.')).not.toBeInTheDocument();
});

test('model rules explain early validation and limited influence alongside full model requirements', () => {
  render(<KalshiModelRules />);
  expect(screen.getByText(/fixed group of 40 future events/)).toBeInTheDocument();
  expect(screen.getByText(/at most 5 percentage points/)).toBeInTheDocument();
  expect(screen.getByText(/at least 120, 60 and 60 events/)).toBeInTheDocument();
  expect(screen.getByText(/New training never rewrites a saved call/)).toBeInTheDocument();
});
