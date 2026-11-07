import {
  createLearningEventPair,
  learningInterval,
  learningStart,
} from '../../helpers/learningEvidenceFixtures';

export const createDirectionalPair = (index, options = {}) => {
  const pair = createLearningEventPair({
    startsAt: learningStart + index * learningInterval,
    baselineProbability: 0.6,
    spot: 50_000,
    targetDistance: 0.25,
    outcome: index % 2 ? 'no' : 'yes',
    schemaVersion: 'deadline-reversal-features-v3',
    pipeline: { baselineModelVersion: 'kalshi-brti-derivatives-v2' },
    ...options,
  });
  // The archived three-minute return predicts these synthetic official outcomes;
  // all optional pressure and market inputs are absent, so their rules fall back.
  pair[0].learningFeatures.values[4] = index % 2 ? -0.2 : 0.2;
  pair[0].researchExperiment = {
    version: index % 2 ? 'kalshi-ablation-v5' : 'kalshi-ablation-v4',
    variants: {},
  };
  return pair;
};

export const createLaterDuplicate = (pair) => {
  const duplicate = JSON.parse(JSON.stringify(pair));
  const id = `${pair[0].forecastId}-later`;
  for (const row of duplicate) {
    row.forecastId = id;
    row.eventId = `${id}:${row.event}`;
  }
  const decision = duplicate[0];
  decision.recordedAt += 1000;
  decision.capturedAt += 1000;
  decision.inputObservedAt += 1000;
  decision.featureCutoffAt += 1000;
  decision.learningFeatures.featureCutoffAt += 1000;
  delete decision.researchReplay;
  return duplicate;
};

export const studyTime = (windows) =>
  new Date(learningStart + windows * learningInterval).toISOString();
