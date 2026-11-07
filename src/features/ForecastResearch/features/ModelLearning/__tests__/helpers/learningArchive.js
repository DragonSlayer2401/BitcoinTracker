import {
  getCanonicalResearchJson,
  isResearchIdentifier,
  isResearchTimestamp,
} from '@/services/research/research.validation';

const copy = (value) => JSON.parse(JSON.stringify(value));
const same = (left, right) => getCanonicalResearchJson(left) === getCanonicalResearchJson(right);

// The archive is an isolated external persistence boundary. Training, selection,
// prospective evaluation and monitoring always run in the real learning service.
export const createLearningArchive = ({
  events = [],
  artifacts = [],
  activeId = null,
  forecasts = [],
  developments = [],
  trials = [],
  labels = [],
  heartbeats = [],
} = {}) => {
  const savedEvents = copy(events);
  const savedArtifacts = copy(artifacts);
  const savedForecasts = copy(forecasts);
  const savedDevelopments = copy(developments);
  const savedTrials = copy(trials);
  const savedLabels = copy(labels);
  const activations = savedArtifacts
    .filter((artifact) => artifact.activation)
    .map((artifact) => ({
      modelId: artifact.id,
      activatedAt: artifact.activation.activatedAt,
      retiredAt: artifact.retirement?.retiredAt ?? null,
    }))
    .sort((left, right) => left.activatedAt - right.activatedAt);
  const writes = [];
  let currentActiveId = activeId;
  let lease = null;
  let leaseAvailable = true;
  const getArtifact = (id) => savedArtifacts.find((artifact) => artifact.id === id);
  const updateRun = (runs, id, { now, ...patch }, phase) => {
    const allowedStatuses =
      phase === 'development'
        ? ['collecting', 'passed', 'failed', 'unusable-evidence']
        : ['collecting', 'passed', 'failed', 'abandoned'];
    if (
      !isResearchIdentifier(id) ||
      !isResearchTimestamp(now) ||
      !allowedStatuses.includes(patch.status) ||
      !Array.isArray(patch.cohortForecastIds) ||
      patch.cohortForecastIds.length > 60 ||
      new Set(patch.cohortForecastIds).size !== patch.cohortForecastIds.length ||
      !patch.cohortForecastIds.every(isResearchIdentifier)
    )
      throw new Error('Invalid prospective cohort update.');
    const previous = runs.find((run) => run.modelId === id);
    if (!previous) throw new Error('Saved prospective run not found.');
    if (
      now < previous.updatedAt ||
      previous.cohortForecastIds.some((value, index) => patch.cohortForecastIds?.[index] !== value)
    )
      throw new Error('Saved prospective membership cannot be replaced.');
    if (previous.status !== 'collecting') {
      if (
        patch.status !== previous.status ||
        !same(patch.cohortForecastIds, previous.cohortForecastIds) ||
        !same(patch.evaluation, previous.evaluation)
      )
        throw new Error('A completed prospective run is immutable.');
      return copy(previous);
    }
    const evaluation = patch.evaluation;
    const matchingEvaluation =
      evaluation?.modelId === id &&
      evaluation.phase === phase &&
      evaluation.evaluationComplete === true &&
      evaluation.evaluatedAt === now &&
      evaluation.startedAt === previous.startedAt &&
      same(evaluation.cohortForecastIds, patch.cohortForecastIds);
    if (
      phase === 'development' &&
      patch.status !== 'collecting' &&
      (!matchingEvaluation ||
        (patch.status === 'passed' && evaluation.developmentPassed !== true) ||
        (patch.status === 'unusable-evidence' && evaluation.failureCategory !== 'evidence'))
    )
      throw new Error('Completed development requires its original cohort evaluation.');
    if (
      phase === 'confirmation' &&
      patch.status === 'passed' &&
      (!matchingEvaluation ||
        patch.cohortForecastIds.length !== 60 ||
        evaluation.eligibleForPromotion !== true ||
        evaluation.attemptNumber !== previous.attemptNumber ||
        !Array.isArray(evaluation.approvedCheckpoints) ||
        !evaluation.approvedCheckpoints.length ||
        new Set(evaluation.approvedCheckpoints).size !== evaluation.approvedCheckpoints.length ||
        evaluation.approvedCheckpoints.some(
          (minutes) => !previous.approvedCheckpoints.includes(minutes),
        ))
    )
      throw new Error('Passing confirmation requires the complete recorded prospective cohort.');
    Object.assign(previous, copy(patch), { updatedAt: now });
    return copy(previous);
  };
  const repository = {
    getLearningEvidenceRows: jest.fn(async () => copy(savedEvents)),
    getForwardResearchLabels: async () => copy(savedLabels),
    readStoredForecasts: async () => ({ rows: copy(savedForecasts), nextCursor: null }),
    readModelArtifacts: jest.fn(async () => copy(savedArtifacts)),
    getActiveModelArtifact: async () => copy(getArtifact(currentActiveId) ?? null),
    readModelActivationHistory: async () => copy(activations),
    readCollectorHeartbeats: async () => copy(heartbeats),
    getPatternPaperObservations: async () => [],
    readPatternSuiteRegistrations: async () => [],
    readChallengerDevelopments: async () => copy(savedDevelopments),
    readChallengerTrials: async () => copy(savedTrials),
    writeModelArtifact: jest.fn(async (artifact) => {
      if (!getArtifact(artifact.id)) {
        savedArtifacts.push(copy(artifact));
        writes.push({ type: 'trained', id: artifact.id });
      }
      return copy(getArtifact(artifact.id));
    }),
    activateModelArtifact: jest.fn(async (id, activation) => {
      const { activatedAt, shadowEvaluation } = activation ?? {};
      if (
        !isResearchIdentifier(id) ||
        !isResearchTimestamp(activatedAt) ||
        shadowEvaluation?.eligibleForPromotion !== true ||
        shadowEvaluation.modelId !== id ||
        !isResearchTimestamp(shadowEvaluation.evaluatedAt) ||
        shadowEvaluation.evaluatedAt > activatedAt
      )
        throw new Error(
          'Activation requires a timestamp and a passing prospective shadow evaluation.',
        );
      const artifact = getArtifact(id);
      if (!artifact || artifact.retirement)
        throw new Error('An unretired saved model is required.');
      if (activatedAt <= artifact.trainedAt)
        throw new Error('Model activation must follow training.');
      if (activations.length && activatedAt < activations.at(-1).activatedAt)
        throw new Error('Activation cannot replace a newer activation.');
      const incumbent = getArtifact(currentActiveId);
      if (artifact.version === 'forecast-challenger-v2') {
        const confirmation = savedTrials.find((trial) => trial.modelId === id);
        if (activations.some((record) => record.modelId === id))
          throw new Error('A confirmation trial can activate its candidate only once.');
        if (
          !confirmation ||
          confirmation.status !== 'passed' ||
          shadowEvaluation.phase !== 'confirmation' ||
          !same(confirmation.evaluation, shadowEvaluation) ||
          confirmation.updatedAt > activatedAt ||
          confirmation.productionModelId !== (incumbent?.id ?? null) ||
          confirmation.productionActivatedAt !== (incumbent?.activation.activatedAt ?? null)
        )
          throw new Error(
            'Activation requires persisted passing confirmation against the unchanged incumbent.',
          );
      }
      if (
        artifact.version === 'outcome-early-kalshi-v1' &&
        incumbent &&
        incumbent.version !== 'outcome-early-kalshi-v1'
      )
        throw new Error('An early model cannot replace the full learned model.');
      artifact.activation = { modelId: id, ...copy(activation) };
      currentActiveId = id;
      activations.push({ modelId: id, activatedAt: activation.activatedAt });
      writes.push({ type: 'activated', id });
      const trial = savedTrials.find((trial) => trial.modelId === id);
      if (trial) trial.activatedAt = activation.activatedAt;
      return copy(artifact);
    }),
    retireModelArtifact: jest.fn(async (id, retirement) => {
      const artifact = getArtifact(id);
      if (!artifact) throw new Error('Saved model not found.');
      if (
        !isResearchTimestamp(retirement?.retiredAt) ||
        retirement.retiredAt <= artifact.trainedAt ||
        retirement.retiredAt < (artifact.activation?.activatedAt ?? 0) ||
        typeof retirement.reason !== 'string' ||
        !retirement.reason.trim()
      )
        throw new Error(
          'Retirement requires a reason and a timestamp after training and activation.',
        );
      if (artifact.retirement) return copy(artifact);
      artifact.retirement = {
        ...copy(retirement),
        wasActive: activations.some((record) => record.modelId === id),
      };
      if (currentActiveId === id) currentActiveId = null;
      writes.push({ type: 'retired', id });
      activations
        .filter((record) => record.modelId === id)
        .forEach((record) => {
          record.retiredAt = retirement.retiredAt;
        });
      return copy(artifact);
    }),
    acquireLearningLease: jest.fn(async (requested) => {
      if (
        !leaseAvailable ||
        (lease && lease.expiresAt > requested.now && lease.ownerId !== requested.ownerId)
      )
        return false;
      lease = { ...requested };
      return true;
    }),
    releaseLearningLease: jest.fn(async (ownerId) => {
      if (lease?.ownerId === ownerId) lease = null;
    }),
    createChallengerDevelopment: async ({ modelId, now, readiness = null }) => {
      const existing = savedDevelopments.find((run) => run.modelId === modelId);
      if (existing) return copy(existing);
      const development = {
        version: 'challenger-development-v1',
        modelId,
        createdAt: now,
        updatedAt: now,
        startedAt: readiness
          ? (Math.floor(now / 900_000) + 1) * 900_000
          : getArtifact(modelId).shadowStartsAt,
        inclusiveBoundary: Boolean(readiness),
        readiness,
        status: 'collecting',
        cohortForecastIds: [],
        evaluation: null,
      };
      savedDevelopments.push(copy(development));
      return copy(development);
    },
    updateChallengerDevelopment: async (id, update) =>
      updateRun(
        savedDevelopments,
        id,
        { status: 'collecting', evaluation: null, ...update },
        'development',
      ),
    createChallengerTrial: async (input) => {
      const existing = savedTrials.find((run) => run.modelId === input.modelId);
      if (existing) return copy(existing);
      if (savedTrials.some((trial) => trial.status === 'collecting'))
        throw new Error('Another confirmation trial is already collecting.');
      const trial = {
        version: 'challenger-confirmation-v1',
        ...copy(input),
        attemptNumber: savedTrials.length + 1,
        updatedAt: input.startedAt,
        status: 'collecting',
        cohortForecastIds: [],
        evaluation: null,
        activatedAt: null,
      };
      savedTrials.push(trial);
      return copy(trial);
    },
    updateChallengerTrial: async (id, update) =>
      updateRun(
        savedTrials,
        id,
        { status: 'collecting', evaluation: null, ...update },
        'confirmation',
      ),
  };
  const archive = {
    repository,
    events: savedEvents,
    artifacts: savedArtifacts,
    forecasts: savedForecasts,
    developments: savedDevelopments,
    trials: savedTrials,
    labels: savedLabels,
    heartbeats,
    writes,
    addEvents: (rows) => savedEvents.push(...copy(rows)),
    setActive: (id) => {
      currentActiveId = id;
    },
    setLeaseAvailable: (available) => {
      leaseAvailable = available;
    },
  };
  Object.defineProperty(archive, 'activeId', { get: () => currentActiveId, enumerable: true });
  return archive;
};
