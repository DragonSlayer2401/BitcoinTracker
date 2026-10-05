import { getKalshiContract } from '../kalshi/contract.utils';
import { collectLearningEvents, getIndependentRows } from './evaluation.utils';
import { getConflictingPatternForecastIds } from './patternFeatures.utils';
import { getPatternContractConflicts } from './patternEvidence.utils';
import { PATTERN_CANDIDATE_KINDS, isPatternModelArtifact } from './patternModel.utils';

export const PATTERN_COHORT_VERSION = 'kalshi-pattern-cohort-v2';

/** Availability comes from immutable storage time, never from a later successful prediction. */
export function getPatternSuiteRegistrations(artifacts = []) {
  const groups = new Map();
  for (const artifact of artifacts) {
    if (
      !isPatternModelArtifact(artifact) ||
      !Number.isSafeInteger(artifact.registeredAt) ||
      artifact.registeredAt < artifact.trainedAt
    )
      continue;
    const models = groups.get(artifact.suiteId) ?? [];
    models.push(artifact);
    groups.set(artifact.suiteId, models);
  }
  const registrations = [];
  for (const [suiteId, models] of groups) {
    if (
      models.length !== PATTERN_CANDIDATE_KINDS.length ||
      !PATTERN_CANDIDATE_KINDS.every(
        (kind) => models.filter((model) => model.kind === kind).length === 1,
      )
    )
      continue;
    const first = models[0];
    const coherent = [
      'version',
      'trainedAt',
      'featureVersion',
      'patternVersion',
      'baselineFeatureVersion',
      'datasetFingerprint',
      'trainingCutoffAt',
      'calibrationCutoffAt',
      'evaluationCutoffAt',
    ];
    if (!models.every((model) => coherent.every((key) => model[key] === first[key]))) continue;
    registrations.push({
      version: PATTERN_COHORT_VERSION,
      suiteId,
      registeredAt: Math.max(...models.map((model) => model.registeredAt)),
      trainedAt: first.trainedAt,
      modelVersion: first.version,
      featureVersion: first.featureVersion,
      patternVersion: first.patternVersion,
      baselineFeatureVersion: first.baselineFeatureVersion,
      kinds: [...PATTERN_CANDIDATE_KINDS],
      modelIds: Object.fromEntries(models.map((model) => [model.kind, model.id])),
    });
  }
  return normalizePatternSuiteRegistrations(registrations);
}

/** A newer fully registered suite replaces the previous suite only for contracts starting later. */
export function normalizePatternSuiteRegistrations(
  registrations = [],
  now = Number.MAX_SAFE_INTEGER,
) {
  const valid = registrations
    .filter(
      (entry) =>
        entry &&
        typeof entry.suiteId === 'string' &&
        Number.isSafeInteger(entry.registeredAt) &&
        entry.registeredAt > 0 &&
        entry.registeredAt <= now &&
        Number.isSafeInteger(entry.trainedAt) &&
        entry.trainedAt >= 0 &&
        entry.trainedAt <= entry.registeredAt &&
        typeof entry.modelVersion === 'string' &&
        typeof entry.featureVersion === 'string' &&
        typeof entry.patternVersion === 'string' &&
        Array.isArray(entry.kinds) &&
        entry.kinds.length === PATTERN_CANDIDATE_KINDS.length &&
        PATTERN_CANDIDATE_KINDS.every((kind) => entry.kinds.includes(kind)),
    )
    .sort(
      (left, right) =>
        left.registeredAt - right.registeredAt || left.suiteId.localeCompare(right.suiteId),
    );
  // Conflicting duplicate registration metadata must not select a convenient boundary.
  const unique = valid.filter(
    (entry, index) =>
      valid.findIndex((other) => other.suiteId === entry.suiteId) === index &&
      valid
        .filter((other) => other.suiteId === entry.suiteId)
        .every((other) =>
          ['registeredAt', 'trainedAt', 'modelVersion', 'featureVersion', 'patternVersion'].every(
            (key) => other[key] === entry[key],
          ),
        ),
  );
  return unique.map((entry, index) => ({
    ...entry,
    version: PATTERN_COHORT_VERSION,
    cohortId: `${PATTERN_COHORT_VERSION}:${entry.suiteId}:${entry.registeredAt}`,
    endsAt: unique[index + 1]?.registeredAt ?? null,
  }));
}

export function isContractInPatternCohort(contract, registration) {
  return Boolean(
    contract &&
    contract.startsAt > registration.registeredAt &&
    (registration.endsAt === null || contract.startsAt <= registration.endsAt),
  );
}

/** Cohort slots precede feature, prediction and outcome filtering, including terminal failures. */
export function getPatternProspectiveCohorts(
  events = [],
  { now = Date.now(), patternSuites = [] } = {},
) {
  const registrations = normalizePatternSuiteRegistrations(patternSuites, now);
  const conflicts = getPatternContractConflicts(events, now);
  const predictionConflicts = getConflictingPatternForecastIds(events, now);
  for (const id of collectLearningEvents(events, now).conflicts) predictionConflicts.add(id);
  const first = new Map();
  const decisions = events
    .filter(
      (event) =>
        event?.event === 'decision' &&
        event.cohort === 'kalshi-background' &&
        Number.isSafeInteger(event.recordedAt) &&
        event.recordedAt > 0 &&
        event.recordedAt <= now &&
        typeof event.forecastId === 'string' &&
        getKalshiContract(event.kalshiMarket),
    )
    .sort(
      (left, right) =>
        (left.capturedAt ?? left.recordedAt) - (right.capturedAt ?? right.recordedAt) ||
        left.recordedAt - right.recordedAt ||
        left.forecastId.localeCompare(right.forecastId),
    );
  for (const decision of decisions) {
    const key = `${decision.kalshiMarket.ticker}:${decision.checkpointMinutes ?? 'fixed'}`;
    if (!first.has(key)) first.set(key, decision);
  }
  return registrations.map((registration) => {
    const enrolled = [...first.values()].filter((decision) =>
      isContractInPatternCohort(decision.kalshiMarket, registration),
    );
    const opportunities = getIndependentRows(
      enrolled.map((decision) => ({
        id: decision.forecastId,
        windowStartAt: decision.kalshiMarket.startsAt,
        expiresAt: decision.kalshiMarket.expiresAt,
        capturedAt: decision.capturedAt ?? decision.recordedAt,
        horizonMinutes:
          decision.checkpointMinutes ?? (decision.expiresAt - decision.capturedAt) / 60000,
        outcomeDefinition: decision.outcomeDefinition,
        decision,
        terminalFailure: conflicts.contractTickers.has(decision.kalshiMarket.ticker)
          ? 'conflicting-contract'
          : predictionConflicts.has(decision.forecastId)
            ? 'conflicting-pattern-capture'
            : null,
      })),
    );
    const rejected = enrolled.filter((decision) =>
      conflicts.contractTickers.has(decision.kalshiMarket.ticker),
    );
    return {
      registration,
      opportunities,
      counts: {
        captures: enrolled.length,
        independentWindows: opportunities.length,
        rejectedContracts: new Set(rejected.map((decision) => decision.kalshiMarket.ticker)).size,
        rejectedCaptures: new Set(rejected.map((decision) => decision.forecastId)).size,
      },
    };
  });
}
