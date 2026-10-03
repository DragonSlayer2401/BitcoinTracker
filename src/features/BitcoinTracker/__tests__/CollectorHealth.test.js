import {
  COLLECTOR_HEARTBEAT_VERSION,
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
  getCollectorHealth,
  isCollectorHeartbeat,
  getCollectorFailureCode,
} from '../utils/collectorHealth.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { createCollectorHealthService } from '@/services/research/collectorHealth.service';

const START = Date.UTC(2026, 8, 15, 12);
const NOW = START + 365_010;
const heartbeat = (patch = {}) => ({
  version: COLLECTOR_HEARTBEAT_VERSION,
  collectorId: 'anonymous-session',
  codeVersion: CURRENT_COLLECTOR_CODE_VERSION,
  researchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
  startedAt: START,
  heartbeatAt: NOW,
  status: 'running',
  feeds: { benchmarkAt: NOW - 1000, spotAt: NOW - 6000, futuresAt: null, marketAt: NOW - 30_000 },
  lastEvidenceAt: START + 180_000,
  ...patch,
});
function decision(patch = {}) {
  return {
    cohort: 'kalshi-background',
    event: 'decision',
    eventId: 'capture',
    forecastId: 'forecast',
    recordedAt: START + 180_000,
    capturedAt: START + 180_000,
    featureCutoffAt: START + 180_000,
    checkpointMinutes: 12,
    inputStatus: 'captured',
    aboveProbability: 0.6,
    researchReplay: { snapshotId: 'capture' },
    researchExperiment: { version: CURRENT_COLLECTOR_RESEARCH_VERSION },
    kalshiMarket: {
      ticker: 'KXBTC15M-26SEP151215-15',
      eventTicker: 'KXBTC15M-26SEP151215',
      seriesTicker: 'KXBTC15M',
      target: 50_000,
      startsAt: START,
      expiresAt: START + 900_000,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    },
    ...patch,
  };
}

test('heartbeat validation accepts operational data and rejects private or future fields', () => {
  expect(isCollectorHeartbeat(heartbeat())).toBe(true);
  expect(isCollectorHeartbeat({ ...heartbeat(), pid: 123 })).toBe(false);
  expect(isCollectorHeartbeat(heartbeat({ startedAt: NOW + 1 }))).toBe(false);
  expect(
    isCollectorHeartbeat(heartbeat({ feeds: { ...heartbeat().feeds, benchmarkAt: NOW + 1 } })),
  ).toBe(false);
});

test('recording health distinguishes loaded candidates from actually saved predictions', () => {
  const recording = {
    loadedCandidateIds: ['model-a', 'model-b'],
    savedCandidateIds: ['model-a'],
    lastPredictionAt: NOW,
    lastMarketQuoteAt: NOW - 1000,
  };
  expect(isCollectorHeartbeat(heartbeat({ recording }))).toBe(true);
  const result = getCollectorHealth({ heartbeats: [heartbeat({ recording })], now: NOW });
  expect(result.collectors[0].recording).toEqual({
    loadedCandidates: 2,
    savedCandidates: 1,
    lastPredictionAt: NOW,
    lastMarketQuoteAt: NOW - 1000,
  });
  expect(
    isCollectorHeartbeat(
      heartbeat({ recording: { ...recording, savedCandidateIds: ['unknown-model'] } }),
    ),
  ).toBe(false);
  expect(
    isCollectorHeartbeat(heartbeat({ recording: { ...recording, lastMarketQuoteAt: NOW + 1 } })),
  ).toBe(false);
  expect(isCollectorHeartbeat(heartbeat({ recording: { ...recording, secret: 'invalid' } }))).toBe(
    false,
  );
});

test('running status expires after 90 seconds while clean stop and error remain explicit', () => {
  expect(getCollectorHealth({ heartbeats: [heartbeat()], now: NOW + 90_000 }).status).toBe(
    'running',
  );
  expect(getCollectorHealth({ heartbeats: [heartbeat()], now: NOW + 90_001 }).status).toBe('stale');
  expect(
    getCollectorHealth({ heartbeats: [heartbeat({ status: 'stopped' })], now: NOW }).status,
  ).toBe('stopped');
  expect(
    getCollectorHealth({ heartbeats: [heartbeat({ status: 'error' })], now: NOW }).status,
  ).toBe('error');
  expect(
    getCollectorHealth({ heartbeats: [heartbeat({ heartbeatAt: NOW + 1 })], now: NOW }).status,
  ).toBe('unknown');
});

test('recording failures and long evidence gaps stay visible even when market heartbeats are fresh', () => {
  const record = heartbeat({
    startedAt: NOW - 1_000_000,
    lastEvidenceAt: null,
    progress: {
      lastSuccessfulTickAt: NOW - 120_000,
      lastFailureAt: NOW - 1000,
      failureCode: 'storage-locked',
    },
  });
  expect(isCollectorHeartbeat(record)).toBe(true);
  const result = getCollectorHealth({ heartbeats: [record], now: NOW });
  expect(result.status).toBe('running');
  expect(result.collectors[0].progress).toMatchObject({
    evidenceOverdue: true,
    failureCode: 'storage-locked',
    failureMessage: expect.stringContaining('database is locked'),
  });
  expect(
    isCollectorHeartbeat({
      ...record,
      progress: { ...record.progress, failureCode: 'private-path' },
    }),
  ).toBe(false);
  expect(
    isCollectorHeartbeat({ ...record, progress: { ...record.progress, lastFailureAt: NOW + 1 } }),
  ).toBe(false);
  expect(
    getCollectorHealth({ heartbeats: [{ ...record, progress: undefined }], now: NOW }).status,
  ).toBe('unknown');
});

test('legacy heartbeats with no evidence reveal a gap without claiming a known storage error', () => {
  const record = heartbeat({ startedAt: NOW - 1_000_000, lastEvidenceAt: null });
  const result = getCollectorHealth({ heartbeats: [record], now: NOW });
  expect(result.collectors[0].progress).toMatchObject({ evidenceOverdue: true, failureCode: null });
  expect(getCollectorFailureCode({ code: 'EPERM', message: 'private' })).toBe('storage-permission');
  expect(getCollectorFailureCode(new Error('secret'))).toBe('storage-unavailable');
});

test('multiple collectors remain independent and no private identities reach the UI summary', () => {
  const result = getCollectorHealth({
    now: NOW,
    heartbeats: [
      heartbeat(),
      heartbeat({ heartbeatAt: NOW - 1000 }),
      heartbeat({ collectorId: 'second-session', status: 'stopped' }),
      heartbeat({ collectorId: 'third-session', codeVersion: 'old-version' }),
    ],
  });
  expect(result.activeCollectors).toBe(2);
  expect(result.collectors).toHaveLength(3);
  expect(result.needsRestart).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /anonymous-session|second-session|third-session|collectorId/,
  );
});

test('feed freshness describes the last heartbeat, rather than falsely aging a live feed between heartbeats', () => {
  const result = getCollectorHealth({ heartbeats: [heartbeat()], now: NOW + 25_000 });
  expect(result.collectors[0].feeds).toMatchObject({
    benchmarkAt: { status: 'fresh' },
    spotAt: { status: 'stale' },
    futuresAt: { status: 'unknown' },
    marketAt: { status: 'fresh' },
  });
});

test('recent legacy evidence identifies outdated research without inventing collector liveness', () => {
  const result = getCollectorHealth({
    evidence: [decision({ researchExperiment: { version: 'kalshi-ablation-v1' } })],
    now: NOW,
  });
  expect(result).toMatchObject({
    status: 'unknown',
    activeCollectors: 0,
    needsRestart: true,
    evidence: { olderResearchDetected: true, confirmsRunning: false },
  });
  expect(
    getCollectorHealth({ evidence: [decision({ researchExperiment: null })], now: NOW })
      .needsRestart,
  ).toBe(false);
  expect(
    getCollectorHealth({
      evidence: [decision({ researchExperiment: { version: 'kalshi-ablation-v1' } })],
      now: NOW + 900_000,
    }).needsRestart,
  ).toBe(false);
});

test('coverage deduplicates successful contract checkpoints and retains missed and pending labels', () => {
  const result = getCollectorHealth({
    now: NOW,
    evidence: [decision(), decision({ forecastId: 'duplicate' })],
    labels: [
      {
        snapshotId: 'capture',
        horizonSeconds: 15,
        recordedAt: START + 196_000,
        status: 'observed',
      },
      { snapshotId: 'capture', horizonSeconds: 60, recordedAt: START + 241_000, status: 'missing' },
    ],
  });
  expect(result.counts).toEqual({
    windowHours: 24,
    knownContracts: 1,
    dueCheckpoints: 2,
    capturedCheckpoints: 1,
    missedCheckpoints: 1,
    forwardObserved: 1,
    forwardMissing: 1,
    forwardPending: 1,
  });
});

test('current collectors do not hide concurrent older research writers', () => {
  const result = getCollectorHealth({
    now: NOW,
    heartbeats: [heartbeat()],
    evidence: [
      decision({ recordedAt: NOW - 2000, researchExperiment: { version: 'kalshi-ablation-v1' } }),
      decision({ recordedAt: NOW - 1000 }),
    ],
  });
  expect(result.status).toBe('running');
  expect(result.needsRestart).toBe(true);
  expect(result.evidence.recentResearchVersions).toEqual([
    'kalshi-ablation-v1',
    CURRENT_COLLECTOR_RESEARCH_VERSION,
  ]);
});

test('service reuses supplied archive rows and performs only the heartbeat read', async () => {
  const repository = {
    readCollectorHeartbeats: jest.fn().mockResolvedValue([heartbeat()]),
    getLearningEvidenceRows: jest.fn(),
    getForwardResearchLabels: jest.fn(),
    writeCollectorHeartbeat: jest.fn(),
    getCollectorHealthRows: jest.fn(),
  };
  const result = await createCollectorHealthService(repository).getCollectorHealth({
    now: NOW,
    events: [],
    labels: [],
  });
  expect(result.status).toBe('running');
  expect(repository.getLearningEvidenceRows).not.toHaveBeenCalled();
  expect(repository.getForwardResearchLabels).not.toHaveBeenCalled();
  expect(repository.writeCollectorHeartbeat).not.toHaveBeenCalled();
  expect(repository.getCollectorHealthRows).not.toHaveBeenCalled();
});

test('standalone health polling reads only its recent archive window', async () => {
  const repository = {
    readCollectorHeartbeats: jest.fn().mockResolvedValue([heartbeat()]),
    getCollectorHealthRows: jest.fn().mockResolvedValue({ evidence: [], labels: [] }),
    getLearningEvidenceRows: jest.fn(),
    getForwardResearchLabels: jest.fn(),
  };
  const result = await createCollectorHealthService(repository).getCollectorHealth({ now: NOW });
  expect(result.status).toBe('running');
  expect(repository.getCollectorHealthRows).toHaveBeenCalledWith({
    since: NOW - 86_400_000,
    now: NOW,
  });
  expect(repository.getLearningEvidenceRows).not.toHaveBeenCalled();
  expect(repository.getForwardResearchLabels).not.toHaveBeenCalled();
});
