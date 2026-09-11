import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ResearchData from '../components/ResearchData';
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
  expect(screen.getByText(/learned replacement has not passed/)).toBeInTheDocument();
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
  expect(screen.getByText(/learned replacement has not passed/)).toBeInTheDocument();
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
