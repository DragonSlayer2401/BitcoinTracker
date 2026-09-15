import {
  getKalshiContract,
  isKalshiContract,
  isVerifiedKalshiOutcome,
  KALSHI_OUTCOME_DEFINITION,
} from './kalshi/contract.utils';
import { groupOverlappingWindows, scoreLearningRows } from './learning/evaluation.utils';
import { RESEARCH_EXPERIMENT_VERSION, RESEARCH_VARIANT_NAMES } from './researchExperiments.utils';
import {
  KALSHI_CHECKPOINT_POLICY_VERSION,
  isKalshiCheckpointMinutes,
} from './fixedPrediction.utils';

export { RESEARCH_EXPERIMENT_VERSION };
export const RESEARCH_VARIANTS = Object.freeze([...RESEARCH_VARIANT_NAMES, 'production']);
const CHECKPOINTS = [12, 9, 6, 3, 1];
const BLOCK_LENGTHS = [4, 8];
const BOOTSTRAP_REPLICATES = 500;
const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;
const isProbability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const increment = (counts, key) => {
  counts[key] = (counts[key] ?? 0) + 1;
};
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
const contractKey = (row) => JSON.stringify(getKalshiContract(row.kalshiMarket));

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  return value;
}

function decisionFingerprint(row) {
  return JSON.stringify(
    stableValue({
      contract: getKalshiContract(row.kalshiMarket),
      checkpointMinutes: row.checkpointMinutes ?? null,
      ...(row.policyVersion === KALSHI_CHECKPOINT_POLICY_VERSION
        ? { policyVersion: row.policyVersion, captureOrigin: row.captureOrigin ?? 'manual' }
        : {}),
      capturedAt: row.capturedAt,
      inputObservedAt: row.inputObservedAt,
      featureCutoffAt: row.featureCutoffAt,
      inputStatus: row.inputStatus,
      aboveProbability: row.aboveProbability,
      belowProbability: row.belowProbability,
      researchExperiment: row.researchExperiment ?? null,
    }),
  );
}

function hasMatchingContract(row) {
  return (
    isKalshiContract(row.kalshiMarket) &&
    row.outcomeDefinition === KALSHI_OUTCOME_DEFINITION &&
    row.target === row.kalshiMarket.target &&
    row.windowStartAt === row.kalshiMarket.startsAt &&
    row.expiresAt === row.kalshiMarket.expiresAt
  );
}

function hasMatchingOutcome(row) {
  return (
    row.outcomeStatus === 'observed' &&
    isVerifiedKalshiOutcome(row.kalshiOutcome, row.kalshiMarket, row.recordedAt) &&
    row.observedPrice === row.kalshiOutcome.observedPrice &&
    row.observedAt === row.kalshiOutcome.observedAt &&
    row.confirmedThrough === row.kalshiOutcome.confirmedThrough &&
    row.outcome === row.kalshiOutcome.outcome
  );
}

function getScope(row) {
  if ((row.cohort ?? 'manual') === 'manual') {
    if (row.policyVersion !== KALSHI_CHECKPOINT_POLICY_VERSION)
      return row.checkpointMinutes == null ? 'manual-fixed' : null;
    const captureOrigin = row.captureOrigin === undefined ? 'manual' : row.captureOrigin;
    if (
      !isKalshiCheckpointMinutes(row.checkpointMinutes) ||
      !['manual', 'automatic'].includes(captureOrigin)
    )
      return null;
    return `saved-fixed-${captureOrigin}-${row.checkpointMinutes}`;
  }
  if (row.cohort === 'kalshi-background' && CHECKPOINTS.includes(row.checkpointMinutes))
    return `checkpoint-${row.checkpointMinutes}`;
  return null;
}

/** Select captures before consulting outcomes or whether an experiment happened to be available. */
function collectDecisions(events, now) {
  const groups = new Map();
  const outcomes = new Map();
  const fingerprints = new Map();
  const conflictingForecasts = new Set();
  const contractIdentities = new Map();
  const conflictingContracts = new Set();
  const counts = {
    evidenceRows: events.length,
    decisionRows: 0,
    outcomeRows: 0,
    ignoredRows: 0,
    invalidRows: 0,
    futureRows: 0,
    unsupportedDecisions: 0,
  };
  for (const row of events) {
    if (!['decision', 'outcome'].includes(row?.event)) {
      counts.ignoredRows++;
      continue;
    }
    if (!isTimestamp(row.recordedAt) || typeof row.forecastId !== 'string') {
      counts.invalidRows++;
      continue;
    }
    if (row.recordedAt > now) {
      counts.futureRows++;
      continue;
    }
    if (!hasMatchingContract(row)) {
      counts.invalidRows++;
      continue;
    }
    const identity = contractKey(row);
    const ticker = row.kalshiMarket.ticker;
    if (contractIdentities.has(ticker) && contractIdentities.get(ticker) !== identity)
      conflictingContracts.add(ticker);
    contractIdentities.set(ticker, identity);
    if (row.event === 'outcome') {
      counts.outcomeRows++;
      const labels = outcomes.get(identity) ?? [];
      labels.push(row);
      outcomes.set(identity, labels);
      continue;
    }
    counts.decisionRows++;
    const scope = getScope(row);
    if (!scope) {
      counts.unsupportedDecisions++;
      continue;
    }
    const fingerprint = decisionFingerprint(row);
    if (fingerprints.has(row.forecastId) && fingerprints.get(row.forecastId) !== fingerprint)
      conflictingForecasts.add(row.forecastId);
    fingerprints.set(row.forecastId, fingerprint);
    const key = `${scope}:${ticker}`;
    const group = groups.get(key) ?? { key, scope, identity, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return {
    counts,
    records: [...groups.values()].map((group) => {
      const sorted = [...group.rows].sort(
        (left, right) =>
          (left.capturedAt ?? left.recordedAt) - (right.capturedAt ?? right.recordedAt) ||
          left.recordedAt - right.recordedAt ||
          left.forecastId.localeCompare(right.forecastId),
      );
      const decision = sorted[0];
      const fingerprint = decisionFingerprint(decision);
      const conflict =
        conflictingContracts.has(decision.kalshiMarket.ticker) ||
        sorted.some(
          (row) =>
            conflictingForecasts.has(row.forecastId) ||
            (row.capturedAt === decision.capturedAt && decisionFingerprint(row) !== fingerprint),
        );
      const labels = outcomes.get(group.identity) ?? [];
      const verified = labels.filter(hasMatchingOutcome);
      const contradictory = new Set(
        verified.map((row) => `${row.kalshiOutcome.result}:${row.observedPrice}`),
      );
      const outcomeStatus =
        contradictory.size > 1
          ? 'conflicting'
          : verified.length
            ? 'verified'
            : labels.some((row) => row.outcomeStatus === 'unobserved')
              ? 'unobserved'
              : labels.length
                ? 'invalid'
                : 'unresolved';
      return {
        ...group,
        rows: undefined,
        decision,
        duplicateDecisions: sorted.length - 1,
        conflict,
        windowStartAt: decision.windowStartAt,
        expiresAt: decision.expiresAt,
        outcomeStatus,
        outcome:
          outcomeStatus === 'verified' ? Number(verified[0].kalshiOutcome.result === 'yes') : null,
        settlementPrice: outcomeStatus === 'verified' ? verified[0].observedPrice : null,
      };
    }),
  };
}

function getExperimentReason(record) {
  const row = record.decision;
  if (record.conflict) return 'conflicting-decision';
  const capture = row.capturedAt;
  if (
    row.inputStatus !== 'captured' ||
    !isTimestamp(capture) ||
    capture !== row.inputObservedAt ||
    capture !== row.featureCutoffAt ||
    capture < row.windowStartAt ||
    capture > row.recordedAt ||
    row.recordedAt >= row.expiresAt
  )
    return 'non-contemporaneous-decision';
  if (record.scope !== 'manual-fixed') {
    const checkpointAt = row.expiresAt - row.checkpointMinutes * 60_000;
    if (capture < checkpointAt || capture > checkpointAt + 5000) return 'checkpoint-time-mismatch';
  }
  const experiment = row.researchExperiment;
  if (!experiment) return 'experiment-not-recorded';
  if (
    experiment.version !== RESEARCH_EXPERIMENT_VERSION ||
    experiment.capturedAt !== capture ||
    experiment.marketTicker !== row.kalshiMarket.ticker ||
    experiment.target !== row.target ||
    experiment.expiresAt !== row.expiresAt ||
    !experiment.variants ||
    typeof experiment.variants !== 'object'
  )
    return 'invalid-experiment';
  return null;
}

function getVariant(record, name, experimentReason) {
  if (experimentReason) return { available: false, reason: experimentReason, fallbacks: [] };
  const experiment = record.decision.researchExperiment;
  const variant = name === 'production' ? experiment.production : experiment.variants[name];
  if (!variant) return { available: false, reason: 'variant-not-recorded', fallbacks: [] };
  if (variant.available !== true)
    return {
      available: false,
      reason: variant.reason ?? 'variant-unavailable',
      fallbacks: Array.isArray(variant.fallbacks) ? variant.fallbacks : [],
    };
  if (
    !isProbability(variant.aboveProbability) ||
    !isProbability(variant.belowProbability) ||
    Math.abs(variant.aboveProbability + variant.belowProbability - 1) > 1e-9 ||
    (name === 'production' &&
      (!isProbability(record.decision.aboveProbability) ||
        Math.abs(variant.aboveProbability - record.decision.aboveProbability) > 1e-9))
  )
    return { available: false, reason: 'invalid-probability', fallbacks: [] };
  if (
    name !== 'production' &&
    (!Number.isFinite(variant.referencePrice) ||
      variant.referencePrice <= 0 ||
      !isTimestamp(variant.referenceAt) ||
      variant.referenceAt > record.decision.capturedAt ||
      !['cf-brti', 'coinbase-proxy'].includes(variant.referenceSource) ||
      !Number.isFinite(variant.minuteVolatility) ||
      variant.minuteVolatility <= 0 ||
      !Number.isFinite(variant.basisLogDeviation) ||
      variant.basisLogDeviation < 0)
  )
    return { available: false, reason: 'invalid-reference', fallbacks: [] };
  return {
    ...variant,
    available: true,
    fallbacks: Array.isArray(variant.fallbacks)
      ? [...new Set(variant.fallbacks.filter((reason) => typeof reason === 'string'))]
      : [],
  };
}

function getMetrics(records, variant) {
  const score = scoreLearningRows(
    records.map((record) => ({
      probability: record.variants[variant].aboveProbability,
      outcome: record.outcome,
      windowStart: record.windowStartAt,
      currentSide: Number(Math.round(record.decision.spot * 100) / 100 >= record.decision.target),
    })),
  );
  const intervals = records.filter((record) => {
    const estimate = record.variants[variant];
    return (
      Number.isFinite(estimate.settlementLowerBound) &&
      estimate.settlementLowerBound > 0 &&
      Number.isFinite(estimate.settlementUpperBound) &&
      estimate.settlementUpperBound >= estimate.settlementLowerBound
    );
  });
  const coveredIntervals = intervals.filter((record) => {
    const estimate = record.variants[variant];
    return (
      record.settlementPrice >= estimate.settlementLowerBound &&
      record.settlementPrice <= estimate.settlementUpperBound
    );
  }).length;
  return {
    examples: records.length,
    brier: score.brier,
    logLoss: score.logLoss,
    accuracy: score.callAccuracy,
    directionalCalls: score.directionalCalls,
    directionalAccuracy: score.directionalAccuracy,
    expectedCalibrationError: score.expectedCalibrationError,
    calibrationBins: score.calibrationBins,
    interval: {
      nominalCoverage: 0.8,
      scoredIntervals: intervals.length,
      observedCoverage: ratio(coveredIntervals, intervals.length),
      unavailableIntervals: records.length - intervals.length,
    },
  };
}

const accuracy = (probability, outcome) =>
  probability === 0.5 ? 0.5 : Number(Number(probability > 0.5) === outcome);
function logLoss(probability, outcome) {
  const bounded = Math.max(1e-6, Math.min(1 - 1e-6, probability));
  return -outcome * Math.log(bounded) - (1 - outcome) * Math.log(1 - bounded);
}

function getDifference(record, variant, comparator) {
  const probability = record.variants[variant].aboveProbability;
  const reference = record.variants[comparator].aboveProbability;
  return {
    brier: (probability - record.outcome) ** 2 - (reference - record.outcome) ** 2,
    logLoss: logLoss(probability, record.outcome) - logLoss(reference, record.outcome),
    accuracy: accuracy(probability, record.outcome) - accuracy(reference, record.outcome),
  };
}

/** Resample consecutive event blocks, retaining every pair and never treating checkpoints as IID. */
function getBlockSensitivity(records, variant, comparator, blockLength) {
  const groups = groupOverlappingWindows(records);
  const blocks = [];
  for (const group of groups) {
    const differences = group.rows.map((row) => getDifference(row, variant, comparator));
    const values = Object.fromEntries(
      ['brier', 'logLoss', 'accuracy'].map((metric) => [
        metric,
        average(differences.map((difference) => difference[metric])),
      ]),
    );
    const previous = blocks.at(-1);
    if (!previous || previous.values.length >= blockLength || group.startAt > previous.endAt)
      blocks.push({ endAt: group.endAt, values: [values] });
    else {
      previous.values.push(values);
      previous.endAt = group.endAt;
    }
  }
  const result = {
    method: 'paired-consecutive-event-block-bootstrap',
    requestedBlockLength: blockLength,
    independentWindows: groups.length,
    blocks: blocks.length,
    blockSizes: blocks.map((block) => block.values.length),
    replicates: BOOTSTRAP_REPLICATES,
    confidenceLevel: 0.95,
    sensitivityOnly: true,
    intervals: null,
  };
  if (blocks.length < 2)
    return {
      ...result,
      reason: 'At least two event blocks are required for a sensitivity interval.',
    };
  let seed = 0x5e7a1b3c;
  const samples = { brier: [], logLoss: [], accuracy: [] };
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate++) {
    const totals = { brier: 0, logLoss: 0, accuracy: 0 };
    let sampledWindows = 0;
    for (let index = 0; index < blocks.length; index++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const selected = blocks[Math.floor((seed / 4294967296) * blocks.length)];
      for (const values of selected.values) {
        sampledWindows++;
        for (const metric of Object.keys(totals)) totals[metric] += values[metric];
      }
    }
    for (const metric of Object.keys(samples))
      samples[metric].push(totals[metric] / sampledWindows);
  }
  return {
    ...result,
    intervals: Object.fromEntries(
      Object.entries(samples).map(([metric, values]) => {
        values.sort((left, right) => left - right);
        return [
          metric,
          [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]],
        ];
      }),
    ),
    reason:
      'Exploratory sensitivity only; these intervals do not approve a model or isolate causality.',
  };
}

function hasSameReference(record, variant, comparator) {
  if (variant === 'production' || comparator === 'production') return true;
  const first = record.variants[variant];
  const second = record.variants[comparator];
  return [
    'referencePrice',
    'referenceAt',
    'referenceSource',
    'minuteVolatility',
    'basisLogDeviation',
  ].every((key) => first[key] === second[key]);
}

function compareVariants(records, variant, comparator) {
  const available = records.filter(
    (record) => record.variants[variant].available && record.variants[comparator].available,
  );
  const matching = available.filter((record) => hasSameReference(record, variant, comparator));
  const paired = matching.filter(
    (record) => record.outcomeStatus === 'verified' && !record.conflict,
  );
  const differences = paired.map((record) => getDifference(record, variant, comparator));
  return {
    comparator,
    decisions: records.length,
    availablePairs: matching.length,
    mismatchedReferences: available.length - matching.length,
    scoredPairs: paired.length,
    independentWindows: groupOverlappingWindows(paired).length,
    pairCoverage: ratio(matching.length, records.length),
    outcomeCoverage: ratio(paired.length, matching.length),
    differentProbabilities: paired.filter(
      (record) =>
        Math.abs(
          record.variants[variant].aboveProbability - record.variants[comparator].aboveProbability,
        ) > 1e-9,
    ).length,
    pairsWithFallback: paired.filter(
      (record) =>
        record.variants[variant].fallbacks.length || record.variants[comparator].fallbacks.length,
    ).length,
    variant: getMetrics(paired, variant),
    reference: getMetrics(paired, comparator),
    delta: Object.fromEntries(
      ['brier', 'logLoss', 'accuracy'].map((metric) => [
        metric,
        differences.length ? average(differences.map((difference) => difference[metric])) : null,
      ]),
    ),
    sensitivity: BLOCK_LENGTHS.map((length) =>
      getBlockSensitivity(paired, variant, comparator, length),
    ),
  };
}

function summarizeGroup(records, label) {
  const missingReasons = {};
  const outcomeCounts = { verified: 0, unresolved: 0, unobserved: 0, invalid: 0, conflicting: 0 };
  for (const record of records) {
    if (record.experimentReason) increment(missingReasons, record.experimentReason);
    increment(outcomeCounts, record.outcomeStatus);
  }
  return {
    label,
    decisions: records.length,
    independentWindows: groupOverlappingWindows(records).length,
    duplicateDecisions: records.reduce((sum, record) => sum + record.duplicateDecisions, 0),
    conflictingDecisions: records.filter((record) => record.conflict).length,
    recordedExperiments: records.filter((record) => !record.experimentReason).length,
    missingReasons,
    outcomes: outcomeCounts,
    variants: Object.fromEntries(
      RESEARCH_VARIANTS.map((name) => {
        const available = records.filter((record) => record.variants[name].available);
        const scored = available.filter(
          (record) => record.outcomeStatus === 'verified' && !record.conflict,
        );
        const unavailableReasons = {};
        const fallbackReasons = {};
        for (const record of records) {
          const variant = record.variants[name];
          if (!variant.available) increment(unavailableReasons, variant.reason);
          for (const reason of variant.fallbacks) increment(fallbackReasons, reason);
        }
        return [
          name,
          {
            estimates: available.length,
            scoredEstimates: scored.length,
            callCoverage: ratio(available.length, records.length),
            outcomeCoverage: ratio(scored.length, available.length),
            unavailableReasons,
            fallbackEstimates: available.filter((record) => record.variants[name].fallbacks.length)
              .length,
            fallbackReasons,
            spotApplied: available.filter((record) => record.variants[name].appliedSpot === true)
              .length,
            futuresApplied: available.filter(
              (record) => record.variants[name].appliedFutures === true,
            ).length,
            metrics: getMetrics(scored, name),
            comparisons: Object.fromEntries(
              ['settlement-only', 'combined']
                .filter((reference) => reference !== name)
                .map((reference) => [reference, compareVariants(records, name, reference)]),
            ),
          },
        ];
      }),
    ),
  };
}

/** Read-only audit of predictions actually recorded at capture, with no historical reconstruction. */
export function evaluateResearchExperiments(evidenceRows = [], { now = Date.now() } = {}) {
  if (!Array.isArray(evidenceRows) || !isTimestamp(now))
    throw new Error('Research evaluation requires evidence rows and a valid evaluation timestamp.');
  const collected = collectDecisions(evidenceRows, now);
  const records = collected.records
    .sort(
      (left, right) =>
        left.windowStartAt - right.windowStartAt ||
        left.expiresAt - right.expiresAt ||
        left.key.localeCompare(right.key),
    )
    .map((record) => {
      const experimentReason = getExperimentReason(record);
      return {
        ...record,
        experimentReason,
        variants: Object.fromEntries(
          RESEARCH_VARIANTS.map((name) => [name, getVariant(record, name, experimentReason)]),
        ),
      };
    });
  const manual = records.filter((record) => record.scope === 'manual-fixed');
  return {
    version: RESEARCH_EXPERIMENT_VERSION,
    generatedAt: now,
    status: records.some((record) => !record.experimentReason)
      ? 'collecting'
      : 'no-recorded-experiments',
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    counts: {
      ...collected.counts,
      decisions: records.length,
      uniqueContracts: new Set(records.map((record) => record.decision.kalshiMarket.ticker)).size,
      independentWindows: groupOverlappingWindows(records).length,
      recordedExperiments: records.filter((record) => !record.experimentReason).length,
    },
    checkpoints: CHECKPOINTS.map((minutes) => ({
      checkpointMinutes: minutes,
      finalMinute: minutes === 1,
      ...summarizeGroup(
        records.filter((record) => record.scope === `checkpoint-${minutes}`),
        `${minutes} minutes remaining`,
      ),
    })),
    savedFixedCheckpoints: ['manual', 'automatic'].flatMap((captureOrigin) =>
      CHECKPOINTS.map((minutes) => ({
        captureOrigin,
        checkpointMinutes: minutes,
        finalMinute: minutes === 1,
        ...summarizeGroup(
          records.filter((record) => record.scope === `saved-fixed-${captureOrigin}-${minutes}`),
          `${captureOrigin === 'automatic' ? 'Automatic' : 'Manual'} saved Fixed: ${minutes} minutes remaining`,
        ),
      })),
    ),
    manualFixed: {
      ...summarizeGroup(manual, 'Manual Fixed captures'),
      byHorizon: [
        { label: 'Under 1 minute', minimum: 0, maximum: 1, finalMinute: true },
        { label: '1–3 minutes', minimum: 1, maximum: 3, finalMinute: false },
        { label: '3–6 minutes', minimum: 3, maximum: 6, finalMinute: false },
        { label: '6–10 minutes', minimum: 6, maximum: 10, finalMinute: false },
        { label: '10–15 minutes', minimum: 10, maximum: 15.000001, finalMinute: false },
      ].map(({ label, minimum, maximum, finalMinute }) => ({
        finalMinute,
        ...summarizeGroup(
          manual.filter((record) => {
            const horizon = (record.expiresAt - record.decision.capturedAt) / 60_000;
            return (
              isTimestamp(record.decision.capturedAt) && horizon >= minimum && horizon < maximum
            );
          }),
          label,
        ),
      })),
    },
    explanation:
      'Probabilities use a 0–1 scale. Background checkpoints, saved Fixed checkpoints by manual/automatic origin, and legacy Manual Fixed captures are evaluated separately. The earliest decision per contract, checkpoint and origin is selected before inspecting availability or outcomes; repeated observations never become extra trials. Checkpoints from one contract remain one independent event window. Official matching contract outcomes may be shared across recorders. Missing experiments, forecasts, fallbacks and outcomes remain in coverage denominators. Negative Brier/log-loss differences and positive accuracy differences favor the named variant. Blocks preserve consecutive event dependence; results are exploratory and never activate or retrain a model.',
  };
}
