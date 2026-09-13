import {
  isKalshiContract,
  KALSHI_OUTCOME_DEFINITION,
} from '@/features/BitcoinTracker/utils/kalshi/contract.utils';

export class ResearchDataError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ResearchDataError';
    this.status = status;
  }
}

export const MAXIMUM_RESEARCH_BATCH = 100;
export const MAXIMUM_RESEARCH_BODY_BYTES = 4 * 1024 * 1024;
const maximumRowBytes = 128 * 1024;
const timestampFields = [
  'recordedAt',
  'windowStartAt',
  'createdAt',
  'startsAt',
  'expiresAt',
  'capturedAt',
  'decisionAt',
  'inputObservedAt',
  'featureCutoffAt',
  'quoteTime',
  'receivedAt',
  'observedAt',
  'confirmedThrough',
  'completeSince',
];
const terminalForecastStates = ['withheld', 'unobserved', 'resolved'];
const immutableContractFields = [
  'target',
  'expiresAt',
  'startsAt',
  'outcomeDefinition',
  'analysis',
  'kalshiMarket',
];
const immutablePredictionFields = [
  'createdAt',
  'price',
  'aboveProbability',
  'belowProbability',
  'direction',
  'calculationMode',
  'learning',
  'modelVersion',
  'kalshi',
  'derivatives',
];

export function isResearchIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f]/.test(value)
  );
}

export function isResearchTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function getCanonicalValue(value, depth = 0) {
  if (depth > 24) throw new ResearchDataError('Research data is nested too deeply.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => getCanonicalValue(item, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, getCanonicalValue(value[key], depth + 1)]),
    );
  }
  throw new ResearchDataError('Research data must contain only finite JSON values.');
}

export function getCanonicalResearchJson(value, maximumBytes = maximumRowBytes) {
  const json = JSON.stringify(getCanonicalValue(value));
  if (Buffer.byteLength(json, 'utf8') > maximumBytes) {
    throw new ResearchDataError('Research data exceeds the supported record size.', 413);
  }
  return json;
}

export function validateResearchBatch(rows) {
  if (!Array.isArray(rows) || rows.length > MAXIMUM_RESEARCH_BATCH) {
    throw new ResearchDataError(
      `Send no more than ${MAXIMUM_RESEARCH_BATCH} research records at once.`,
    );
  }
}

function validateCommonFields(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new ResearchDataError('Research records must be objects.');
  }
  if (
    row.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
    !isKalshiContract(row.kalshiMarket) ||
    row.target !== row.kalshiMarket.target ||
    row.expiresAt !== row.kalshiMarket.expiresAt
  )
    throw new ResearchDataError('Only forecasts for a verified Kalshi contract can be stored.');
  for (const field of timestampFields) {
    if (row[field] !== undefined && row[field] !== null && !isResearchTimestamp(row[field])) {
      throw new ResearchDataError(`Research ${field} must be a valid timestamp.`);
    }
  }
  for (const field of [
    'aboveProbability',
    'belowProbability',
    'modelAboveProbability',
    'modelBelowProbability',
  ]) {
    if (
      row[field] !== undefined &&
      row[field] !== null &&
      (typeof row[field] !== 'number' ||
        !Number.isFinite(row[field]) ||
        row[field] < 0 ||
        row[field] > 1)
    ) {
      throw new ResearchDataError(`Research ${field} must be between zero and one.`);
    }
  }
  if (
    typeof row.target !== 'number' ||
    !Number.isFinite(row.target) ||
    row.target <= 0 ||
    row.target > 1_000_000_000
  ) {
    throw new ResearchDataError('Research target must be a positive price.');
  }
}

export function validateEvidenceRow(row) {
  validateCommonFields(row);
  if (
    !isResearchIdentifier(row.eventId) ||
    !isResearchIdentifier(row.forecastId) ||
    !['observation', 'decision', 'outcome', 'restored'].includes(row.event) ||
    !isResearchTimestamp(row.recordedAt) ||
    !isResearchTimestamp(row.expiresAt)
  ) {
    throw new ResearchDataError('Research evidence has an invalid identity, event, or deadline.');
  }
  if (
    ['inputObservedAt', 'featureCutoffAt'].some(
      (field) => row[field] != null && row[field] > row.recordedAt,
    )
  ) {
    throw new ResearchDataError('Research inputs cannot come from after the recording time.');
  }
  return getCanonicalResearchJson(row);
}

export function validateForecastSnapshot(row) {
  validateCommonFields(row);
  if (
    !isResearchIdentifier(row.id) ||
    !isResearchIdentifier(row.modelVersion) ||
    !['analyzing', 'pending', 'awaiting-settlement', 'resolved', 'unobserved', 'withheld'].includes(
      row.status,
    ) ||
    !isResearchTimestamp(row.createdAt) ||
    !isResearchTimestamp(row.expiresAt) ||
    row.createdAt >= row.expiresAt
  ) {
    throw new ResearchDataError('Saved forecast has an invalid identity, status, or deadline.');
  }
  const hasNoPrediction = ['analyzing', 'withheld'].includes(row.status);
  if (
    !['above', 'below', 'neutral'].includes(row.direction) ||
    (hasNoPrediction
      ? row.aboveProbability !== null ||
        row.belowProbability !== null ||
        row.direction !== 'neutral'
      : typeof row.aboveProbability !== 'number' ||
        typeof row.belowProbability !== 'number' ||
        Math.abs(row.aboveProbability + row.belowProbability - 1) > 0.000001)
  ) {
    throw new ResearchDataError('Saved forecast probabilities must match its publication state.');
  }
  return getCanonicalResearchJson(row);
}

/** Snapshots can arrive out of order, but cannot rewrite a saved decision. */
export function validateForecastSnapshotConsistency(original, snapshot) {
  const hasConflictingOutcome =
    terminalForecastStates.includes(original.status) &&
    terminalForecastStates.includes(snapshot.status) &&
    original.status !== snapshot.status;
  const hasConflictingPublication =
    (original.status === 'withheld' && snapshot.aboveProbability != null) ||
    (snapshot.status === 'withheld' && original.aboveProbability != null);
  if (hasConflictingOutcome || hasConflictingPublication) {
    throw new ResearchDataError(
      'A forecast cannot replace a previously saved final outcome or publication decision.',
      409,
    );
  }

  // Analyzing snapshots may publish a prediction later. Once both snapshots have
  // predictions, their captured inputs and probabilities must agree exactly.
  const bothHavePrediction = original.aboveProbability != null && snapshot.aboveProbability != null;
  const immutableFields = bothHavePrediction
    ? [...immutableContractFields, ...immutablePredictionFields]
    : immutableContractFields;
  const hasChangedImmutableField = immutableFields.some(
    (field) =>
      getCanonicalResearchJson(original[field] ?? null) !==
      getCanonicalResearchJson(snapshot[field] ?? null),
  );
  if (hasChangedImmutableField) {
    throw new ResearchDataError(
      'A forecast snapshot cannot change its original target, deadline, or captured prediction.',
      409,
    );
  }
}

export function validateModelArtifact(artifact) {
  if (
    !isResearchIdentifier(artifact?.id) ||
    !isResearchIdentifier(artifact?.version) ||
    !isResearchTimestamp(artifact?.trainedAt)
  ) {
    throw new ResearchDataError(
      'Model artifacts require a stable identifier, version, and training timestamp.',
    );
  }
  if (artifact.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION) {
    throw new ResearchDataError('Only Kalshi model artifacts can be stored.');
  }
  return getCanonicalResearchJson(artifact, 2 * 1024 * 1024);
}

export function getResearchPage({ after = 0, limit = 500 } = {}) {
  const cursor = typeof after === 'string' && /^\d+$/.test(after) ? Number(after) : after;
  const count = typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : limit;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 2000
  ) {
    throw new ResearchDataError('Use a nonnegative cursor and a page size from 1 to 2000.');
  }
  return { after: cursor, limit: count };
}
