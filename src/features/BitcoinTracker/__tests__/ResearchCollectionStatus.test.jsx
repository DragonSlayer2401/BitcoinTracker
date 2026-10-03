import { act, render, screen, within } from '@testing-library/react';
import ResearchCollectionStatus from '../components/ResearchData/ResearchCollectionStatus';
import {
  getCollectorHealth,
  COLLECTOR_HEARTBEAT_VERSION,
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
} from '../utils/collectorHealth.utils';

const NOW = Date.UTC(2026, 8, 15, 12);
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

test('unknown collector health does not claim that archive activity proves the process is running', () => {
  render(<ResearchCollectionStatus />);
  const panel = within(screen.getByRole('region', { name: 'Collector health' }));
  expect(panel.getByText('Running status unknown')).toBeInTheDocument();
  expect(panel.getByText(/Archive activity alone cannot confirm/)).toBeInTheDocument();
});

test('an open health panel ages a previously running heartbeat into overdue without another fetch', () => {
  const collectorHealth = getCollectorHealth({
    now: NOW,
    heartbeats: [
      {
        version: COLLECTOR_HEARTBEAT_VERSION,
        collectorId: 'session',
        codeVersion: CURRENT_COLLECTOR_CODE_VERSION,
        researchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
        startedAt: NOW - 1000,
        heartbeatAt: NOW,
        status: 'running',
        feeds: { benchmarkAt: NOW, spotAt: NOW, futuresAt: null, marketAt: NOW },
        lastEvidenceAt: null,
      },
    ],
  });
  render(<ResearchCollectionStatus collectorHealth={collectorHealth} />);
  expect(screen.getByText('Running')).toBeInTheDocument();
  expect(screen.getByText(/Feed freshness is measured/)).toBeInTheDocument();
  act(() => jest.advanceTimersByTime(91_000));
  expect(screen.getByText('Heartbeat overdue')).toBeInTheDocument();
  expect(screen.getByText(/No heartbeat arrived within 90 seconds/)).toBeInTheDocument();
});

test('a fresh process heartbeat still shows failed recording and an overdue evidence gap', () => {
  const collectorHealth = getCollectorHealth({
    now: NOW,
    heartbeats: [
      {
        version: COLLECTOR_HEARTBEAT_VERSION,
        collectorId: 'session',
        codeVersion: CURRENT_COLLECTOR_CODE_VERSION,
        researchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
        startedAt: NOW - 1_000_000,
        heartbeatAt: NOW,
        status: 'running',
        feeds: { benchmarkAt: NOW, spotAt: NOW, futuresAt: NOW, marketAt: NOW },
        lastEvidenceAt: null,
        progress: {
          lastSuccessfulTickAt: null,
          lastFailureAt: NOW - 1000,
          failureCode: 'storage-permission',
        },
      },
    ],
  });
  render(<ResearchCollectionStatus collectorHealth={collectorHealth} />);
  expect(screen.getByText('Running')).toBeInTheDocument();
  expect(screen.getByText(/Recording issue:.*cannot write/)).toBeInTheDocument();
  expect(screen.getByText(/No evidence saved for over 15 minutes/)).toBeInTheDocument();
});
