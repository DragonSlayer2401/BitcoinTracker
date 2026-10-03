import 'server-only';
import { getResearchWriteTransaction } from './research.connection';
import { CHALLENGER_ENROLLMENT_POLICY } from './challengerDevelopment.repository';
import {
  ResearchDataError,
  getCanonicalResearchJson,
  isResearchIdentifier,
  isResearchTimestamp,
} from './research.validation';

const checkpointMinutes = [12, 9, 6, 3, 1];
const same = (left, right) => getCanonicalResearchJson(left) === getCanonicalResearchJson(right);
const validIdentity = (id) => id === null || isResearchIdentifier(id);

/** Confirmation attempts and their chosen contracts survive restarts and cannot be reset. */
export function createChallengerTrialRepository({ client, initialize, runWriteOperation }) {
  async function readChallengerTrials() {
    await initialize();
    const result = await client.execute(`SELECT payload,
      (SELECT MAX(activated_at) FROM model_activations a WHERE a.model_id = challenger_trials.model_id) AS activated_at
      FROM challenger_trials ORDER BY sequence`);
    return result.rows.map((row) => ({
      ...JSON.parse(row.payload),
      activatedAt: row.activated_at == null ? null : Number(row.activated_at),
    }));
  }

  async function createChallengerTrial(input) {
    if (
      Object.keys(input ?? {})
        .sort()
        .join(',') !==
        [
          'modelId',
          'startedAt',
          'developmentCutoffAt',
          'productionModelId',
          'productionActivatedAt',
          'approvedCheckpoints',
        ]
          .sort()
          .join(',') ||
      !isResearchIdentifier(input?.modelId) ||
      !isResearchTimestamp(input.startedAt) ||
      !isResearchTimestamp(input.developmentCutoffAt) ||
      input.developmentCutoffAt > input.startedAt ||
      !validIdentity(input.productionModelId) ||
      (input.productionModelId === null
        ? input.productionActivatedAt !== null
        : !isResearchTimestamp(input.productionActivatedAt) ||
          input.productionActivatedAt > input.startedAt) ||
      !Array.isArray(input.approvedCheckpoints) ||
      !input.approvedCheckpoints.length ||
      new Set(input.approvedCheckpoints).size !== input.approvedCheckpoints.length ||
      input.approvedCheckpoints.some((minutes) => !checkpointMinutes.includes(minutes))
    )
      throw new ResearchDataError(
        'A confirmation trial requires a frozen candidate, incumbent and approved checkpoints.',
      );
    return runWriteOperation(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const existing = await transaction.execute({
          sql: 'SELECT payload FROM challenger_trials WHERE model_id = ?',
          args: [input.modelId],
        });
        if (existing.rows.length) {
          const trial = JSON.parse(existing.rows[0].payload);
          const original = Object.fromEntries(Object.keys(input).map((key) => [key, trial[key]]));
          if (!same(original, input))
            throw new ResearchDataError(
              'A confirmation trial cannot be restarted or redefined.',
              409,
            );
          return trial;
        }
        const running = await transaction.execute(
          "SELECT model_id FROM challenger_trials WHERE status = 'collecting' LIMIT 1",
        );
        if (running.rows.length)
          throw new ResearchDataError('Another confirmation trial is already collecting.', 409);
        const model = await transaction.execute({
          sql: 'SELECT payload FROM model_artifacts WHERE model_id = ?',
          args: [input.modelId],
        });
        if (!model.rows.length || JSON.parse(model.rows[0].payload).trainedAt >= input.startedAt)
          throw new ResearchDataError(
            'Confirmation must start after the frozen model was trained.',
          );
        if (JSON.parse(model.rows[0].payload).enrollmentPolicy === CHALLENGER_ENROLLMENT_POLICY) {
          const storedDevelopment = await transaction.execute({
            sql: 'SELECT payload FROM challenger_developments WHERE model_id = ?',
            args: [input.modelId],
          });
          const development = storedDevelopment.rows.length
            ? JSON.parse(storedDevelopment.rows[0].payload)
            : null;
          if (
            !development?.readiness ||
            development.status !== 'passed' ||
            development.evaluation?.developmentPassed !== true ||
            development.evaluation.evaluatedAt > input.developmentCutoffAt ||
            input.approvedCheckpoints.some(
              (minutes) => !development.evaluation.approvedCheckpoints?.includes(minutes),
            )
          )
            throw new ResearchDataError(
              'Confirmation requires the enrolled development cohort to pass first.',
            );
        }
        const previous = await transaction.execute(
          'SELECT MAX(sequence) AS attempt, MAX(updated_at) AS cutoff FROM challenger_trials',
        );
        if (Number(previous.rows[0].cutoff ?? 0) > input.startedAt)
          throw new ResearchDataError('A new trial must follow every earlier confirmation period.');
        const attemptNumber = Number(previous.rows[0].attempt ?? 0) + 1;
        const trial = {
          version: 'challenger-confirmation-v1',
          ...input,
          attemptNumber,
          cohortForecastIds: [],
          updatedAt: input.startedAt,
          status: 'collecting',
          evaluation: null,
        };
        await transaction.execute({
          sql: 'INSERT INTO challenger_trials(sequence, model_id, started_at, updated_at, status, payload) VALUES (?, ?, ?, ?, ?, ?)',
          args: [
            attemptNumber,
            trial.modelId,
            trial.startedAt,
            trial.updatedAt,
            trial.status,
            getCanonicalResearchJson(trial),
          ],
        });
        await transaction.commit();
        return trial;
      } finally {
        transaction.close();
      }
    });
  }

  async function updateChallengerTrial(
    modelId,
    { now, cohortForecastIds, status = 'collecting', evaluation = null },
  ) {
    if (
      !isResearchIdentifier(modelId) ||
      !isResearchTimestamp(now) ||
      !['collecting', 'passed', 'failed', 'abandoned'].includes(status) ||
      !Array.isArray(cohortForecastIds) ||
      cohortForecastIds.length > 60 ||
      new Set(cohortForecastIds).size !== cohortForecastIds.length ||
      !cohortForecastIds.every(isResearchIdentifier)
    )
      throw new ResearchDataError('Invalid confirmation update.');
    return runWriteOperation(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const stored = await transaction.execute({
          sql: 'SELECT payload FROM challenger_trials WHERE model_id = ?',
          args: [modelId],
        });
        if (!stored.rows.length) throw new ResearchDataError('Confirmation trial not found.', 404);
        const original = JSON.parse(stored.rows[0].payload);
        if (
          now < original.updatedAt ||
          original.cohortForecastIds.some((id, index) => cohortForecastIds[index] !== id)
        )
          throw new ResearchDataError(
            'Confirmation membership is append-only and its clock cannot move backward.',
            409,
          );
        if (original.status !== 'collecting') {
          if (
            status !== original.status ||
            !same(cohortForecastIds, original.cohortForecastIds) ||
            !same(evaluation, original.evaluation)
          )
            throw new ResearchDataError('A completed confirmation trial is immutable.', 409);
          return original;
        }
        if (
          status === 'passed' &&
          (cohortForecastIds.length !== 60 ||
            evaluation?.modelId !== modelId ||
            evaluation.phase !== 'confirmation' ||
            evaluation.eligibleForPromotion !== true ||
            evaluation.evaluationComplete !== true ||
            evaluation.evaluatedAt !== now ||
            evaluation.startedAt !== original.startedAt ||
            evaluation.attemptNumber !== original.attemptNumber ||
            !Array.isArray(evaluation.approvedCheckpoints) ||
            !evaluation.approvedCheckpoints.length ||
            new Set(evaluation.approvedCheckpoints).size !==
              evaluation.approvedCheckpoints.length ||
            evaluation.approvedCheckpoints.some(
              (minutes) => !original.approvedCheckpoints.includes(minutes),
            ) ||
            !same(evaluation.cohortForecastIds, cohortForecastIds))
        )
          throw new ResearchDataError(
            'Passing confirmation requires the complete recorded prospective cohort.',
          );
        const trial = { ...original, cohortForecastIds, status, updatedAt: now, evaluation };
        await transaction.execute({
          sql: 'UPDATE challenger_trials SET updated_at = ?, status = ?, payload = ? WHERE model_id = ?',
          args: [now, status, getCanonicalResearchJson(trial), modelId],
        });
        await transaction.commit();
        return trial;
      } finally {
        transaction.close();
      }
    });
  }
  return { readChallengerTrials, createChallengerTrial, updateChallengerTrial };
}
