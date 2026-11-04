import { isLearningFeatureSnapshot } from './features.utils';
import {
  collectLearningEvents,
  getIndependentRows,
  getVerifiedLearningRows,
  hasContemporaneousInputs,
} from './evaluation.utils';
import { matchesOutcomeModelPipeline } from './model.utils';

/** Choose independent decision slots before consulting official outcome availability. */
export function getProspectiveLearningCohort(model, events, now, startsAfter) {
  const { rows } = getVerifiedLearningRows(events, now);
  const { decisions, outcomes, conflicts } = collectLearningEvents(events, now);
  // A slow result holds its original slot, including its predetermined checkpoint. A later
  // contract or another checkpoint with an available result cannot replace that decision.
  const eligible = [...decisions.values()]
    .filter(
      (decision) =>
        decision.cohort === 'kalshi-background' &&
        hasContemporaneousInputs(decision) &&
        Number.isFinite(decision.aboveProbability) &&
        decision.aboveProbability >= 0 &&
        decision.aboveProbability <= 1 &&
        Number.isFinite(decision.belowProbability) &&
        decision.belowProbability >= 0 &&
        decision.belowProbability <= 1 &&
        Math.abs(decision.aboveProbability + decision.belowProbability - 1) <= 1e-6 &&
        matchesOutcomeModelPipeline(model, decision.learningFeatures) &&
        isLearningFeatureSnapshot(decision.learningFeatures, {
          target: decision.target,
          expiresAt: decision.expiresAt,
          cutoffAt: decision.inputObservedAt,
          outcomeDefinition: model.outcomeDefinition,
        }) &&
        decision.learningFeatures.settlementKnownFraction === 0 &&
        decision.windowStartAt > startsAfter &&
        decision.capturedAt > startsAfter,
    )
    .map((decision) => ({
      id: decision.forecastId,
      windowStartAt: decision.windowStartAt,
      capturedAt: decision.capturedAt,
      expiresAt: decision.expiresAt,
      horizonMinutes: (decision.expiresAt - decision.capturedAt) / 60_000,
      outcomeDefinition: model.outcomeDefinition,
      learningFeatures: decision.learningFeatures,
      decision,
    }));
  return {
    prospective: getIndependentRows(eligible),
    resolved: new Map(rows.map((row) => [row.id, row])),
    terminalFailures: new Set([
      ...conflicts,
      ...[...outcomes.entries()]
        .filter(([, outcome]) => outcome.outcomeStatus === 'unobserved')
        .map(([id]) => id),
    ]),
  };
}
