import 'server-only';
import { randomUUID } from 'node:crypto';
import * as researchRepository from './research.repository';
import {
  analyzeForecastEvidence,
  analyzeSavedForecasts,
  getVerifiedLearningRows,
  getIndependentRows,
  groupOverlappingWindows,
} from '@/features/BitcoinTracker/utils/learning/evaluation.utils';
import {
  isOutcomeModelArtifact,
  matchesOutcomeModelPipeline,
} from '@/features/BitcoinTracker/utils/learning/model.utils';
import { KALSHI_OUTCOME_DEFINITION } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  evaluateShadowCandidate,
  LEARNING_REQUIREMENTS,
  splitLearningWindows,
  trainOutcomeCandidate,
  selectLearningPipelineRows,
} from '@/features/BitcoinTracker/utils/learning/training.utils';
import {
  EARLY_LEARNING_REQUIREMENTS,
  isEarlyModelArtifact,
} from '@/features/BitcoinTracker/utils/learning/earlyModel.utils';
import {
  evaluateEarlyActiveModel,
  evaluateEarlyShadowCandidate,
  trainEarlyCandidate,
} from '@/features/BitcoinTracker/utils/learning/earlyTraining.utils';

const MINIMUM_NEW_WINDOWS_FOR_RETRAINING = 60;
const LEARNING_LEASE_DURATION_MS = 120_000;
const outcomeDefinition = KALSHI_OUTCOME_DEFINITION;

function isCurrentArtifact(model) {
  return isOutcomeModelArtifact(model) && model.outcomeDefinition === outcomeDefinition;
}

function selectResearchModels(artifacts, storedActive, pipeline = null) {
  const matchesCurrentPipeline = (model) =>
    !pipeline || matchesOutcomeModelPipeline(model, pipeline);
  const active =
    (isCurrentArtifact(storedActive) || isEarlyModelArtifact(storedActive)) &&
    !storedActive.retirement &&
    matchesCurrentPipeline(storedActive)
      ? storedActive
      : null;
  const fullActive = isCurrentArtifact(active) ? active : null;
  const earlyActive = isEarlyModelArtifact(active) ? active : null;
  const models = artifacts
    .filter(isCurrentArtifact)
    .sort((left, right) => left.trainedAt - right.trainedAt);
  const latest = models.filter(matchesCurrentPipeline).at(-1) ?? null;
  const canEvaluateLatestInShadow =
    latest?.evaluation?.eligibleForShadow &&
    !latest.retirement &&
    latest.id !== fullActive?.id &&
    (!fullActive || latest.trainedAt > fullActive.trainedAt);
  const earlyModels = artifacts
    .filter(isEarlyModelArtifact)
    .filter(matchesCurrentPipeline)
    .sort((left, right) => left.trainedAt - right.trainedAt);
  const latestEarly = earlyModels.at(-1) ?? null;
  const canEvaluateEarlyInShadow =
    !fullActive &&
    latestEarly?.evaluation?.eligibleForShadow &&
    !latestEarly.retirement &&
    latestEarly.id !== earlyActive?.id &&
    (!earlyActive || latestEarly.trainedAt > earlyActive.trainedAt);
  return {
    active,
    models,
    latest,
    candidate: canEvaluateLatestInShadow ? latest : null,
    fullActive,
    earlyActive,
    latestEarly,
    retiredEarly: earlyModels.filter((model) => model.retirement?.wasActive).at(-1) ?? null,
    earlyCandidate: canEvaluateEarlyInShadow ? latestEarly : null,
  };
}

function getEarlyCounts(rows, pipeline, latest, active) {
  const independent = getIndependentRows(rows);
  const retrainingCutoff =
    latest?.retirement?.retiredAt ??
    (latest?.id === active?.id ? active?.activation?.activatedAt : null) ??
    latest?.trainedAt ??
    0;
  return {
    training: independent.length,
    independentWindows: independent.length,
    newWindows: groupOverlappingWindows(rows.filter((row) => row.windowStartAt > retrainingCutoff))
      .length,
    classes: {
      above: independent.filter((row) => row.outcome === 1).length,
      below: independent.filter((row) => row.outcome === 0).length,
    },
    pipeline,
  };
}

function getEarlyTrainingStatus({
  fullActive,
  active,
  candidate,
  latest,
  counts,
  shadow,
  monitoring,
}) {
  if (fullActive)
    return { status: 'superseded', reason: 'The full learned model is active.', counts };
  if (candidate)
    return {
      status:
        shadow.evaluationComplete && !shadow.eligibleForPromotion ? 'candidate-rejected' : 'shadow',
      reason:
        shadow.reasons[0] ?? 'The early candidate passed future checks and awaits activation.',
      counts,
    };
  if (active)
    return {
      status: monitoring?.status === 'disabled' ? 'disabled' : 'active',
      reason:
        monitoring?.reason ?? 'The early model is active with a limited probability adjustment.',
      counts,
    };
  if (latest && counts.newWindows < EARLY_LEARNING_REQUIREMENTS.minimumNewWindowsForRetraining)
    return {
      status: 'collecting',
      reason: `${latest.retirement?.reason ?? 'The previous early candidate was not promoted.'} Collect 20 new independent events before fitting another early candidate.`,
      counts,
    };
  const hasEnoughWindows =
    counts.training >= EARLY_LEARNING_REQUIREMENTS.minimumTrainingWindows &&
    Object.values(counts.classes).every(
      (count) => count >= EARLY_LEARNING_REQUIREMENTS.minimumClassExamples,
    );
  return {
    status: hasEnoughWindows ? 'ready-to-train' : 'insufficient-data',
    reason: hasEnoughWindows
      ? 'Enough events are available to fit an experimental early candidate; future validation is still required.'
      : 'Collect 40 independent events with at least eight YES and eight NO outcomes from the same model version and price-data sources.',
    counts,
  };
}

function getTrainingStatus({ candidate, shadow, latest, counts }) {
  if (candidate) {
    return {
      status: 'shadow',
      reason:
        shadow.reasons[0] ??
        'The candidate passed prospective checks and awaits the next analysis cycle.',
      counts,
    };
  }
  if (latest && !latest.evaluation.eligibleForShadow) {
    return { status: 'candidate-rejected', reason: latest.evaluation.reasons[0], counts };
  }

  const hasEnoughWindows =
    counts.training >= LEARNING_REQUIREMENTS.minimumTrainingWindows &&
    counts.calibration >= LEARNING_REQUIREMENTS.minimumCalibrationWindows &&
    counts.test >= LEARNING_REQUIREMENTS.minimumTestWindows;
  return {
    status: hasEnoughWindows ? 'ready-to-train' : 'insufficient-data',
    reason: hasEnoughWindows
      ? 'Enough independent windows are available to attempt training; all chronological and class-balance checks still apply.'
      : 'Collect 120 training, 60 calibration, and 60 later test windows using the same baseline version and price-data sources after overlap grouping and boundary purging.',
    counts,
  };
}

export function createLearningService(repository) {
  let runningCycle;

  async function getResearchModels() {
    const [artifacts, storedActive] = await Promise.all([
      repository.readModelArtifacts(),
      repository.getActiveModelArtifact(),
    ]);
    let selected = selectResearchModels(artifacts, storedActive);
    if (selected.earlyActive) {
      const now = Date.now();
      const events = await repository.getLearningEvidenceRows();
      const monitoring = evaluateEarlyActiveModel(selected.earlyActive, events, { now });
      if (monitoring.status === 'disabled') {
        // Stop serving degraded influence immediately. The leased analysis cycle records
        // retirement durably; read endpoints never mutate models or activate replacements.
        const stoppedId = selected.earlyActive.id;
        selected = selectResearchModels(
          artifacts.map((model) =>
            model.id === stoppedId
              ? { ...model, retirement: { retiredAt: now, reason: monitoring.reason } }
              : model,
          ),
          null,
        );
      }
    }
    return {
      active: selected.active,
      candidate: selected.candidate,
      earlyCandidate: selected.earlyCandidate,
    };
  }

  async function readSavedForecasts() {
    const forecasts = [];
    let after = null;
    do {
      const page = await repository.readStoredForecasts({ after: after ?? 0, limit: 2000 });
      forecasts.push(...page.rows);
      if (forecasts.length > 250_000)
        throw new Error(
          'Saved forecast analysis exceeds the supported batch size. Use the paginated export.',
        );
      after = page.nextCursor;
    } while (after !== null);
    return forecasts;
  }

  async function readState(now) {
    const [events, artifacts, storedActive, forecasts] = await Promise.all([
      repository.getLearningEvidenceRows(),
      repository.readModelArtifacts(),
      repository.getActiveModelArtifact(),
      readSavedForecasts(),
    ]);
    const verifiedRows = getVerifiedLearningRows(events, now, { outcomeDefinition }).rows;
    const { rows: learningRows, pipeline } = selectLearningPipelineRows(verifiedRows);
    const {
      active,
      models,
      latest,
      candidate,
      fullActive,
      earlyActive,
      latestEarly,
      retiredEarly,
      earlyCandidate,
    } = selectResearchModels(artifacts, storedActive, pipeline);
    const analysis = analyzeForecastEvidence(events, now, { outcomeDefinition });
    analysis.savedJournal = analyzeSavedForecasts(forecasts, now);
    const split = splitLearningWindows(learningRows);
    const shadow = candidate ? evaluateShadowCandidate(candidate, events, { now }) : null;
    const counts = {
      training: split.train.length,
      calibration: split.calibration.length,
      test: split.test.length,
      independentWindows: split.groupCount,
      purgedGroups: split.purgedGroups,
      pipeline,
    };
    const training = getTrainingStatus({ candidate, shadow, latest, counts });
    const earlyShadow = earlyCandidate
      ? evaluateEarlyShadowCandidate(earlyCandidate, events, { now })
      : null;
    const monitoring = earlyActive
      ? evaluateEarlyActiveModel(earlyActive, events, { now })
      : retiredEarly && !fullActive
        ? {
            status: 'disabled',
            reason: retiredEarly.retirement.reason,
            retiredAt: retiredEarly.retirement.retiredAt,
          }
        : null;
    const isEarlyDisabled = monitoring?.status === 'disabled';
    const earlyCounts = getEarlyCounts(learningRows, pipeline, latestEarly, earlyActive);
    const earlyTraining = getEarlyTrainingStatus({
      fullActive,
      active: earlyActive,
      candidate: earlyCandidate,
      latest: latestEarly,
      counts: earlyCounts,
      shadow: earlyShadow,
      monitoring,
    });
    return {
      events,
      latest,
      latestEarly,
      earlyActiveForMonitoring: earlyActive,
      learningRows,
      result: {
        generatedAt: now,
        analysis,
        active: earlyActive && isEarlyDisabled ? null : active,
        candidate,
        earlyCandidate,
        shadow,
        requirements: LEARNING_REQUIREMENTS,
        training,
        early: {
          active: isEarlyDisabled ? null : earlyActive,
          candidate: earlyCandidate,
          training: earlyTraining,
          shadow: earlyShadow,
          monitoring,
          requirements: EARLY_LEARNING_REQUIREMENTS,
        },
        models: models.map((model) => ({
          id: model.id,
          trainedAt: model.trainedAt,
          active: model.id === active?.id,
          eligibleForShadow: model.evaluation.eligibleForShadow,
          evaluation: model.evaluation,
        })),
      },
    };
  }

  async function getLearningStatus({ now = Date.now() } = {}) {
    return (await readState(now)).result;
  }

  async function advanceFullModel(state, now) {
    const { candidate, shadow } = state.result;
    if (candidate && shadow.eligibleForPromotion) {
      await repository.activateModelArtifact(candidate.id, {
        activatedAt: now,
        shadowEvaluation: shadow,
      });
      return {
        changed: true,
        lastRun: {
          status: 'activated',
          modelId: candidate.id,
          reason:
            'The candidate passed the predeclared checks on independent future background windows.',
        },
      };
    }
    if (candidate && !shadow.evaluationComplete)
      return { lastRun: { status: 'shadow', reason: shadow.reasons[0] } };
    const newIndependentWindowCount = state.latest
      ? groupOverlappingWindows(
          state.learningRows.filter((row) => row.windowStartAt > state.latest.trainedAt),
        ).length
      : Infinity;
    if (state.latest && newIndependentWindowCount < MINIMUM_NEW_WINDOWS_FOR_RETRAINING)
      return {
        lastRun: {
          status: 'collecting',
          reason: 'Collect 60 new independent windows before fitting another candidate.',
        },
      };
    const trained = trainOutcomeCandidate(state.events, { now, outcomeDefinition });
    if (trained.artifact) await repository.writeModelArtifact(trained.artifact);
    return {
      changed: Boolean(trained.artifact),
      trained: Boolean(trained.artifact),
      lastRun: {
        status: trained.status,
        reason: trained.reason,
        counts: trained.counts,
        modelId: trained.artifact?.id ?? null,
      },
    };
  }

  async function advanceEarlyModel(state, now, { deferFit = false } = {}) {
    const { active, candidate, shadow, training } = state.result.early;
    if (isCurrentArtifact(state.result.active))
      return { status: 'superseded', reason: 'The full learned model is active.' };
    if (candidate) {
      if (shadow.eligibleForPromotion) {
        await repository.activateModelArtifact(candidate.id, {
          activatedAt: now,
          shadowEvaluation: shadow,
        });
        return {
          status: 'activated',
          modelId: candidate.id,
          reason: 'The early candidate passed its independent future evaluation.',
        };
      }
      if (!shadow.evaluationComplete)
        return { status: 'shadow', modelId: candidate.id, reason: shadow.reasons[0] };
      const reason = shadow.reasons[0] ?? 'The early candidate did not pass its future evaluation.';
      await repository.retireModelArtifact(candidate.id, { retiredAt: now, reason });
      return { status: 'candidate-rejected', modelId: candidate.id, reason };
    }
    // A replacement is fitted only after fresh independent events following retirement or
    // activation. Previous candidates' prospective results never approve replacement weights.
    if (
      state.latestEarly &&
      training.counts.newWindows < EARLY_LEARNING_REQUIREMENTS.minimumNewWindowsForRetraining
    ) {
      return {
        status: active ? 'active' : 'collecting',
        reason: 'Collect 20 new independent events before fitting another early candidate.',
      };
    }
    if (deferFit)
      return {
        status: 'deferred',
        reason:
          'The full candidate was fitted this cycle; early fitting can run on the next cycle.',
      };
    const trained = trainEarlyCandidate(state.events, { now });
    if (trained.artifact) await repository.writeModelArtifact(trained.artifact);
    return {
      status: trained.status,
      modelId: trained.artifact?.id ?? null,
      reason: trained.reason,
      counts: trained.counts,
    };
  }

  async function runLearningCycleWithLease(now) {
    const ownerId = randomUUID();
    const hasLease = await repository.acquireLearningLease({
      ownerId,
      now,
      expiresAt: now + LEARNING_LEASE_DURATION_MS,
    });
    if (!hasLease)
      return {
        ...(await getLearningStatus({ now })),
        lastRun: { status: 'busy', reason: 'Another analysis cycle is already running.' },
      };
    try {
      let state = await readState(now);
      let earlyLastRun;
      if (state.earlyActiveForMonitoring && state.result.early.monitoring?.status === 'disabled') {
        const active = state.earlyActiveForMonitoring;
        const reason = state.result.early.monitoring.reason;
        await repository.retireModelArtifact(active.id, { retiredAt: now, reason });
        earlyLastRun = { status: 'disabled', modelId: active.id, reason };
        state = await readState(now);
      }
      // Neither early observation nor an early active model can hold up the full lane.
      const full = await advanceFullModel(state, now);
      if (full.changed) state = await readState(now);
      const early = await advanceEarlyModel(state, now, { deferFit: full.trained });
      const result = await getLearningStatus({ now });
      return {
        ...result,
        lastRun: full.lastRun,
        early: {
          ...result.early,
          lastRun: early.status === 'activated' ? early : (earlyLastRun ?? early),
        },
      };
    } finally {
      await repository.releaseLearningLease(ownerId);
    }
  }

  function runLearningCycle({ now = Date.now() } = {}) {
    if (runningCycle) return runningCycle;
    runningCycle = runLearningCycleWithLease(now).finally(() => {
      runningCycle = null;
    });
    return runningCycle;
  }
  return { getResearchModels, getLearningStatus, runLearningCycle };
}

const service = createLearningService(researchRepository);
export const getLearningStatus = service.getLearningStatus;
export const runLearningCycle = service.runLearningCycle;
export const getResearchModels = service.getResearchModels;
