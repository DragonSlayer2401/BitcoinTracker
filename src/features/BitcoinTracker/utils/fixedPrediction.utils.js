export const FIXED_PREDICTION_POLICY_VERSION = 'observed-consensus-v1';
export const MINIMUM_OBSERVATION_MS = 3 * 60_000;
export const MAXIMUM_OBSERVATION_MS = 5 * 60_000;
export const MINIMUM_LEAD_MS = 60_000;
export const CONFIRMATION_DURATION_MS = 60_000;
export const MAXIMUM_SAMPLE_GAP_MS = 15_000;
export const MINIMUM_CONFIRMATION_SAMPLES = 7;
export const MINIMUM_CALL_PROBABILITY = 0.65;

export function getFixedForecastAnalysis({ startedAt, expiresAt }) {
  return {
    startedAt,
    earliestAt: startedAt + MINIMUM_OBSERVATION_MS,
    deadline: Math.max(
      startedAt,
      Math.min(startedAt + MAXIMUM_OBSERVATION_MS, expiresAt - MINIMUM_LEAD_MS),
    ),
    policyVersion: FIXED_PREDICTION_POLICY_VERSION,
  };
}

export function getQualifyingDirection(estimate) {
  if (!estimate?.available) return null;
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
  const direction = getQualifyingDirection(estimate);
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
