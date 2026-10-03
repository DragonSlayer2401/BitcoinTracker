import {
  collectLearningEvents,
  getVerifiedLearningRows,
  groupOverlappingWindows,
} from './learning/evaluation.utils';
import { getLearningFeatureSchema } from './learning/features.utils';

// This experiment is frozen. Changing a rule or its input generation requires a new analysis version.
const ANALYSIS_VERSION = 'simple-directional-rules-v2';
// V5 adds a shadow candidate without changing the baseline or features used by these rules.
export const EXPLORATORY_RESEARCH_VERSIONS = Object.freeze([
  'kalshi-ablation-v4',
  'kalshi-ablation-v5',
]);
const BASELINE_VERSION = 'kalshi-brti-derivatives-v2';
const CHECKPOINTS = [12, 9, 6, 3, 1];
const ratio = (numerator, denominator) => (denominator ? numerator / denominator : null);
const direction = (value, fallback) => (value === 0 ? fallback : Number(value > 0));
const feature = (row, name) =>
  row.features[getLearningFeatureSchema(row.learningFeatures.schemaVersion).names.indexOf(name)];

function hasPressureAgreement(row) {
  return (
    Math.abs(row.learningFeatures.targetDistance) <= 0.5 &&
    feature(row, 'flow60Available') === 1 &&
    feature(row, 'futuresFlow60Available') === 1 &&
    feature(row, 'buyPressure60') !== 0 &&
    Math.sign(feature(row, 'buyPressure60')) === Math.sign(feature(row, 'futuresPressure60'))
  );
}

function getRecordedMarketProbability(row) {
  const market = row.decision.researchExperiment.variants?.['market-only'];
  return market?.available === true &&
    Number.isFinite(market.aboveProbability) &&
    market.aboveProbability >= 0 &&
    market.aboveProbability <= 1
    ? market.aboveProbability
    : null;
}

const RULES = [
  {
    id: 'current-side',
    description:
      'Predict the current side of the target, with Kalshi cent rounding and YES equality.',
    predict: (row) => row.currentSide,
  },
  {
    id: 'live',
    description: 'Recorded live probability direction; exact 50/50 falls back to current side.',
    predict: (row) => direction(row.probability - 0.5, row.currentSide),
  },
  {
    id: 'momentum3',
    description: 'Follow the sign of the three-minute return; zero falls back to current side.',
    predict: (row) => direction(feature(row, 'return3'), row.currentSide),
  },
  {
    id: 'reversal3',
    description: 'Oppose the sign of the three-minute return; zero falls back to current side.',
    predict: (row) => direction(-feature(row, 'return3'), row.currentSide),
  },
  {
    id: 'near-agreement60',
    description:
      'When absolute normalized target distance is at most 0.5, follow matching nonzero spot/futures 60-second pressure with both availability flags; otherwise current side.',
    predict: (row) =>
      hasPressureAgreement(row)
        ? direction(feature(row, 'buyPressure60'), row.currentSide)
        : row.currentSide,
  },
  {
    id: 'market',
    description:
      'Follow the recorded available market-only probability; missing data or exact 50/50 falls back to current side.',
    predict: (row) => {
      const probability = getRecordedMarketProbability(row);
      return probability === null ? row.currentSide : direction(probability - 0.5, row.currentSide);
    },
  },
];

function isEligibleDecision(decision) {
  return (
    decision.cohort === 'kalshi-background' &&
    EXPLORATORY_RESEARCH_VERSIONS.includes(decision.researchExperiment?.version) &&
    decision.learningFeatures?.baselineModelVersion === BASELINE_VERSION &&
    decision.learningFeatures.referenceSource === 'cf-brti' &&
    decision.learningFeatures.featureInputSource === 'cf-brti-history' &&
    CHECKPOINTS.includes(decision.checkpointMinutes) &&
    Number.isSafeInteger(decision.capturedAt)
  );
}

function getEarliestDecisions(decisions) {
  const selected = new Map();
  const sorted = [...decisions].sort(
    (left, right) =>
      left.capturedAt - right.capturedAt ||
      left.recordedAt - right.recordedAt ||
      left.forecastId.localeCompare(right.forecastId),
  );
  for (const decision of sorted) {
    const key = `${decision.kalshiMarket.ticker}:${decision.checkpointMinutes}`;
    if (!selected.has(key)) selected.set(key, decision);
  }
  return [...selected.values()];
}

function scoreRule(groups, rule) {
  const rows = groups.flatMap((group) => group.rows);
  let correct = 0;
  let beneficialChanges = 0;
  let harmfulChanges = 0;
  let weightedCorrect = 0;
  let weightedBaselineCorrect = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      const predicted = rule.predict(row);
      const isCorrect = predicted === row.outcome;
      const isBaselineCorrect = row.currentSide === row.outcome;
      correct += Number(isCorrect);
      weightedCorrect += Number(isCorrect) / group.rows.length;
      weightedBaselineCorrect += Number(isBaselineCorrect) / group.rows.length;
      if (predicted !== row.currentSide) {
        beneficialChanges += Number(isCorrect);
        harmfulChanges += Number(!isCorrect);
      }
    }
  }
  return {
    rule: rule.id,
    rows: rows.length,
    independentGroups: groups.length,
    correct,
    accuracy: ratio(correct, rows.length),
    groupWeightedAccuracy: ratio(weightedCorrect, groups.length),
    baselineCorrect: rows.filter((row) => row.currentSide === row.outcome).length,
    actualReversals: rows.filter((row) => row.currentSide !== row.outcome).length,
    changedCalls: beneficialChanges + harmfulChanges,
    beneficialChanges,
    harmfulChanges,
    netCorrectChange: beneficialChanges - harmfulChanges,
    groupWeightedAccuracyChange: ratio(weightedCorrect - weightedBaselineCorrect, groups.length),
  };
}

function summarizePartition(groups) {
  const rows = groups.flatMap((group) => group.rows);
  return {
    rows: rows.length,
    contracts: new Set(rows.map((row) => row.marketTicker)).size,
    independentGroups: groups.length,
    firstStartAt: groups[0]?.startAt ?? null,
    lastExpiresAt: groups.at(-1)?.endAt ?? null,
    nearTargetRows: rows.filter((row) => Math.abs(row.learningFeatures.targetDistance) <= 0.5)
      .length,
    pressureAgreementRows: rows.filter(hasPressureAgreement).length,
    usableMarketRows: rows.filter((row) => getRecordedMarketProbability(row) !== null).length,
    comparisons: [null, ...CHECKPOINTS].map((checkpointMinutes) => {
      // Retain the original overlapping groups even when a horizon has missing captures.
      const matchedGroups = groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter(
            (row) =>
              checkpointMinutes === null || row.decision.checkpointMinutes === checkpointMinutes,
          ),
        }))
        .filter((group) => group.rows.length);
      return {
        checkpointMinutes,
        rules: RULES.map((rule) => scoreRule(matchedGroups, rule)),
      };
    }),
  };
}

/** Compare frozen exploratory rules without fitting, modifying evidence, or activating a model. */
export function compareExploratoryDirections(events, { asOf } = {}) {
  if (!Number.isSafeInteger(asOf) || asOf <= 0)
    throw new Error('A fixed asOf timestamp is required.');
  const collected = collectLearningEvents(events, asOf);
  const eligible = [...collected.decisions.values()].filter(isEligibleDecision);
  // Choose captures before consulting labels: a later duplicate cannot replace an unresolved one.
  const selected = getEarliestDecisions(eligible);
  // Match directional training's known-invalid exclusion. Missing legacy replay metadata is allowed.
  // Filter after selection so an invalid early capture cannot be replaced by a later duplicate.
  const replayEligible = selected.filter(
    (decision) => decision.researchReplay?.replayable !== false,
  );
  const selectedIds = new Set(replayEligible.map((decision) => decision.forecastId));
  const verified = getVerifiedLearningRows(events, asOf);
  const rows = verified.rows.filter((row) => selectedIds.has(row.id) && row.features);
  const groups = groupOverlappingWindows(rows);
  const splitIndex = Math.floor((groups.length * 2) / 3);
  const holdout = groups.slice(splitIndex);
  const holdoutStartsAt = holdout[0]?.startAt ?? null;
  const initialDevelopment = groups.slice(0, splitIndex);
  // Outcomes must have been published strictly before the first holdout window started.
  const purged = initialDevelopment.filter((group) =>
    group.rows.some((row) => row.expiresAt > holdoutStartsAt || row.resolvedAt >= holdoutStartsAt),
  );
  const purgedSet = new Set(purged);
  return {
    analysisVersion: ANALYSIS_VERSION,
    purpose: 'exploratory-only',
    warning:
      'Historical exploration, not release validation. These results do not train or activate a model. Checkpoints share outcomes and are not independent trials.',
    asOf,
    supportedResearchVersions: EXPLORATORY_RESEARCH_VERSIONS,
    baselineVersion: BASELINE_VERSION,
    replayPolicy:
      'Exclude explicitly unreplayable captures after earliest selection, without duplicate substitution. Missing legacy replay metadata remains eligible.',
    rules: RULES.map(({ id, description }) => ({ id, description })),
    splitPolicy:
      'First two-thirds of chronological overlapping contract groups develop; last third hold out. Purge whole development groups whose outcomes were not published before holdout started.',
    weighting:
      'Each overlapping contract group has equal weight; captures within it share that weight.',
    counts: {
      verifiedEvidence: verified.counts,
      eligibleDecisions: eligible.length,
      selectedDecisions: selected.length,
      duplicateDecisions: eligible.length - selected.length,
      excludedKnownUnreplayableCaptures: selected.length - replayEligible.length,
      selectedWithoutVerifiedFeaturesOrOutcome: replayEligible.length - rows.length,
      scoredRows: rows.length,
      contracts: new Set(rows.map((row) => row.marketTicker)).size,
      independentGroups: groups.length,
      developmentGroupsBeforePurge: splitIndex,
      purgedGroups: purged.length,
      purgedRows: purged.reduce((sum, group) => sum + group.rows.length, 0),
      purgedContracts: [
        ...new Set(purged.flatMap((group) => group.rows.map((row) => row.marketTicker))),
      ],
    },
    development: summarizePartition(initialDevelopment.filter((group) => !purgedSet.has(group))),
    holdout: summarizePartition(holdout),
  };
}
