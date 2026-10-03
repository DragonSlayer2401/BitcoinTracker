import 'server-only';
import { randomUUID } from 'node:crypto';
import * as researchRepository from './research.repository';
import {
  CHALLENGER_KINDS,
  CHALLENGER_MODEL_VERSION,
  CHALLENGER_REQUIREMENTS,
  DIRECTIONAL_REVERSAL_KIND,
  isChallengerArtifact,
  matchesChallengerPipeline,
} from '@/features/BitcoinTracker/utils/learning/challengerModel.utils';
import {
  evaluateChallengerActiveModel,
  evaluateChallengerCandidate,
  getChallengerConfirmationCohort,
  getChallengerTrainingRows,
  getChallengerTrainingReadiness,
  trainChallengerCandidate,
} from '@/features/BitcoinTracker/utils/learning/challengerTraining.utils';
import { groupOverlappingWindows } from '@/features/BitcoinTracker/utils/learning/evaluation.utils';

import { CHALLENGER_ENROLLMENT_POLICY } from './challengerDevelopment.repository';
import {
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
} from '@/features/BitcoinTracker/utils/collectorHealth.utils';

const LEASE_DURATION_MS = 120_000;

/** A separate frozen challenger lane shares the existing durable model and lease stores. */
export function createChallengerService(repository) {
  let runningCycle;

  async function readState(
    { now = Date.now(), events, artifacts, storedActive, labels } = {},
    detailed = true,
  ) {
    const [evidence, models, activeArtifact, forwardLabels, trials, developments] =
      await Promise.all([
        events ?? repository.getLearningEvidenceRows(),
        artifacts ?? repository.readModelArtifacts(),
        storedActive !== undefined ? storedActive : repository.getActiveModelArtifact(),
        labels ?? (detailed ? (repository.getForwardResearchLabels?.() ?? []) : []),
        repository.readChallengerTrials?.() ?? [],
        repository.readChallengerDevelopments?.() ?? [],
      ]);
    const selected = getChallengerTrainingRows(evidence, [], 'reversal', now);
    const pipeline = selected.pipeline;
    const current = models.filter(
      (model) =>
        isChallengerArtifact(model) &&
        model.trainedAt <= now &&
        pipeline &&
        matchesChallengerPipeline(model, { ...pipeline, schemaVersion: pipeline.featureVersion }),
    );
    const monitoring = isChallengerArtifact(activeArtifact)
      ? evaluateChallengerActiveModel(activeArtifact, evidence, { now })
      : null;
    const storedChallenger = current.find(
      (model) => model.id === activeArtifact?.id && !model.retirement,
    )
      ? activeArtifact
      : null;
    const active = storedChallenger && monitoring?.status !== 'disabled' ? storedChallenger : null;
    const candidates = [];
    const reports = [];
    for (const kind of CHALLENGER_KINDS) {
      const latest =
        current
          .filter((model) => model.kind === kind && model.version === CHALLENGER_MODEL_VERSION)
          .sort(
            (left, right) => left.trainedAt - right.trainedAt || left.id.localeCompare(right.id),
          )
          .at(-1) ?? null;
      const trial = trials.find((entry) => entry.modelId === latest?.id) ?? null;
      const development = developments.find((entry) => entry.modelId === latest?.id) ?? null;
      const infrastructureRecovery =
        latest?.retirement &&
        (development?.evaluation?.failureCategory === 'evidence' ||
          latest.retirement.reason?.startsWith('[unusable-evidence]'));
      const candidate =
        latest &&
        !latest.retirement &&
        latest.id !== activeArtifact?.id &&
        (!trial || ['collecting', 'passed'].includes(trial.status)) &&
        trial?.activatedAt == null &&
        latest.evaluation?.eligibleForShadow === true
          ? latest
          : null;
      if (candidate) candidates.push(candidate);
      if (!detailed) continue;
      const training = ['forward-pressure', DIRECTIONAL_REVERSAL_KIND].includes(kind)
        ? getChallengerTrainingRows(evidence, forwardLabels, kind, now)
        : selected;
      const retrainingCutoff =
        latest?.retirement?.retiredAt ??
        (latest && active && latest.id === active.id ? active.activation.activatedAt : null) ??
        latest?.trainedAt ??
        0;
      const readiness = getChallengerTrainingReadiness(evidence, forwardLabels, { kind, now });
      const counts = {
        ...readiness.counts,
        newWindows: groupOverlappingWindows(
          training.rows.filter((row) => row.windowStartAt > retrainingCutoff),
        ).length,
      };
      const requiresReadiness = candidate?.enrollmentPolicy === CHALLENGER_ENROLLMENT_POLICY;
      const awaitingCollector = requiresReadiness && !development;
      const awaitingBoundary = development?.startedAt > now;
      const evaluation =
        candidate && !awaitingCollector && !awaitingBoundary
          ? (trial?.evaluation ??
            (!trial ? development?.evaluation : null) ??
            evaluateChallengerCandidate(
              candidate,
              evidence,
              trial
                ? {
                    now,
                    phase: 'confirmation',
                    startedAt: trial.startedAt,
                    cohortForecastIds: trial.cohortForecastIds,
                    approvedCheckpoints: trial.approvedCheckpoints,
                    attemptNumber: trial.attemptNumber,
                    productionModelId: trial.productionModelId,
                  }
                : {
                    now,
                    phase: 'development',
                    ...(development
                      ? {
                          startedAt: development.startedAt,
                          cohortForecastIds: development.cohortForecastIds,
                          inclusiveBoundary: development.inclusiveBoundary,
                        }
                      : {}),
                  },
            ))
          : null;
      const sameActive = storedChallenger?.kind === kind;
      let status;
      let reason;
      if (
        sameActive &&
        !candidate &&
        counts.newWindows < CHALLENGER_REQUIREMENTS.minimumNewWindowsForRetraining
      ) {
        status = active ? 'active' : 'disabled';
        reason = monitoring.reason;
      } else if (candidate && (awaitingCollector || awaitingBoundary)) {
        status = awaitingCollector ? 'awaiting-collector' : 'awaiting-start';
        reason = awaitingCollector
          ? 'Waiting for the current collector to persist a matching prediction before scheduling development.'
          : 'Collector readiness is verified. Development begins at the saved future contract boundary.';
      } else if (candidate) {
        status =
          evaluation.evaluationComplete &&
          !evaluation.eligibleForPromotion &&
          !evaluation.developmentPassed
            ? evaluation.failureCategory === 'evidence'
              ? 'unusable-evidence'
              : 'candidate-rejected'
            : trial
              ? 'confirmation'
              : 'shadow';
        reason =
          evaluation.reasons[0] ??
          (trial
            ? 'Fresh confirmation is comparing this candidate with current production.'
            : 'Development checks passed; a new confirmation period is required.');
      } else if (
        latest &&
        !infrastructureRecovery &&
        counts.newWindows < CHALLENGER_REQUIREMENTS.minimumNewWindowsForRetraining
      ) {
        status = 'collecting';
        reason =
          'Collect 20 new independent events after the prior candidate before fitting a replacement.';
      } else {
        const ready = readiness.ready;
        status = ready ? 'ready-to-train' : 'insufficient-data';
        reason = ready
          ? 'Enough independent native BRTI events are available to freeze a prospective candidate.'
          : readiness.reason;
      }
      reports.push({
        kind,
        id: latest?.id ?? null,
        status,
        reason,
        counts,
        evaluation,
        trial,
        calibration: latest?.calibration ?? null,
        development,
        readiness: {
          required: requiresReadiness,
          status: awaitingCollector
            ? 'waiting'
            : awaitingBoundary
              ? 'scheduled'
              : development?.readiness
                ? 'ready'
                : 'legacy',
          ...(development?.readiness ?? {}),
          startsAt: development?.startedAt ?? null,
        },
        infrastructureRecovery: Boolean(infrastructureRecovery),
        monitoring: sameActive ? monitoring : null,
      });
    }
    return {
      evidence,
      forwardLabels,
      storedChallenger,
      productionActive: activeArtifact,
      trials,
      developments,
      monitoring,
      result: {
        generatedAt: now,
        candidates,
        active,
        reports,
        confirmation:
          trials.find(
            (trial) =>
              trial.status === 'collecting' ||
              (trial.status === 'passed' &&
                trial.activatedAt == null &&
                candidates.some((candidate) => candidate.id === trial.modelId)),
          ) ?? null,
        requirements: CHALLENGER_REQUIREMENTS,
      },
    };
  }

  async function getChallengerModels(options = {}) {
    const { result } = await readState(options, false);
    return { candidates: result.candidates, active: result.active };
  }

  async function getChallengerStatus(options = {}) {
    return (await readState(options)).result;
  }

  async function enrollChallengerCandidates({
    now = Date.now(),
    collectorId,
    codeVersion,
    researchVersion,
    candidateIds = [],
    proofEventIds = [],
  } = {}) {
    if (
      codeVersion !== CURRENT_COLLECTOR_CODE_VERSION ||
      researchVersion !== CURRENT_COLLECTOR_RESEARCH_VERSION ||
      !Array.isArray(candidateIds) ||
      !Array.isArray(proofEventIds) ||
      !proofEventIds.length ||
      !repository.createChallengerDevelopment
    )
      return {
        enrolled: [],
        skipped: candidateIds,
        reasons: ['Current collector version and persisted decision proof are required.'],
      };
    const [artifacts, developments] = await Promise.all([
      repository.readModelArtifacts(),
      repository.readChallengerDevelopments?.() ?? [],
    ]);
    const enrolled = [],
      reasons = [];
    for (const id of [...new Set(candidateIds)]) {
      const candidate = artifacts.find(
        (artifact) =>
          artifact.id === id &&
          !artifact.retirement &&
          artifact.enrollmentPolicy === CHALLENGER_ENROLLMENT_POLICY,
      );
      if (!candidate || developments.some((entry) => entry.modelId === id)) continue;
      for (const proofEventId of proofEventIds) {
        try {
          const development = await repository.createChallengerDevelopment({
            modelId: id,
            now,
            readiness: { collectorId, codeVersion, researchVersion, proofEventId },
          });
          enrolled.push({ modelId: id, startsAt: development.startedAt });
          break;
        } catch (error) {
          reasons.push({ modelId: id, reason: error.message });
        }
      }
    }
    return { enrolled, reasons };
  }

  async function persistDevelopmentCohorts(state, now) {
    if (!repository.createChallengerDevelopment || !repository.updateChallengerDevelopment) return;
    for (const candidate of state.result.candidates) {
      if (state.trials.some((entry) => entry.modelId === candidate.id)) continue;
      let development = state.developments.find((entry) => entry.modelId === candidate.id);
      if (!development && candidate.enrollmentPolicy === CHALLENGER_ENROLLMENT_POLICY) continue;
      if (!development)
        development = await repository.createChallengerDevelopment({ modelId: candidate.id, now });
      if (development.status !== 'collecting' || development.startedAt > now) continue;
      const options = {
        now,
        startedAt: development.startedAt,
        cohortForecastIds: development.cohortForecastIds,
        inclusiveBoundary: development.inclusiveBoundary,
      };
      const cohort = getChallengerConfirmationCohort(candidate, state.evidence, options);
      if (!cohort.valid) {
        const evaluation = {
          modelId: candidate.id,
          phase: 'development',
          startedAt: development.startedAt,
          evaluatedAt: now,
          evaluationComplete: true,
          developmentPassed: false,
          eligibleForPromotion: false,
          failureCategory: 'evidence',
          failureCode: 'missing-cohort-members',
          cohortForecastIds: development.cohortForecastIds,
          status: 'unusable-evidence',
          reasons: [cohort.reason],
          checkpoints: [],
        };
        await repository.updateChallengerDevelopment(candidate.id, {
          now,
          cohortForecastIds: development.cohortForecastIds,
          status: 'unusable-evidence',
          evaluation,
        });
        continue;
      }
      await repository.updateChallengerDevelopment(candidate.id, {
        now,
        cohortForecastIds: cohort.cohortForecastIds,
      });
      const evaluation = evaluateChallengerCandidate(candidate, state.evidence, {
        ...options,
        phase: 'development',
        cohortForecastIds: cohort.cohortForecastIds,
      });
      if (evaluation.evaluationComplete)
        await repository.updateChallengerDevelopment(candidate.id, {
          now,
          cohortForecastIds: cohort.cohortForecastIds,
          status: evaluation.developmentPassed
            ? 'passed'
            : evaluation.failureCategory === 'evidence'
              ? 'unusable-evidence'
              : 'failed',
          evaluation,
        });
    }
  }

  async function fitCandidate(kind, state, now) {
    const trained = trainChallengerCandidate(state.evidence, state.forwardLabels, { kind, now });
    if (trained.artifact)
      await repository.writeModelArtifact({
        ...trained.artifact,
        enrollmentPolicy: CHALLENGER_ENROLLMENT_POLICY,
      });
    return {
      kind,
      status: trained.status,
      modelId: trained.artifact?.id ?? null,
      reason: trained.reason,
    };
  }

  async function advanceCycle(now) {
    let state = await readState({ now });
    const lastRun = [];
    if (state.storedChallenger && state.monitoring?.status === 'disabled') {
      const id = state.storedChallenger.id;
      await repository.retireModelArtifact(id, { retiredAt: now, reason: state.monitoring.reason });
      lastRun.push({
        kind: state.storedChallenger.kind,
        status: 'disabled',
        modelId: id,
        reason: state.monitoring.reason,
      });
      state = await readState({ now });
    }
    await persistDevelopmentCohorts(state, now);
    state = await readState({ now });
    // Only one nominated candidate sees a final confirmation period at a time.
    // Persist contract membership before looking at scores. A restart resumes this trial.
    const trial =
      state.trials.find((entry) => entry.status === 'collecting') ??
      state.trials.find(
        (entry) =>
          entry.status === 'passed' &&
          state.result.candidates.some((candidate) => candidate.id === entry.modelId),
      );
    if (trial) {
      const candidate = state.result.candidates.find((model) => model.id === trial.modelId);
      const unchangedProduction =
        (state.productionActive?.id ?? null) === trial.productionModelId &&
        (state.productionActive?.activation?.activatedAt ?? null) === trial.productionActivatedAt;
      let reason = !candidate
        ? 'The nominated candidate is no longer eligible.'
        : !unchangedProduction
          ? 'Production changed during confirmation; this trial cannot be reused.'
          : null;
      let evaluation = trial.evaluation;
      if (!reason && trial.status === 'collecting') {
        const cohort = getChallengerConfirmationCohort(candidate, state.evidence, {
          startedAt: trial.startedAt,
          cohortForecastIds: trial.cohortForecastIds,
          now,
        });
        if (!cohort.valid) {
          reason = cohort.reason;
          evaluation = {
            modelId: candidate.id,
            phase: 'confirmation',
            startedAt: trial.startedAt,
            evaluatedAt: now,
            attemptNumber: trial.attemptNumber,
            evaluationComplete: true,
            eligibleForPromotion: false,
            developmentPassed: false,
            failureCategory: 'evidence',
            failureCode: 'missing-cohort-members',
            cohortForecastIds: trial.cohortForecastIds,
            status: 'unusable-evidence',
            reasons: [reason],
            approvedCheckpoints: [],
            checkpoints: [],
          };
          await repository.updateChallengerTrial(trial.modelId, {
            now,
            cohortForecastIds: trial.cohortForecastIds,
            status: 'abandoned',
            evaluation,
          });
        } else {
          await repository.updateChallengerTrial(trial.modelId, {
            now,
            cohortForecastIds: cohort.cohortForecastIds,
          });
          evaluation = evaluateChallengerCandidate(candidate, state.evidence, {
            now,
            phase: 'confirmation',
            startedAt: trial.startedAt,
            cohortForecastIds: cohort.cohortForecastIds,
            approvedCheckpoints: trial.approvedCheckpoints,
            attemptNumber: trial.attemptNumber,
            productionModelId: trial.productionModelId,
          });
          if (evaluation.evaluationComplete) {
            await repository.updateChallengerTrial(trial.modelId, {
              now,
              cohortForecastIds: cohort.cohortForecastIds,
              status: evaluation.eligibleForPromotion ? 'passed' : 'failed',
              evaluation,
            });
            if (!evaluation.eligibleForPromotion)
              reason = evaluation.reasons[0] ?? 'Confirmation did not pass.';
          }
        }
      }
      if (reason) {
        // A completed trial remains immutable, including when activation is interrupted.
        if (trial.status === 'collecting' && !evaluation?.evaluationComplete)
          await repository.updateChallengerTrial(trial.modelId, {
            now,
            cohortForecastIds: trial.cohortForecastIds,
            status: 'abandoned',
          });
        if (candidate)
          await repository.retireModelArtifact(candidate.id, {
            retiredAt: now,
            reason:
              evaluation?.failureCategory === 'evidence' ? '[unusable-evidence] ' + reason : reason,
          });
        lastRun.push({
          status:
            evaluation?.failureCategory === 'evidence' ? 'unusable-evidence' : 'candidate-rejected',
          modelId: trial.modelId,
          reason,
        });
      } else if (evaluation?.eligibleForPromotion) {
        await repository.activateModelArtifact(candidate.id, {
          activatedAt: now,
          shadowEvaluation: evaluation,
        });
        lastRun.push({
          status: 'activated',
          kind: candidate.kind,
          modelId: candidate.id,
          reason:
            'Fresh confirmation passed against baseline and the frozen production model at the approved checkpoints.',
        });
      } else
        lastRun.push({
          status: 'confirmation',
          modelId: trial.modelId,
          reason:
            'Collecting the nominated future cohort; fitting is paused until this trial ends.',
        });
      return { ...(await getChallengerStatus({ now })), lastRun };
    }

    // Nomination uses development only. Confirmation starts now, after that choice is saved.
    const winner = state.result.reports.find((report) => report.evaluation?.developmentPassed);
    if (winner && repository.createChallengerTrial) {
      await repository.createChallengerTrial({
        modelId: winner.id,
        startedAt: now,
        developmentCutoffAt: winner.evaluation.evaluatedAt,
        productionModelId: state.productionActive?.id ?? null,
        productionActivatedAt: state.productionActive?.activation?.activatedAt ?? null,
        approvedCheckpoints: winner.evaluation.approvedCheckpoints,
      });
      return {
        ...(await getChallengerStatus({ now })),
        lastRun: [
          ...lastRun,
          {
            status: 'confirmation',
            modelId: winner.id,
            reason:
              'Candidate nominated; final validation uses only events starting after this moment.',
          },
        ],
      };
    }
    for (const report of state.result.reports) {
      if (report.evaluation?.evaluationComplete && !report.evaluation.developmentPassed) {
        const unusable = report.evaluation.failureCategory === 'evidence';
        await repository.retireModelArtifact(report.id, {
          retiredAt: now,
          reason: unusable ? '[unusable-evidence] ' + report.reason : report.reason,
        });
        lastRun.push({
          kind: report.kind,
          status: unusable ? 'unusable-evidence' : 'candidate-rejected',
          modelId: report.id,
          reason: report.reason,
        });
        if (
          unusable &&
          getChallengerTrainingReadiness(state.evidence, state.forwardLabels, {
            kind: report.kind,
            now,
          }).ready
        )
          lastRun.push(await fitCandidate(report.kind, state, now));
        continue;
      }
      if (report.status !== 'ready-to-train') continue;
      lastRun.push(await fitCandidate(report.kind, state, now));
    }
    return { ...(await getChallengerStatus({ now })), lastRun };
  }

  async function runWithLease({ now = Date.now(), leaseHeld = false } = {}) {
    const ownerId = randomUUID();
    if (
      !leaseHeld &&
      !(await repository.acquireLearningLease({ ownerId, now, expiresAt: now + LEASE_DURATION_MS }))
    )
      return {
        ...(await getChallengerStatus({ now })),
        lastRun: [{ status: 'busy', reason: 'Another analysis cycle is already running.' }],
      };
    try {
      return await advanceCycle(now);
    } finally {
      if (!leaseHeld) await repository.releaseLearningLease(ownerId);
    }
  }

  function runChallengerCycle(options = {}) {
    if (runningCycle) return runningCycle;
    runningCycle = runWithLease(options).finally(() => {
      runningCycle = null;
    });
    return runningCycle;
  }
  return {
    getChallengerModels,
    getChallengerStatus,
    runChallengerCycle,
    enrollChallengerCandidates,
  };
}

const service = createChallengerService(researchRepository);
export const getChallengerModels = service.getChallengerModels;
export const getChallengerStatus = service.getChallengerStatus;
export const runChallengerCycle = service.runChallengerCycle;

export const enrollChallengerCandidates = service.enrollChallengerCandidates;
