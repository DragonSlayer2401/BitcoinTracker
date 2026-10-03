import { isKalshiContract } from './kalshi/contract.utils';
import { RESEARCH_EXPERIMENT_V5 } from './researchVariantConfig.utils';

export const COLLECTOR_HEARTBEAT_VERSION = 'collector-heartbeat-v1';
export const CURRENT_COLLECTOR_CODE_VERSION = 'kalshi-collector-2026-10-03-v2';
export const CURRENT_COLLECTOR_RESEARCH_VERSION = RESEARCH_EXPERIMENT_V5;
export const COLLECTOR_HEALTH_POLICY = Object.freeze({
  heartbeatIntervalMs: 30_000,
  staleAfterMs: 90_000,
  reportingWindowMs: 86_400_000,
  maximumFeedAgeMs: 5000,
  maximumMarketAgeMs: 60_000,
  maximumEvidenceSilenceMs: 900_000,
});
export const COLLECTOR_FAILURE_MESSAGES = Object.freeze({
  'state-invalid': 'Saved collector state needs repair; original records were retained.',
  'ownership-lost': 'State-file ownership changed; this collector must stop.',
  'storage-locked': 'The research database is locked; original pending events will retry.',
  'storage-permission':
    'The collector cannot write its state or archive; check access permissions.',
  'storage-full': 'The state or archive has no space for another write.',
  'storage-timeout': 'A storage operation has not finished; no overlapping write was started.',
  'storage-unavailable': 'State or archive recording failed; original pending events will retry.',
});

/** Only known error categories leave the process; raw error text can contain paths or credentials. */
export function getCollectorFailureCode(error) {
  if (error?.code === 'COLLECTOR_STATE_INVALID') return 'state-invalid';
  if (error?.code === 'COLLECTOR_LOCK_LOST') return 'ownership-lost';
  if (error?.code === 'COLLECTOR_OPERATION_TIMEOUT') return 'storage-timeout';
  if (/^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(error?.code ?? '')) return 'storage-locked';
  if (['EPERM', 'EACCES', 'EROFS', 'SQLITE_READONLY'].includes(error?.code))
    return 'storage-permission';
  if (['ENOSPC', 'SQLITE_FULL'].includes(error?.code)) return 'storage-full';
  return 'storage-unavailable';
}
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const exactFields = (value, fields) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const feedNames = ['benchmarkAt', 'spotAt', 'futuresAt', 'marketAt'];
const checkpoints = [12, 9, 6, 3, 1];
const modelIds = (value) =>
  Array.isArray(value) &&
  value.length <= 10 &&
  new Set(value).size === value.length &&
  value.every((id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,200}$/.test(id));

function isProgressHealth(value, heartbeatAt) {
  return (
    exactFields(value, ['lastSuccessfulTickAt', 'lastFailureAt', 'failureCode']) &&
    [value.lastSuccessfulTickAt, value.lastFailureAt].every(
      (time) => time === null || (timestamp(time) && time <= heartbeatAt),
    ) &&
    (value.failureCode === null || Object.hasOwn(COLLECTOR_FAILURE_MESSAGES, value.failureCode)) &&
    (value.failureCode === null || value.lastFailureAt !== null)
  );
}

function isRecordingHealth(value, heartbeatAt) {
  return (
    exactFields(value, [
      'loadedCandidateIds',
      'savedCandidateIds',
      'lastPredictionAt',
      'lastMarketQuoteAt',
    ]) &&
    modelIds(value.loadedCandidateIds) &&
    modelIds(value.savedCandidateIds) &&
    value.savedCandidateIds.every((id) => value.loadedCandidateIds.includes(id)) &&
    [value.lastPredictionAt, value.lastMarketQuoteAt].every(
      (time) => time === null || (timestamp(time) && time <= heartbeatAt),
    )
  );
}

/** Heartbeats expose operational timestamps, never host names, process IDs, paths or secrets. */
export function isCollectorHeartbeat(value) {
  return Boolean(
    exactFields(value, [
      'version',
      'collectorId',
      'codeVersion',
      'researchVersion',
      'startedAt',
      'heartbeatAt',
      'status',
      'feeds',
      'lastEvidenceAt',
      ...(Object.hasOwn(value ?? {}, 'recording') ? ['recording'] : []),
      ...(Object.hasOwn(value ?? {}, 'progress') ? ['progress'] : []),
    ]) &&
    value.version === COLLECTOR_HEARTBEAT_VERSION &&
    typeof value.collectorId === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(value.collectorId) &&
    typeof value.codeVersion === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(value.codeVersion) &&
    typeof value.researchVersion === 'string' &&
    /^[a-z0-9-]{1,100}$/.test(value.researchVersion) &&
    timestamp(value.startedAt) &&
    timestamp(value.heartbeatAt) &&
    value.startedAt <= value.heartbeatAt &&
    (!Object.hasOwn(value, 'recording') || isRecordingHealth(value.recording, value.heartbeatAt)) &&
    (!Object.hasOwn(value, 'progress') || isProgressHealth(value.progress, value.heartbeatAt)) &&
    ['starting', 'running', 'stopped', 'error'].includes(value.status) &&
    exactFields(value.feeds, feedNames) &&
    [...feedNames.map((name) => value.feeds[name]), value.lastEvidenceAt].every(
      (time) => time === null || (timestamp(time) && time <= value.heartbeatAt),
    ),
  );
}

function getFeedStatus(time, now, maximumAgeMs) {
  return {
    observedAt: timestamp(time) && time <= now ? time : null,
    status:
      !timestamp(time) || time > now ? 'unknown' : now - time <= maximumAgeMs ? 'fresh' : 'stale',
  };
}

/** Read-only archive coverage. Count known contract checkpoints, never invent offline contracts. */
function getCollectionCounts(evidence, labels, now) {
  const cutoff = now - COLLECTOR_HEALTH_POLICY.reportingWindowMs;
  const recent = evidence.filter(
    (row) =>
      row?.cohort === 'kalshi-background' &&
      timestamp(row.recordedAt) &&
      row.recordedAt >= cutoff &&
      row.recordedAt <= now &&
      isKalshiContract(row.kalshiMarket),
  );
  const contracts = new Map(recent.map((row) => [row.kalshiMarket.ticker, row.kalshiMarket]));
  const decisions = recent.filter((row) => row.event === 'decision');
  let dueCheckpoints = 0;
  let capturedCheckpoints = 0;
  for (const market of contracts.values()) {
    for (const minutes of checkpoints) {
      const dueAt = market.expiresAt - minutes * 60_000;
      if (dueAt < cutoff || now <= dueAt + 5000) continue;
      dueCheckpoints++;
      if (
        decisions.some(
          (row) =>
            row.kalshiMarket.ticker === market.ticker &&
            row.checkpointMinutes === minutes &&
            row.inputStatus === 'captured' &&
            timestamp(row.capturedAt) &&
            row.capturedAt >= dueAt &&
            row.capturedAt <= dueAt + 5000 &&
            Number.isFinite(row.aboveProbability) &&
            row.aboveProbability >= 0 &&
            row.aboveProbability <= 1,
        )
      )
        capturedCheckpoints++;
    }
  }
  const validLabels = labels.filter(
    (label) =>
      timestamp(label?.recordedAt) &&
      label.recordedAt <= now &&
      label.recordedAt >= cutoff &&
      ['observed', 'missing'].includes(label.status),
  );
  const labelKeys = new Set(
    labels
      .filter((label) => timestamp(label?.recordedAt) && label.recordedAt <= now)
      .map((label) => `${label.snapshotId}:${label.horizonSeconds}`),
  );
  const pending = new Set();
  for (const row of decisions) {
    const snapshotId = row.researchReplay?.snapshotId;
    if (!snapshotId || !timestamp(row.featureCutoffAt)) continue;
    for (const seconds of [15, 60, 180]) {
      const dueAt = Math.ceil((row.featureCutoffAt + seconds * 1000) / 1000) * 1000;
      const key = `${snapshotId}:${seconds}`;
      if (dueAt <= now && !labelKeys.has(key)) pending.add(key);
    }
  }
  return {
    windowHours: 24,
    knownContracts: contracts.size,
    dueCheckpoints,
    capturedCheckpoints,
    missedCheckpoints: dueCheckpoints - capturedCheckpoints,
    forwardObserved: validLabels.filter((label) => label.status === 'observed').length,
    forwardMissing: validLabels.filter((label) => label.status === 'missing').length,
    forwardPending: pending.size,
    recentResearchVersions: [
      ...new Set(
        decisions
          .filter((row) => now - row.recordedAt <= 900_000)
          .map((row) => row.researchExperiment?.version)
          .filter((version) => typeof version === 'string'),
      ),
    ],
    latestDecision: decisions.sort((left, right) => right.recordedAt - left.recordedAt)[0] ?? null,
  };
}

export function getCollectorHealth({
  heartbeats = [],
  evidence = [],
  labels = [],
  now = Date.now(),
} = {}) {
  if (!timestamp(now)) throw new Error('Collector health needs a valid observation time.');
  const unique = new Map();
  for (const heartbeat of heartbeats) {
    if (!isCollectorHeartbeat(heartbeat) || heartbeat.heartbeatAt > now) continue;
    if ((unique.get(heartbeat.collectorId)?.heartbeatAt ?? 0) <= heartbeat.heartbeatAt)
      unique.set(heartbeat.collectorId, heartbeat);
  }
  const collectors = [...unique.values()]
    .sort((left, right) => right.heartbeatAt - left.heartbeatAt)
    .map((heartbeat) => {
      const ageMs = now - heartbeat.heartbeatAt;
      const reportedActive = ['starting', 'running'].includes(heartbeat.status);
      return {
        status:
          reportedActive && ageMs > COLLECTOR_HEALTH_POLICY.staleAfterMs
            ? 'stale'
            : heartbeat.status,
        heartbeatAt: heartbeat.heartbeatAt,
        ageMs,
        startedAt: heartbeat.startedAt,
        codeVersion: heartbeat.codeVersion,
        researchVersion: heartbeat.researchVersion,
        isCurrentVersion:
          heartbeat.codeVersion === CURRENT_COLLECTOR_CODE_VERSION &&
          heartbeat.researchVersion === CURRENT_COLLECTOR_RESEARCH_VERSION,
        lastEvidenceAt: heartbeat.lastEvidenceAt,
        progress: {
          lastSuccessfulTickAt: heartbeat.progress?.lastSuccessfulTickAt ?? null,
          lastFailureAt: heartbeat.progress?.lastFailureAt ?? null,
          failureCode: heartbeat.progress?.failureCode ?? null,
          failureMessage: COLLECTOR_FAILURE_MESSAGES[heartbeat.progress?.failureCode] ?? null,
          evidenceOverdue:
            reportedActive &&
            heartbeat.heartbeatAt - (heartbeat.lastEvidenceAt ?? heartbeat.startedAt) >
              COLLECTOR_HEALTH_POLICY.maximumEvidenceSilenceMs &&
            getFeedStatus(
              heartbeat.feeds.marketAt,
              heartbeat.heartbeatAt,
              COLLECTOR_HEALTH_POLICY.maximumMarketAgeMs,
            ).status === 'fresh',
        },
        recording: heartbeat.recording
          ? {
              loadedCandidates: heartbeat.recording.loadedCandidateIds.length,
              savedCandidates: heartbeat.recording.savedCandidateIds.length,
              lastPredictionAt: heartbeat.recording.lastPredictionAt,
              lastMarketQuoteAt: heartbeat.recording.lastMarketQuoteAt,
            }
          : null,
        feeds: Object.fromEntries(
          feedNames.map((name) => [
            name,
            getFeedStatus(
              heartbeat.feeds[name],
              heartbeat.heartbeatAt,
              name === 'marketAt'
                ? COLLECTOR_HEALTH_POLICY.maximumMarketAgeMs
                : COLLECTOR_HEALTH_POLICY.maximumFeedAgeMs,
            ),
          ]),
        ),
      };
    });
  const active = collectors.filter((collector) =>
    ['running', 'starting'].includes(collector.status),
  );
  const { latestDecision, recentResearchVersions, ...counts } = getCollectionCounts(
    evidence,
    labels,
    now,
  );
  const latestResearchVersion = latestDecision?.researchExperiment?.version ?? null;
  const recentLegacyEvidence = recentResearchVersions.some(
    (version) => version !== CURRENT_COLLECTOR_RESEARCH_VERSION,
  );
  const status = active.some((collector) => collector.status === 'running')
    ? 'running'
    : active.length
      ? 'starting'
      : (collectors[0]?.status ?? 'unknown');
  return {
    generatedAt: now,
    status,
    activeCollectors: active.length,
    lastHeartbeatAt: collectors[0]?.heartbeatAt ?? null,
    expectedCodeVersion: CURRENT_COLLECTOR_CODE_VERSION,
    expectedResearchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
    needsRestart:
      active.some((collector) => !collector.isCurrentVersion) || Boolean(recentLegacyEvidence),
    evidence: {
      latestDecisionAt: latestDecision?.recordedAt ?? null,
      researchVersion: latestResearchVersion,
      recentResearchVersions,
      olderResearchDetected: Boolean(recentLegacyEvidence),
      // Browser recording shares this archive, so evidence cannot establish collector liveness.
      confirmsRunning: false,
    },
    collectors,
    counts,
  };
}
