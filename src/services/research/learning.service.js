import 'server-only';
import { randomUUID } from 'node:crypto';
import * as researchRepository from './research.repository';
import {
  analyzeForecastEvidence,
  analyzeSavedForecasts,
  getVerifiedLearningRows,
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

const MINIMUM_NEW_WINDOWS_FOR_RETRAINING = 60;

export function createLearningService(repository) {
  const outcomeDefinition = KALSHI_OUTCOME_DEFINITION;
  let running;
  const isCurrentArtifact = (model) =>
    isOutcomeModelArtifact(model) && model.outcomeDefinition === outcomeDefinition;

  async function getResearchModels() {
    const [artifacts, storedActive] = await Promise.all([
      repository.readModelArtifacts(),
      repository.getActiveModelArtifact(),
    ]);
    const active = isCurrentArtifact(storedActive) ? storedActive : null;
    const latest = artifacts
      .filter(isCurrentArtifact)
      .sort((left, right) => left.trainedAt - right.trainedAt)
      .at(-1);
    const candidate =
      latest?.evaluation?.eligibleForShadow &&
      latest.id !== active?.id &&
      (!active || latest.trainedAt > active.trainedAt)
        ? latest
        : null;
    return { active, candidate };
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
    const matchesCurrentPipeline = (model) =>
      isCurrentArtifact(model) && (!pipeline || matchesOutcomeModelPipeline(model, pipeline));
    const active = matchesCurrentPipeline(storedActive) ? storedActive : null;
    const models = artifacts
      .filter(isCurrentArtifact)
      .sort((left, right) => left.trainedAt - right.trainedAt);
    const latest = models.filter(matchesCurrentPipeline).at(-1) ?? null;
    const candidate =
      latest?.evaluation?.eligibleForShadow &&
      latest.id !== active?.id &&
      (!active || latest.trainedAt > active.trainedAt)
        ? latest
        : null;
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
    const enough =
      counts.training >= LEARNING_REQUIREMENTS.minimumTrainingWindows &&
      counts.calibration >= LEARNING_REQUIREMENTS.minimumCalibrationWindows &&
      counts.test >= LEARNING_REQUIREMENTS.minimumTestWindows;
    const training = candidate
      ? {
          status: 'shadow',
          reason:
            shadow.reasons[0] ??
            'The candidate passed prospective checks and awaits the next analysis cycle.',
          counts,
        }
      : latest && !latest.evaluation.eligibleForShadow
        ? { status: 'candidate-rejected', reason: latest.evaluation.reasons[0], counts }
        : {
            status: enough ? 'ready-to-train' : 'insufficient-data',
            reason: enough
              ? 'Enough independent windows are available to attempt training; all chronological and class-balance checks still apply.'
              : 'Collect 120 training, 60 calibration, and 60 later test windows using the same baseline version and price-data sources after overlap grouping and boundary purging.',
            counts,
          };
    return {
      events,
      latest,
      learningRows,
      result: {
        generatedAt: now,
        analysis,
        active,
        candidate,
        shadow,
        requirements: LEARNING_REQUIREMENTS,
        training,
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

  async function runCycle(now) {
    const ownerId = randomUUID();
    const lease = await repository.acquireLearningLease({ ownerId, now, expiresAt: now + 120_000 });
    if (!lease)
      return {
        ...(await getLearningStatus({ now })),
        lastRun: { status: 'busy', reason: 'Another analysis cycle is already running.' },
      };
    try {
      const state = await readState(now);
      const { candidate, shadow } = state.result;
      if (candidate && shadow.eligibleForPromotion) {
        await repository.activateModelArtifact(candidate.id, {
          activatedAt: now,
          shadowEvaluation: shadow,
        });
        return {
          ...(await getLearningStatus({ now })),
          lastRun: {
            status: 'activated',
            modelId: candidate.id,
            reason:
              'The candidate passed the predeclared checks on independent future background windows.',
          },
        };
      }
      if (candidate && !shadow.evaluationComplete) {
        return { ...state.result, lastRun: { status: 'shadow', reason: shadow.reasons[0] } };
      }
      const newGroups = state.latest
        ? groupOverlappingWindows(
            state.learningRows.filter((row) => row.windowStartAt > state.latest.trainedAt),
          ).length
        : Infinity;
      if (state.latest && newGroups < MINIMUM_NEW_WINDOWS_FOR_RETRAINING)
        return {
          ...state.result,
          lastRun: {
            status: 'collecting',
            reason: 'Collect 60 new independent windows before fitting another candidate.',
          },
        };
      const trained = trainOutcomeCandidate(state.events, { now, outcomeDefinition });
      if (trained.artifact) await repository.writeModelArtifact(trained.artifact);
      return {
        ...(await getLearningStatus({ now })),
        lastRun: {
          status: trained.status,
          reason: trained.reason,
          counts: trained.counts,
          modelId: trained.artifact?.id ?? null,
        },
      };
    } finally {
      await repository.releaseLearningLease(ownerId);
    }
  }

  function runLearningCycle({ now = Date.now() } = {}) {
    if (running) return running;
    running = runCycle(now).finally(() => {
      running = null;
    });
    return running;
  }
  return { getResearchModels, getLearningStatus, runLearningCycle };
}

const service = createLearningService(researchRepository);
export const getLearningStatus = service.getLearningStatus;
export const runLearningCycle = service.runLearningCycle;
export const getResearchModels = service.getResearchModels;
