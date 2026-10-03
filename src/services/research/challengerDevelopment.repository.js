import 'server-only';
import { getResearchWriteTransaction } from './research.connection';
import {
  ResearchDataError,
  getCanonicalResearchJson,
  isResearchIdentifier,
  isResearchTimestamp,
} from './research.validation';
import {
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
  COLLECTOR_HEALTH_POLICY,
} from '@/features/BitcoinTracker/utils/collectorHealth.utils';
import {
  isChallengerArtifact,
  matchesChallengerPipeline,
} from '@/features/BitcoinTracker/utils/learning/challengerModel.utils';
import { hasContemporaneousInputs } from '@/features/BitcoinTracker/utils/learning/evaluation.utils';

export const CHALLENGER_ENROLLMENT_POLICY = 'collector-enrollment-v1';
const same = (left, right) => getCanonicalResearchJson(left) === getCanonicalResearchJson(right);
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

/** Readiness and development membership are separate from immutable fitted coefficients. */
export function createChallengerDevelopmentRepository({ client, initialize, runWriteOperation }) {
  async function readChallengerDevelopments() {
    await initialize();
    const result = await client.execute(
      'SELECT payload FROM challenger_developments ORDER BY started_at, model_id',
    );
    return result.rows.map((row) => JSON.parse(row.payload));
  }

  async function createChallengerDevelopment({ modelId, now, readiness = null }) {
    if (!isResearchIdentifier(modelId) || !isResearchTimestamp(now))
      throw new ResearchDataError('A development run requires a model and observation time.');
    return runWriteOperation(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const existing = await transaction.execute({
          sql: 'SELECT payload FROM challenger_developments WHERE model_id = ?',
          args: [modelId],
        });
        if (existing.rows.length) return JSON.parse(existing.rows[0].payload);
        const stored = await transaction.execute({
          sql: 'SELECT payload, retired_at FROM model_artifacts LEFT JOIN model_retirements USING(model_id) WHERE model_id = ?',
          args: [modelId],
        });
        const artifact = stored.rows.length ? JSON.parse(stored.rows[0].payload) : null;
        if (
          !isChallengerArtifact(artifact) ||
          stored.rows[0].retired_at != null ||
          artifact.trainedAt > now
        )
          throw new ResearchDataError(
            'An unretired frozen challenger is required for development.',
          );
        let verifiedReadiness = null;
        if (artifact.enrollmentPolicy === CHALLENGER_ENROLLMENT_POLICY) {
          if (
            !readiness ||
            readiness.codeVersion !== CURRENT_COLLECTOR_CODE_VERSION ||
            readiness.researchVersion !== CURRENT_COLLECTOR_RESEARCH_VERSION ||
            !isResearchIdentifier(readiness.collectorId) ||
            !isResearchIdentifier(readiness.proofEventId)
          )
            throw new ResearchDataError(
              'The collector must prove the current code, research version and recorded prediction.',
            );
          const heartbeatRow = await transaction.execute({
            sql: 'SELECT payload FROM collector_heartbeats WHERE collector_id = ?',
            args: [readiness.collectorId],
          });
          const heartbeat = heartbeatRow.rows.length
            ? JSON.parse(heartbeatRow.rows[0].payload)
            : null;
          if (
            !heartbeat ||
            heartbeat.status !== 'running' ||
            heartbeat.codeVersion !== readiness.codeVersion ||
            heartbeat.researchVersion !== readiness.researchVersion ||
            heartbeat.heartbeatAt > now ||
            now - heartbeat.heartbeatAt > COLLECTOR_HEALTH_POLICY.staleAfterMs
          )
            throw new ResearchDataError(
              'A fresh running heartbeat from the current collector is required.',
            );
          const evidence = await transaction.execute({
            sql: 'SELECT payload FROM evidence_events WHERE event_id = ?',
            args: [readiness.proofEventId],
          });
          const decision = evidence.rows.length ? JSON.parse(evidence.rows[0].payload) : null;
          const variant = decision?.researchExperiment?.variants?.[artifact.variantName];
          if (
            !decision ||
            decision.event !== 'decision' ||
            decision.cohort !== 'kalshi-background' ||
            !isResearchTimestamp(decision.capturedAt) ||
            decision.capturedAt > now ||
            now - decision.capturedAt > 30_000 ||
            decision.windowStartAt <= artifact.trainedAt ||
            !hasContemporaneousInputs(decision) ||
            !matchesChallengerPipeline(artifact, decision.learningFeatures) ||
            decision.learningFeatures?.referenceSource !== 'cf-brti' ||
            decision.learningFeatures?.featureInputSource !== 'cf-brti-history' ||
            decision.researchExperiment?.version !== CURRENT_COLLECTOR_RESEARCH_VERSION ||
            variant?.modelId !== modelId ||
            variant.available !== true ||
            !probability(variant.aboveProbability) ||
            variant.policyVersion !== artifact.variantPolicyVersion ||
            variant.featureCutoffAt !== decision.capturedAt ||
            (artifact.kind === 'market-blend' && variant.appliedMarket !== true)
          )
            throw new ResearchDataError(
              'A fresh persisted native-BRTI prediction with the loaded candidate ID is required.',
            );
          const snapshotRows = await transaction.execute({
            sql: 'SELECT content_hash, payload FROM research_input_snapshots WHERE snapshot_id = ?',
            args: [decision.researchReplay?.snapshotId ?? ''],
          });
          const snapshot = snapshotRows.rows.length
            ? JSON.parse(snapshotRows.rows[0].payload)
            : null;
          if (
            !snapshot ||
            snapshotRows.rows[0].content_hash !== decision.researchReplay?.contentHash ||
            snapshot.timing?.replayable !== true ||
            snapshot.capturedAt !== decision.capturedAt ||
            !snapshot.models?.challengers?.candidates?.some((candidate) => candidate.id === modelId)
          )
            throw new ResearchDataError(
              'Readiness requires the matching original replay snapshot and loaded model.',
            );
          verifiedReadiness = {
            collectorId: readiness.collectorId,
            codeVersion: readiness.codeVersion,
            researchVersion: readiness.researchVersion,
            proofEventId: readiness.proofEventId,
            proofCapturedAt: decision.capturedAt,
            readyAt: now,
          };
        } else if (readiness !== null) {
          throw new ResearchDataError('An older run keeps its original prospective boundary.');
        }
        const development = {
          version: 'challenger-development-v1',
          modelId,
          createdAt: now,
          startedAt: verifiedReadiness
            ? (Math.floor(now / 900_000) + 1) * 900_000
            : artifact.shadowStartsAt,
          inclusiveBoundary: Boolean(verifiedReadiness),
          readiness: verifiedReadiness,
          updatedAt: now,
          status: 'collecting',
          cohortForecastIds: [],
          evaluation: null,
        };
        await transaction.execute({
          sql: 'INSERT INTO challenger_developments(model_id, started_at, updated_at, status, payload) VALUES (?, ?, ?, ?, ?)',
          args: [
            modelId,
            development.startedAt,
            now,
            development.status,
            getCanonicalResearchJson(development),
          ],
        });
        await transaction.commit();
        return development;
      } finally {
        transaction.close();
      }
    });
  }

  async function updateChallengerDevelopment(
    modelId,
    { now, cohortForecastIds, status = 'collecting', evaluation = null },
  ) {
    if (
      !isResearchIdentifier(modelId) ||
      !isResearchTimestamp(now) ||
      !['collecting', 'passed', 'failed', 'unusable-evidence'].includes(status) ||
      !Array.isArray(cohortForecastIds) ||
      cohortForecastIds.length > 60 ||
      new Set(cohortForecastIds).size !== cohortForecastIds.length ||
      !cohortForecastIds.every(isResearchIdentifier)
    )
      throw new ResearchDataError('Invalid development update.');
    return runWriteOperation(async () => {
      await initialize();
      const transaction = await getResearchWriteTransaction(client);
      try {
        const stored = await transaction.execute({
          sql: 'SELECT payload FROM challenger_developments WHERE model_id = ?',
          args: [modelId],
        });
        if (!stored.rows.length) throw new ResearchDataError('Development run not found.', 404);
        const original = JSON.parse(stored.rows[0].payload);
        if (
          now < original.updatedAt ||
          original.cohortForecastIds.some((id, index) => cohortForecastIds[index] !== id)
        )
          throw new ResearchDataError(
            'Development membership is append-only and cannot move backward.',
            409,
          );
        if (original.status !== 'collecting') {
          if (
            status !== original.status ||
            !same(cohortForecastIds, original.cohortForecastIds) ||
            !same(evaluation, original.evaluation)
          )
            throw new ResearchDataError('A completed development run is immutable.', 409);
          return original;
        }
        if (
          status !== 'collecting' &&
          (evaluation?.modelId !== modelId ||
            evaluation.phase !== 'development' ||
            evaluation.evaluationComplete !== true ||
            evaluation.evaluatedAt !== now ||
            evaluation.startedAt !== original.startedAt ||
            !same(evaluation.cohortForecastIds, cohortForecastIds) ||
            (status === 'passed' && evaluation.developmentPassed !== true) ||
            (status === 'unusable-evidence' && evaluation.failureCategory !== 'evidence'))
        )
          throw new ResearchDataError(
            'Completed development requires its original cohort evaluation.',
          );
        const development = { ...original, updatedAt: now, cohortForecastIds, status, evaluation };
        await transaction.execute({
          sql: 'UPDATE challenger_developments SET updated_at = ?, status = ?, payload = ? WHERE model_id = ?',
          args: [now, status, getCanonicalResearchJson(development), modelId],
        });
        await transaction.commit();
        return development;
      } finally {
        transaction.close();
      }
    });
  }
  return { readChallengerDevelopments, createChallengerDevelopment, updateChallengerDevelopment };
}
