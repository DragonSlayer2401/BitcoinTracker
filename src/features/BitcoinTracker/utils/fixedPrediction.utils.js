export const FIXED_PREDICTION_POLICY_VERSION = 'observed-consensus-v1';
export const MARKET_AWARE_POLICY_VERSION = 'market-aware-consensus-v2';
export const PRESSURE_POLICY_VERSION = 'pressure-snapshot-v3';
export const KALSHI_POLICY_VERSION = 'kalshi-snapshot-v4';
export const usesSnapshotPolicy = (version) =>
  [PRESSURE_POLICY_VERSION, KALSHI_POLICY_VERSION].includes(version);
export const MINIMUM_OBSERVATION_MS = 3 * 60_000;
export const MAXIMUM_OBSERVATION_MS = 5 * 60_000;
export const MINIMUM_LEAD_MS = 60_000;
export const CONFIRMATION_DURATION_MS = 60_000;
export const MAXIMUM_SAMPLE_GAP_MS = 15_000;
export const MINIMUM_CONFIRMATION_SAMPLES = 7;
export const MINIMUM_CALL_PROBABILITY = 0.65;

export function getFixedForecastAnalysis({
  startedAt,
  expiresAt,
  policyVersion = FIXED_PREDICTION_POLICY_VERSION,
}) {
  if (policyVersion === KALSHI_POLICY_VERSION) {
    const remaining = expiresAt - startedAt;
    const observation = Math.min(
      MINIMUM_OBSERVATION_MS,
      Math.max(15_000, Math.floor(remaining / 4000) * 1000),
    );
    return {
      startedAt,
      earliestAt: startedAt + observation,
      deadline: Math.max(startedAt, Math.min(startedAt + MAXIMUM_OBSERVATION_MS, expiresAt - 5000)),
      policyVersion,
    };
  }
  return {
    startedAt,
    earliestAt: startedAt + MINIMUM_OBSERVATION_MS,
    deadline: Math.max(
      startedAt,
      Math.min(startedAt + MAXIMUM_OBSERVATION_MS, expiresAt - MINIMUM_LEAD_MS),
    ),
    policyVersion,
  };
}

export function getQualifyingDirection(estimate, policyVersion = FIXED_PREDICTION_POLICY_VERSION) {
  if (!estimate?.available) return null;
  if (usesSnapshotPolicy(policyVersion)) {
    if (
      !Number.isFinite(estimate.aboveProbability) ||
      !Number.isFinite(estimate.belowProbability) ||
      estimate.aboveProbability < 0 ||
      estimate.aboveProbability > 1 ||
      estimate.belowProbability < 0 ||
      estimate.belowProbability > 1 ||
      Math.abs(estimate.aboveProbability + estimate.belowProbability - 1) > 0.000001
    )
      return null;
    return estimate.aboveProbability > 0.5
      ? 'above'
      : estimate.aboveProbability < 0.5
        ? 'below'
        : 'neutral';
  }
  if (estimate.aboveProbability >= MINIMUM_CALL_PROBABILITY) return 'above';
  if (estimate.belowProbability >= MINIMUM_CALL_PROBABILITY) return 'below';
  return null;
}

// Each observation represents a new exchange trade, not a clock tick or a re-fetched quote.
// A weak/reversed signal or a feed interruption starts a new confirmation period.
export function updateConfirmationSamples(samples, sample) {
  if (!sample.direction) return [];
  const previous = samples.at(-1);
  if (previous && sample.quoteTime <= previous.quoteTime) return samples;
  const isContinuous =
    previous &&
    sample.time > previous.time &&
    sample.time - previous.time <= MAXIMUM_SAMPLE_GAP_MS &&
    sample.quoteTime - previous.quoteTime <= MAXIMUM_SAMPLE_GAP_MS &&
    previous.direction === sample.direction;
  const next = isContinuous ? [...samples, sample] : [sample];
  // Retain one point just before the last minute to prove the full interval was observed.
  const cutoff = sample.time - CONFIRMATION_DURATION_MS;
  const firstRecent = next.findIndex((point) => point.time >= cutoff);
  return next.slice(Math.max(0, firstRecent - 1));
}

export function getFixedPredictionProgress({ analysis, samples, estimate, now }) {
  const direction = getQualifyingDirection(estimate, analysis.policyVersion);
  if (usesSnapshotPolicy(analysis.policyVersion)) {
    const observationRemainingMs = Math.max(0, analysis.earliestAt - now);
    const insufficientTime = analysis.earliestAt > analysis.deadline;
    const canPublish =
      !insufficientTime &&
      now >= analysis.earliestAt &&
      now <= analysis.deadline &&
      direction !== null;
    const mustWithhold = insufficientTime || (now >= analysis.deadline && !canPublish);
    return {
      phase: mustWithhold
        ? 'withheld'
        : canPublish
          ? 'ready'
          : observationRemainingMs > 0
            ? 'observing'
            : 'confirming',
      reason:
        direction === null
          ? 'Waiting for a valid estimate from fresh market data.'
          : observationRemainingMs > 0
            ? 'Observing the market before capturing the fixed estimate.'
            : 'The current estimate is ready to be fixed, including a weak or balanced signal.',
      withholdingReason: insufficientTime ? 'insufficient-time' : 'market-data-unavailable',
      observationRemainingMs,
      confirmationRemainingMs: 0,
      sampleCount: 0,
    };
  }
  const lastSample = samples.at(-1);
  const hasFreshRun =
    lastSample &&
    lastSample.direction === direction &&
    now >= lastSample.time &&
    now - lastSample.time <= MAXIMUM_SAMPLE_GAP_MS;
  const run = hasFreshRun ? samples : [];
  const confirmedDuration = run.length > 1 ? lastSample.time - run[0].time : 0;
  const observationRemainingMs = Math.max(0, analysis.earliestAt - now);
  const confirmationRemainingMs = Math.max(0, CONFIRMATION_DURATION_MS - confirmedDuration);
  const canPublish =
    now >= analysis.earliestAt &&
    now <= analysis.deadline &&
    direction !== null &&
    run.length >= MINIMUM_CONFIRMATION_SAMPLES &&
    confirmationRemainingMs === 0;
  const insufficientTime = analysis.earliestAt > analysis.deadline;
  const mustWithhold = insufficientTime || (now >= analysis.deadline && !canPublish);

  return {
    phase: mustWithhold
      ? 'withheld'
      : canPublish
        ? 'ready'
        : observationRemainingMs > 0
          ? 'observing'
          : 'confirming',
    reason: !estimate?.available
      ? 'Waiting for fresh, uninterrupted market data.'
      : !direction
        ? 'Direction has not reached the publication threshold.'
        : 'Checking that the direction stays consistent for a full minute.',
    withholdingReason: insufficientTime
      ? 'insufficient-time'
      : !estimate?.available
        ? 'market-data-unavailable'
        : 'no-consensus',
    observationRemainingMs,
    confirmationRemainingMs,
    sampleCount: run.length,
  };
}
