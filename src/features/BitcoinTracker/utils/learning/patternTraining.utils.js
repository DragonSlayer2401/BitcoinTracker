import { KALSHI_OUTCOME_DEFINITION } from '../kalshi/contract.utils';
import { getVerifiedLearningRows, scoreLearningRows } from './evaluation.utils';
import { getPatternContractConflicts } from './patternEvidence.utils';
import { CALIBRATION_VERSION } from './model.utils';
import {
  PATTERN_DETECTOR_VERSION,
  PATTERN_FEATURE_VERSION,
  getConflictingPatternForecastIds,
  getPatternAvailabilitySignature,
  getPatternModelIndexes,
  getPatternModelValues,
  isPatternLearningFeatureSnapshot,
} from './patternFeatures.utils';
import {
  PATTERN_CANDIDATE_KINDS,
  PATTERN_MODEL_VERSION,
  isPatternModelArtifact,
  isWithinPatternModelDomain,
} from './patternModel.utils';
import { fitLogistic, logit, predictLogistic } from './statistics.utils';
import {
  LEARNING_REQUIREMENTS,
  getDatasetFingerprint,
  getModelApplicability,
  getPairedBootstrapUncertainty,
  selectLearningPipelineRows,
  splitLearningWindows,
} from './training.utils';

const hasBothClasses = (rows) =>
  [0, 1].every(
    (outcome) =>
      rows.filter((row) => row.outcome === outcome).length >=
      LEARNING_REQUIREMENTS.minimumClassExamples,
  );

/** Only snapshots stored with the original decision qualify; historical rows are never enriched. */
export function getPatternTrainingRows(events, { now = Date.now() } = {}) {
  const contractConflicts = getPatternContractConflicts(events, now);
  const verified = getVerifiedLearningRows(
    events.filter((event) => !contractConflicts.contractTickers.has(event?.kalshiMarket?.ticker)),
    now,
  );
  const conflicts = getConflictingPatternForecastIds(events, now);
  const captured = verified.rows
    .filter(
      (row) =>
        row.features &&
        !conflicts.has(row.id) &&
        row.decision.patternLearningFeatures?.schemaVersion === PATTERN_FEATURE_VERSION &&
        row.decision.patternLearningFeatures?.patternVersion === PATTERN_DETECTOR_VERSION &&
        isPatternLearningFeatureSnapshot(row.decision.patternLearningFeatures, {
          target: row.target,
          expiresAt: row.expiresAt,
          cutoffAt: row.capturedAt,
          baselineFeatures: row.learningFeatures,
        }),
    )
    .map((row) => ({
      ...row,
      patternLearningFeatures: row.decision.patternLearningFeatures,
      features: getPatternModelValues(row.decision.patternLearningFeatures),
    }));
  const selected = selectLearningPipelineRows(captured);
  return {
    ...selected,
    evidenceCounts: verified.counts,
    capturedSnapshots: captured.length,
    missingSnapshots: verified.rows.length - captured.length,
    conflictingSnapshots: conflicts.size,
    rejectedContracts: contractConflicts.rejectedContracts,
    rejectedCaptures: contractConflicts.rejectedCaptures,
    rejectedContractReasons: contractConflicts.reasons,
  };
}

function getRetrospectiveProbability(model, row) {
  return isWithinPatternModelDomain(model, row.patternLearningFeatures)
    ? predictLogistic(model.calibration.model, [logit(predictLogistic(model.model, row.features))])
    : row.learningFeatures.baselineAboveProbability;
}

/** Seven fixed regularized fits share identical independent-contract partitions and input rows. */
export function trainPatternCandidates(events, { now = Date.now() } = {}) {
  const {
    rows,
    pipeline,
    evidenceCounts,
    capturedSnapshots,
    missingSnapshots,
    conflictingSnapshots,
    rejectedContracts,
    rejectedCaptures,
    rejectedContractReasons,
  } = getPatternTrainingRows(events, { now });
  const split = splitLearningWindows(rows);
  const counts = {
    training: split.train.length,
    calibration: split.calibration.length,
    test: split.test.length,
    independentWindows: split.groupCount,
    purgedGroups: split.purgedGroups,
    capturedSnapshots,
    missingSnapshots,
    conflictingSnapshots,
    rejectedContracts,
    rejectedCaptures,
    rejectedContractReasons,
    pipeline,
  };
  const unavailable = (status, reason) => ({
    status,
    artifacts: [],
    counts,
    evidenceCounts,
    reason,
  });
  if (
    split.train.length < LEARNING_REQUIREMENTS.minimumTrainingWindows ||
    split.calibration.length < LEARNING_REQUIREMENTS.minimumCalibrationWindows ||
    split.test.length < LEARNING_REQUIREMENTS.minimumTestWindows ||
    ![split.train, split.calibration, split.test].every(hasBothClasses)
  )
    return unavailable(
      'insufficient-data',
      'Collect 120 training, 60 calibration and 60 later independent contracts with frozen pattern snapshots and both official outcomes. Historical records are not backfilled.',
    );
  const baselineFeatureVersion = rows[0].learningFeatures.schemaVersion;
  const baselineLength = rows[0].learningFeatures.values.length;
  const applicability = getModelApplicability(
    split.trainingCheckpoints,
    pipeline,
    KALSHI_OUTCOME_DEFINITION,
  );
  const patternAvailabilityPatterns = [
    ...new Set(
      split.trainingCheckpoints.map((row) =>
        getPatternAvailabilitySignature(row.patternLearningFeatures),
      ),
    ),
  ];
  const modelDomain = {
    featureVersion: PATTERN_FEATURE_VERSION,
    patternVersion: PATTERN_DETECTOR_VERSION,
    applicability,
    baselineFeatureVersion,
    patternAvailabilityPatterns,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
  const calibrationWindows = split.calibration.filter((row) =>
    isWithinPatternModelDomain(modelDomain, row.patternLearningFeatures),
  );
  if (
    calibrationWindows.length < LEARNING_REQUIREMENTS.minimumCalibrationWindows ||
    !hasBothClasses(calibrationWindows)
  )
    return unavailable(
      'insufficient-data',
      'More independent calibration contracts with supported baseline and pattern availability states are required.',
    );
  const fingerprint = getDatasetFingerprint(rows);
  const suiteId = `${now}-${fingerprint}`;
  try {
    const artifacts = PATTERN_CANDIDATE_KINDS.map((kind) => {
      const model = fitLogistic(
        split.trainingCheckpoints,
        getPatternModelIndexes(kind, baselineLength),
        {
          penalty: LEARNING_REQUIREMENTS.penalty,
          maximumIterations: 50,
        },
      );
      const calibrationRows = split.calibrationCheckpoints
        .filter((row) => isWithinPatternModelDomain(modelDomain, row.patternLearningFeatures))
        .map((row) => ({ ...row, features: [logit(predictLogistic(model, row.features))] }));
      const calibration = fitLogistic(calibrationRows, [0], {
        penalty: LEARNING_REQUIREMENTS.penalty,
        maximumIterations: 50,
      });
      if (calibration.coefficients[1] < 0)
        throw new Error('Calibration reversed the learned ordering.');
      return {
        id: `${PATTERN_MODEL_VERSION}-${kind}-${suiteId}`,
        suiteId,
        kind,
        version: PATTERN_MODEL_VERSION,
        status: 'shadow',
        trainedAt: now,
        shadowStartsAt: now,
        trainingCutoffAt: split.trainingCutoffAt,
        calibrationCutoffAt: split.calibrationCutoffAt,
        evaluationCutoffAt: split.evaluationCutoffAt,
        featureVersion: PATTERN_FEATURE_VERSION,
        baselineFeatureVersion,
        patternVersion: PATTERN_DETECTOR_VERSION,
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        datasetFingerprint: fingerprint,
        applicability,
        patternAvailabilityPatterns,
        model,
        calibration: { version: CALIBRATION_VERSION, model: calibration },
      };
    });
    const control = artifacts.find((artifact) => artifact.kind === 'baseline-control');
    const controlRows = split.test.map((row) => ({
      ...row,
      probability: getRetrospectiveProbability(control, row),
    }));
    for (const artifact of artifacts) {
      const probabilities = split.test.map((row) => getRetrospectiveProbability(artifact, row));
      const modelUses = split.test.filter((row) =>
        isWithinPatternModelDomain(artifact, row.patternLearningFeatures),
      ).length;
      artifact.evaluation = {
        evidenceType: 'exploratory-chronological-holdout',
        eligibleForPromotion: false,
        counts,
        candidate: scoreLearningRows(
          split.test.map((row, index) => ({ ...row, probability: probabilities[index] })),
        ),
        current: scoreLearningRows(split.test),
        baseline: scoreLearningRows(
          split.test.map((row) => ({
            ...row,
            probability: row.learningFeatures.baselineAboveProbability,
          })),
        ),
        fittedBaselineControl: scoreLearningRows(controlRows),
        uncertaintyVersusFittedControl: getPairedBootstrapUncertainty(controlRows, probabilities),
        modelUses,
        fallbackUses: split.test.length - modelUses,
      };
      if (!isPatternModelArtifact(artifact)) throw new Error('Invalid fitted artifact.');
    }
    return {
      status: 'shadow',
      artifacts,
      counts,
      evidenceCounts,
      reason:
        'The fixed suite is ready for future contracts only. Holdout results are exploratory; no candidate is promoted automatically.',
    };
  } catch {
    return unavailable(
      'candidate-rejected',
      'The fixed suite could not be fit and calibrated safely. Existing forecasts remain unchanged.',
    );
  }
}
