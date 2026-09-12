import { getValidatedForecast } from '../journal.utils';
import {
  getLearningPipeline,
  isLearningFeatureSnapshot,
  matchesLearningPipeline,
} from './features.utils';
import { scoreProbabilities } from './statistics.utils';
import {
  KALSHI_OUTCOME_DEFINITION,
  isKalshiContract,
  isVerifiedKalshiOutcome,
} from '../kalshi/contract.utils';
import { getKalshiMarketProbability } from '../kalshi/marketQuote.utils';

const isValidProbability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const isValidTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isSameForecastWindow = (left, right) =>
  left.forecastId === right.forecastId &&
  left.target === right.target &&
  left.expiresAt === right.expiresAt &&
  left.windowStartAt === right.windowStartAt &&
  left.source === right.source &&
  left.outcomeDefinition === right.outcomeDefinition &&
  (left.kalshiMarket?.ticker ?? null) === (right.kalshiMarket?.ticker ?? null);

/** Deduplicate recorded evidence before matching decisions to official outcomes. */
export function collectLearningEvents(events, now) {
  const decisions = new Map();
  const outcomes = new Map();
  const conflicts = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (
      !event ||
      typeof event.forecastId !== 'string' ||
      !isValidTimestamp(event.recordedAt) ||
      event.recordedAt > now ||
      event.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION ||
      !isKalshiContract(event.kalshiMarket) ||
      event.target !== event.kalshiMarket.target ||
      event.expiresAt !== event.kalshiMarket.expiresAt ||
      event.windowStartAt !== event.kalshiMarket.startsAt
    )
      continue;
    if (event.event === 'decision') {
      const previous = decisions.get(event.forecastId);
      if (!previous) decisions.set(event.forecastId, event);
      else if (
        !isSameForecastWindow(previous, event) ||
        previous.aboveProbability !== event.aboveProbability ||
        previous.capturedAt !== event.capturedAt
      )
        conflicts.add(event.forecastId);
      else if (event.recordedAt < previous.recordedAt) decisions.set(event.forecastId, event);
    }
    if (event.event === 'outcome') {
      const previous = outcomes.get(event.forecastId);
      if (!previous) outcomes.set(event.forecastId, event);
      else if (
        !isSameForecastWindow(previous, event) ||
        previous.observedPrice !== event.observedPrice ||
        previous.observedAt !== event.observedAt ||
        previous.outcomeStatus !== event.outcomeStatus ||
        previous.outcome !== event.outcome
      )
        conflicts.add(event.forecastId);
    }
  }
  return { decisions, outcomes, conflicts };
}

function hasMatchingOfficialOutcome(decision, outcome) {
  return (
    isSameForecastWindow(decision, outcome) &&
    isVerifiedKalshiOutcome(outcome.kalshiOutcome, decision.kalshiMarket, outcome.recordedAt) &&
    outcome.observedPrice === outcome.kalshiOutcome.observedPrice &&
    outcome.observedAt === outcome.kalshiOutcome.observedAt &&
    outcome.confirmedThrough === outcome.kalshiOutcome.confirmedThrough
  );
}

export function hasContemporaneousInputs(decision) {
  const cutoffAt = decision.inputObservedAt;
  return (
    decision.inputStatus === 'captured' &&
    isValidTimestamp(cutoffAt) &&
    decision.featureCutoffAt === cutoffAt &&
    decision.capturedAt === cutoffAt &&
    cutoffAt >= decision.windowStartAt &&
    cutoffAt <= decision.recordedAt &&
    cutoffAt < decision.expiresAt &&
    Number.isFinite(decision.spot) &&
    decision.spot > 0
  );
}

function createLearningRow(decision, outcome, observedSide, featuresAvailable) {
  const cutoffAt = decision.inputObservedAt;
  const learningFeatures = decision.learningFeatures;
  return {
    id: decision.forecastId,
    windowStart: decision.windowStartAt,
    windowStartAt: decision.windowStartAt,
    capturedAt: cutoffAt,
    expiresAt: decision.expiresAt,
    resolvedAt: outcome.recordedAt,
    target: decision.target,
    probability: decision.aboveProbability,
    // Kalshi settles in cents and includes equality on the YES side.
    currentSide: Number(Math.round(decision.spot * 100) / 100 >= decision.target),
    outcome: observedSide,
    horizonMinutes: (decision.expiresAt - cutoffAt) / 60_000,
    features: featuresAvailable ? learningFeatures.values : null,
    learningFeatures,
    modelVersion: decision.modelVersion,
    modelId: typeof decision.learning?.modelId === 'string' ? decision.learning.modelId : null,
    captureKey: decision.forecastId,
    intervalCovered:
      decision.intervalCoverage === 0.8 &&
      Number.isFinite(decision.intervalLow) &&
      decision.intervalLow > 0 &&
      Number.isFinite(decision.intervalHigh) &&
      decision.intervalHigh >= decision.intervalLow
        ? outcome.observedPrice >= decision.intervalLow &&
          outcome.observedPrice <= decision.intervalHigh
        : undefined,
    decision,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    marketTicker: decision.kalshiMarket?.ticker ?? null,
    marketProbability: getKalshiMarketProbability(
      decision.kalshiQuote,
      decision.kalshiMarket,
      cutoffAt,
    ),
    outcomeEvent: outcome,
  };
}

/** Only the contemporaneous issued decision can be a training row. Observations never duplicate it. */
export function getVerifiedLearningRows(events = [], now = Date.now()) {
  const outcomeDefinition = KALSHI_OUTCOME_DEFINITION;
  const { decisions, outcomes, conflicts } = collectLearningEvents(events, now);
  const counts = {
    savedForecasts: 0,
    issuedCalls: 0,
    verifiedOutcomes: 0,
    unresolved: 0,
    unobserved: 0,
    invalidOutcomes: 0,
    exactTargetOutcomes: 0,
    missingLearningFeatures: 0,
    conflictingForecasts: 0,
    learningExamples: 0,
  };
  const rows = [];
  const resolved = [];
  for (const decision of decisions.values()) {
    counts.savedForecasts++;
    if (conflicts.has(decision.forecastId)) {
      counts.conflictingForecasts++;
      continue;
    }
    if (
      !isValidTimestamp(decision.windowStartAt) ||
      !isValidTimestamp(decision.expiresAt) ||
      decision.windowStartAt >= decision.expiresAt ||
      !Number.isFinite(decision.target) ||
      decision.target <= 0
    )
      continue;
    const issued =
      isValidProbability(decision.aboveProbability) &&
      isValidProbability(decision.belowProbability) &&
      Math.abs(decision.aboveProbability + decision.belowProbability - 1) < 1e-6;
    if (issued) counts.issuedCalls++;
    const outcome = outcomes.get(decision.forecastId);
    if (!outcome) {
      counts.unresolved++;
      continue;
    }
    if (outcome.outcomeStatus === 'unobserved') {
      counts.unobserved++;
      continue;
    }
    if (!hasMatchingOfficialOutcome(decision, outcome)) {
      counts.invalidOutcomes++;
      continue;
    }
    const observedSide = Number(outcome.kalshiOutcome.result === 'yes');
    if (
      outcome.outcome !== (observedSide === 1 ? 'above' : observedSide === 0 ? 'below' : 'equal')
    ) {
      counts.invalidOutcomes++;
      continue;
    }
    counts.verifiedOutcomes++;
    if (observedSide === 0.5) {
      counts.exactTargetOutcomes++;
      continue;
    }
    resolved.push({ decision, outcome, issued });
    if (!issued) continue;
    if (!hasContemporaneousInputs(decision)) {
      counts.missingLearningFeatures++;
      continue;
    }
    const learningFeatures = decision.learningFeatures;
    const featuresAvailable = isLearningFeatureSnapshot(learningFeatures, {
      target: decision.target,
      expiresAt: decision.expiresAt,
      cutoffAt: decision.inputObservedAt,
      outcomeDefinition,
    });
    if (!featuresAvailable) counts.missingLearningFeatures++;
    rows.push(createLearningRow(decision, outcome, observedSide, featuresAvailable));
  }
  counts.learningExamples = rows.filter((row) => row.features).length;
  return {
    rows: rows.sort((a, b) => a.windowStartAt - b.windowStartAt || a.capturedAt - b.capturedAt),
    counts,
    resolved,
  };
}

/** Connected overlapping windows stay together across every split, including different targets. */
export function groupOverlappingWindows(rows) {
  const groups = [];
  for (const row of [...rows].sort(
    (a, b) => a.windowStartAt - b.windowStartAt || a.expiresAt - b.expiresAt,
  )) {
    const previous = groups.at(-1);
    if (!previous || row.windowStartAt >= previous.endAt) {
      groups.push({ startAt: row.windowStartAt, endAt: row.expiresAt, rows: [row] });
    } else {
      previous.endAt = Math.max(previous.endAt, row.expiresAt);
      previous.rows.push(row);
    }
  }
  return groups;
}

/** One deterministic representative per overlapping group prevents repeated/correlated quote inflation. */
export function getIndependentRows(rows) {
  return groupOverlappingWindows(rows).map(getWindowRepresentative);
}

/** Calendar-determined horizon selection cannot favor a checkpoint after its outcome is known. */
export function getWindowRepresentative(group) {
  const sorted = [...group.rows].sort(
    (a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id),
  );
  if (sorted[0]?.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION) return sorted[0];
  const selectedHorizonMinutes = [12, 9, 6, 3, 1][Math.floor(group.startAt / 900_000) % 5];
  return sorted.reduce((closest, row) =>
    Math.abs(row.horizonMinutes - selectedHorizonMinutes) <
    Math.abs(closest.horizonMinutes - selectedHorizonMinutes)
      ? row
      : closest,
  );
}

export function scoreLearningRows(rows) {
  const score = scoreProbabilities(rows, 0.5);
  const directional = rows.filter((row) => row.probability !== 0.5);
  const reversals = rows.filter(
    (row) => row.currentSide !== 0.5 && row.currentSide !== row.outcome,
  );
  const alarms = rows.filter(
    (row) =>
      row.currentSide !== 0.5 &&
      row.probability !== 0.5 &&
      Number(row.probability > 0.5) !== row.currentSide,
  );
  return {
    ...score,
    // Exact 50/50 is a published neutral estimate, not a directional correct/incorrect call.
    directionalCalls: directional.length,
    directionalAccuracy: directional.length
      ? directional.filter((row) => Number(row.probability > 0.5) === row.outcome).length /
        directional.length
      : null,
    callAccuracy: rows.length
      ? rows.reduce(
          (sum, row) =>
            sum +
            (row.probability === 0.5 ? 0.5 : Number(Number(row.probability > 0.5) === row.outcome)),
          0,
        ) / rows.length
      : null,
    reversals: reversals.length,
    reversalAlerts: alarms.length,
    reversalRecall: reversals.length
      ? reversals.filter(
          (row) => row.probability !== 0.5 && Number(row.probability > 0.5) === row.outcome,
        ).length / reversals.length
      : null,
    reversalFalseAlarmRate: alarms.length
      ? alarms.filter((row) => Number(row.probability > 0.5) !== row.outcome).length / alarms.length
      : null,
    currentSideAccuracy: rows.length
      ? rows.reduce(
          (sum, row) =>
            sum + (row.currentSide === 0.5 ? 0.5 : Number(row.currentSide === row.outcome)),
          0,
        ) / rows.length
      : null,
  };
}

export function analyzeForecastEvidence(events, now = Date.now()) {
  const outcomeDefinition = KALSHI_OUTCOME_DEFINITION;
  const { rows, counts, resolved } = getVerifiedLearningRows(events, now, { outcomeDefinition });
  const cohortName = 'kalshi-background';
  const backgroundRows = rows.filter((row) => row.decision.cohort === cohortName);
  const reportRows = backgroundRows.length ? backgroundRows : rows;
  const independent = getIndependentRows(reportRows);
  const matchedMarketRows = independent.filter((row) => row.marketProbability !== null);
  const inputPipelines = [
    ...new Map(
      reportRows
        .map((row) => getLearningPipeline(row.learningFeatures))
        .filter(Boolean)
        .map((pipeline) => [JSON.stringify(pipeline), pipeline]),
    ).values(),
  ];
  const countsByHorizon = [
    { label: 'Under 3 minutes', minimum: 0, maximum: 3 },
    { label: '3–6 minutes', minimum: 3, maximum: 6 },
    { label: '6–10 minutes', minimum: 6, maximum: 10 },
    { label: '10–15 minutes', minimum: 10, maximum: 15.000001 },
  ].map(({ label, minimum, maximum }) => ({
    label,
    ...scoreLearningRows(
      getIndependentRows(
        reportRows.filter((row) => row.horizonMinutes >= minimum && row.horizonMinutes < maximum),
      ),
    ),
  }));
  return {
    status: independent.length ? 'collecting' : 'insufficient-data',
    primaryCohort: backgroundRows.length ? cohortName : 'manual',
    outcomeDefinition,
    counts,
    independentWindows: independent.length,
    metrics: scoreLearningRows(independent),
    issuedMetrics: scoreLearningRows(rows),
    marketBenchmark: {
      ...scoreLearningRows(
        matchedMarketRows.map((row) => ({ ...row, probability: row.marketProbability })),
      ),
      label: 'Kalshi YES bid/ask midpoint at the same capture time',
      matchedModel: scoreLearningRows(matchedMarketRows),
    },
    byHorizon: countsByHorizon,
    byInputSource: inputPipelines.map((pipeline) => ({
      ...pipeline,
      ...scoreLearningRows(
        getIndependentRows(
          reportRows.filter((row) => matchesLearningPipeline(row.learningFeatures, pipeline)),
        ),
      ),
    })),
    byModel: [...new Set(independent.map((row) => row.modelId ?? row.modelVersion))].map((id) => {
      const group = independent.filter((row) => (row.modelId ?? row.modelVersion) === id);
      return {
        modelVersion: group[0].modelVersion,
        modelId: group[0].modelId,
        ...scoreLearningRows(group),
      };
    }),
    byCohort: ['manual', cohortName].map((cohort) => ({
      cohort,
      ...scoreLearningRows(
        getIndependentRows(rows.filter((row) => (row.decision.cohort ?? 'manual') === cohort)),
      ),
    })),
    callCoverage: counts.savedForecasts ? counts.issuedCalls / counts.savedForecasts : null,
    outcomeCoverage: counts.savedForecasts ? counts.verifiedOutcomes / counts.savedForecasts : null,
    resolvedCallCoverage: resolved.length
      ? resolved.filter((row) => row.issued).length / resolved.length
      : null,
    failedFixedPredictions: independent.filter(
      (row) => row.probability !== 0.5 && Number(row.probability > 0.5) !== row.outcome,
    ).length,
    explanation:
      'Metrics use official Kalshi contract results. Independent metrics retain one decision per overlapping window group; missing outcomes are not treated as losses.',
  };
}

/** Audit original journal predictions even when their training inputs were never recorded. */
export function analyzeSavedForecasts(forecasts = [], now = Date.now()) {
  const unique = new Map();
  for (const input of forecasts) {
    const forecast = getValidatedForecast(input);
    if (forecast?.outcomeDefinition === KALSHI_OUTCOME_DEFINITION && forecast.createdAt <= now)
      unique.set(forecast.id, forecast);
  }
  const saved = [...unique.values()];
  const resolved = saved.filter(
    (forecast) => forecast.status === 'resolved' && forecast.observedAt <= now,
  );
  const groups = [
    { outcomeDefinition: KALSHI_OUTCOME_DEFINITION, label: 'Official Kalshi contract outcomes' },
  ].map(({ outcomeDefinition, label }) => {
    const examples = resolved.filter(
      (forecast) =>
        forecast.outcomeDefinition === outcomeDefinition &&
        isVerifiedKalshiOutcome(forecast.kalshiOutcome, forecast.kalshiMarket, now) &&
        ['above', 'below'].includes(forecast.outcome),
    );
    const rows = examples.map((forecast) => ({
      id: forecast.id,
      windowStartAt: forecast.startsAt ?? forecast.createdAt,
      windowStart: forecast.startsAt ?? forecast.createdAt,
      capturedAt: forecast.createdAt,
      expiresAt: forecast.expiresAt,
      probability: forecast.aboveProbability,
      currentSide: Number(Math.round(forecast.price * 100) / 100 >= forecast.target),
      outcome: forecast.outcome === 'above' ? 1 : 0,
      modelVersion: forecast.modelVersion,
    }));
    return {
      outcomeDefinition,
      label,
      ...scoreLearningRows(rows),
      independentWindows: groupOverlappingWindows(rows).length,
    };
  });
  return {
    savedForecasts: saved.length,
    issuedCalls: saved.filter((forecast) => isValidProbability(forecast.aboveProbability)).length,
    resolvedForecasts: resolved.length,
    unobserved: saved.filter((forecast) => forecast.status === 'unobserved').length,
    withheld: saved.filter((forecast) => forecast.status === 'withheld').length,
    groups,
    explanation:
      'Saved predictions are audited against their original targets and documented outcome rules. A journal record alone never supplies missing training inputs.',
  };
}
