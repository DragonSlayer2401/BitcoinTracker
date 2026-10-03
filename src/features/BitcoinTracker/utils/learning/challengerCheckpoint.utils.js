import { getBoundedProbability, logit, sigmoid } from './statistics.utils';

export const CHALLENGER_CHECKPOINTS = Object.freeze([12, 9, 6, 3, 1]);
export const CHALLENGER_CHECKPOINT_TOLERANCE_MINUTES = 5 / 60;
export const LEGACY_CHALLENGER_CALIBRATION_VERSION = 'checkpoint-logit-calibration-v1';
export const CAP_AWARE_CHALLENGER_CALIBRATION_VERSION = 'checkpoint-logit-calibration-v2';
export const CHALLENGER_CALIBRATION_VERSION = 'checkpoint-logit-calibration-v3';
export const DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION = 'checkpoint-flip-calibration-v1';
export const MINIMUM_CHALLENGER_CALIBRATION_WINDOWS = 20;
const CALIBRATION_OFFSET_PENALTY = 20;

/** A validated checkpoint covers only its recorded timing tolerance, not nearby minutes. */
export function getChallengerCheckpoint(horizonMinutes) {
  return (
    CHALLENGER_CHECKPOINTS.find(
      (minutes) =>
        Number.isFinite(horizonMinutes) &&
        Math.abs(minutes - horizonMinutes) <= CHALLENGER_CHECKPOINT_TOLERANCE_MINUTES + 1e-9,
    ) ?? null
  );
}

function getWilsonInterval(successes, total) {
  if (!total) return null;
  const z = 1.959963984540054;
  const rate = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (rate + z ** 2 / (2 * total)) / denominator;
  const radius = (z * Math.sqrt((rate * (1 - rate) + z ** 2 / (4 * total)) / total)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

/** Frequencies describe the caller's explicit outcome label; small samples retain wide intervals. */
export function getCheckpointReliability(rows) {
  return Array.from({ length: 5 }, (_, index) => {
    const lower = index / 5;
    const upper = (index + 1) / 5;
    const selected = rows.filter(
      (row) => row.probability >= lower && (row.probability < upper || upper === 1),
    );
    const positives = selected.reduce((sum, row) => sum + row.outcome, 0);
    return {
      lower,
      upper,
      samples: selected.length,
      predictedProbability: selected.length
        ? selected.reduce((sum, row) => sum + row.probability, 0) / selected.length
        : null,
      observedFrequency: selected.length ? positives / selected.length : null,
      observedFrequencyInterval: getWilsonInterval(positives, selected.length),
      confidenceLevel: 0.95,
    };
  });
}

function getCalibrationObservations(rows, maximumBaselineAdjustment) {
  return rows.map((row) => {
    const baseline = row.learningFeatures?.baselineAboveProbability;
    if (
      !Number.isFinite(row.probability) ||
      row.probability < 0 ||
      row.probability > 1 ||
      ![0, 1].includes(row.outcome) ||
      (maximumBaselineAdjustment !== null &&
        (!Number.isFinite(baseline) || baseline < 0 || baseline > 1))
    )
      throw new Error('Calibration requires valid probabilities, outcomes, and baseline bounds.');
    return {
      row,
      logOdds: logit(row.probability),
      lower: getBoundedProbability(
        Math.max(
          row.probability - 0.05,
          maximumBaselineAdjustment === null ? 0 : baseline - maximumBaselineAdjustment,
        ),
      ),
      upper: getBoundedProbability(
        Math.min(
          row.probability + 0.05,
          maximumBaselineAdjustment === null ? 1 : baseline + maximumBaselineAdjustment,
        ),
      ),
    };
  });
}

const getCalibratedObservation = (observation, offset) =>
  Math.max(observation.lower, Math.min(observation.upper, sigmoid(observation.logOdds + offset)));

/** Solve each smooth interval, including every clipping boundary, instead of fitting an
 * unclipped probability that the published correction caps would change afterward. */
function fitPublishedCalibrationOffset(observations) {
  const boundaries = [
    ...new Set([
      -1,
      0,
      1,
      ...observations.flatMap(({ lower, upper, logOdds }) =>
        [logit(lower) - logOdds, logit(upper) - logOdds].filter(
          (offset) => offset > -1 && offset < 1,
        ),
      ),
    ]),
  ].sort((left, right) => left - right);
  const loss = (offset) =>
    observations.reduce(
      (total, observation) => {
        const predicted = getCalibratedObservation(observation, offset);
        return (
          total -
          observation.row.outcome * Math.log(predicted) -
          (1 - observation.row.outcome) * Math.log1p(-predicted)
        );
      },
      (CALIBRATION_OFFSET_PENALTY * offset ** 2) / 2,
    );
  let bestOffset = 0;
  let bestLoss = loss(0);
  for (let index = 1; index < boundaries.length; index++) {
    let lower = boundaries[index - 1];
    let upper = boundaries[index];
    const middle = (lower + upper) / 2;
    const moving = observations.filter((observation) => {
      const predicted = sigmoid(observation.logOdds + middle);
      return predicted > observation.lower && predicted < observation.upper;
    });
    // Within each interval the clipped rows are constant; the remaining logistic loss
    // plus the unchanged quadratic prior is convex with a monotone derivative.
    for (let iteration = 0; iteration < 50; iteration++) {
      const offset = (lower + upper) / 2;
      const gradient = moving.reduce(
        (total, observation) =>
          total + sigmoid(observation.logOdds + offset) - observation.row.outcome,
        CALIBRATION_OFFSET_PENALTY * offset,
      );
      if (gradient > 0) upper = offset;
      else lower = offset;
    }
    for (const offset of [boundaries[index - 1], boundaries[index], (lower + upper) / 2]) {
      const candidateLoss = loss(offset);
      if (candidateLoss < bestLoss - 1e-12) {
        bestOffset = offset;
        bestLoss = candidateLoss;
      }
    }
  }
  return bestOffset;
}

/** Fit only on later held-out contracts, using the same probability caps as publication. */
export function fitCheckpointCalibration(rows, { maximumBaselineAdjustment = null } = {}) {
  if (
    maximumBaselineAdjustment !== null &&
    (!Number.isFinite(maximumBaselineAdjustment) || maximumBaselineAdjustment <= 0)
  )
    throw new Error('The baseline adjustment limit must be positive and finite.');
  return CHALLENGER_CHECKPOINTS.map((checkpointMinutes) => {
    const selected = rows.filter(
      (row) => getChallengerCheckpoint(row.horizonMinutes) === checkpointMinutes,
    );
    const enough =
      selected.length >= MINIMUM_CHALLENGER_CALIBRATION_WINDOWS &&
      [0, 1].every((outcome) => selected.filter((row) => row.outcome === outcome).length >= 5);
    const observations = getCalibrationObservations(selected, maximumBaselineAdjustment);
    const offset = enough ? fitPublishedCalibrationOffset(observations) : 0;
    return {
      checkpointMinutes,
      status: enough ? 'fitted' : 'identity',
      samples: selected.length,
      offset,
      reliability: getCheckpointReliability(
        observations.map((observation) => ({
          ...observation.row,
          // Identity publication preserves a structural policy's raw probability,
          // including valid values outside the fitted calibration's 1–99% bounds.
          probability: enough
            ? getCalibratedObservation(observation, offset)
            : observation.row.probability,
        })),
      ),
    };
  });
}

export function isCheckpointCalibration(calibration, trainedAt) {
  return Boolean(
    [
      LEGACY_CHALLENGER_CALIBRATION_VERSION,
      CAP_AWARE_CHALLENGER_CALIBRATION_VERSION,
      CHALLENGER_CALIBRATION_VERSION,
      DIRECTIONAL_CHALLENGER_CALIBRATION_VERSION,
    ].includes(calibration?.version) &&
    Number.isSafeInteger(calibration.primaryCutoffAt) &&
    calibration.primaryCutoffAt >= 0 &&
    Number.isSafeInteger(calibration.startedAt) &&
    calibration.startedAt >= calibration.primaryCutoffAt &&
    Number.isSafeInteger(calibration.cutoffAt) &&
    calibration.cutoffAt >= calibration.startedAt &&
    calibration.cutoffAt <= trainedAt &&
    Number.isSafeInteger(calibration.independentWindows) &&
    calibration.independentWindows >= MINIMUM_CHALLENGER_CALIBRATION_WINDOWS &&
    Array.isArray(calibration.checkpoints) &&
    calibration.checkpoints.length === CHALLENGER_CHECKPOINTS.length &&
    calibration.checkpoints.every(
      (entry, index) =>
        entry.checkpointMinutes === CHALLENGER_CHECKPOINTS[index] &&
        ['identity', 'fitted'].includes(entry.status) &&
        Number.isSafeInteger(entry.samples) &&
        entry.samples >= 0 &&
        entry.samples <= calibration.independentWindows &&
        Number.isFinite(entry.offset) &&
        Math.abs(entry.offset) <= 1 &&
        (entry.status === 'fitted'
          ? entry.samples >= MINIMUM_CHALLENGER_CALIBRATION_WINDOWS
          : entry.offset === 0),
    ),
  );
}

export function applyCheckpointCalibration(probability, horizonMinutes, calibration) {
  const checkpoint = getChallengerCheckpoint(horizonMinutes);
  const fit = calibration?.checkpoints?.find((entry) => entry.checkpointMinutes === checkpoint);
  if (!fit || fit.status !== 'fitted') return probability;
  const calibrated = sigmoid(logit(probability) + fit.offset);
  return getBoundedProbability(
    probability + Math.max(-0.05, Math.min(0.05, calibrated - probability)),
  );
}

/** A summable attempt budget prevents retries from resetting the evidence standard. */
export function getChallengerConfirmationAlpha(attemptNumber, checkpointCount) {
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    !Number.isSafeInteger(checkpointCount) ||
    checkpointCount < 1 ||
    checkpointCount > CHALLENGER_CHECKPOINTS.length
  )
    return null;
  return 0.05 / (attemptNumber * (attemptNumber + 1) * checkpointCount);
}
