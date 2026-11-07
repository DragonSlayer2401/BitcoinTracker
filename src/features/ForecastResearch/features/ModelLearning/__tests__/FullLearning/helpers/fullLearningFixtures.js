import {
  createLearningEvents,
  learningInterval,
  learningStart,
} from '../../helpers/learningEvidenceFixtures';
import { evaluateShadowCandidate, trainOutcomeCandidate } from '../../../utils/training.utils';
import {
  evaluateEarlyShadowCandidate,
  trainEarlyCandidate,
} from '../../../utils/earlyTraining.utils';

export const fullTrainingAt = learningStart + 240 * learningInterval;

// Archived inputs with an independently known useful signal. The baseline and
// current-side calls cannot distinguish alternating outcomes; recent return can.
export const createFullLearningEvents = ({ count = 240, ...options } = {}) =>
  createLearningEvents({
    count,
    probabilityForIndex: () => 0.6,
    outcomeForIndex: (index) => index % 2,
    spotForIndex: () => 50_000,
    targetDistance: 0,
    valuesForIndex: (index, values) =>
      values.map((value, position) => (position === 3 ? (index % 2 ? 1 : -1) : value)),
    ...options,
  });

// Existing candidates are an archive input boundary for prospective workflows.
// Generate them with the real fit so their coefficients and domain remain valid.
export const createStoredFullCandidate = () => {
  const trained = trainOutcomeCandidate(createFullLearningEvents(), { now: fullTrainingAt });
  if (!trained.artifact?.evaluation.eligibleForShadow)
    throw new Error(`Invalid full-model fixture: ${trained.reason}`);
  return trained.artifact;
};

export const createActiveFullModel = () => {
  const candidate = createStoredFullCandidate();
  const validation = createFullLearningEvents({
    count: 120,
    startAt: fullTrainingAt + learningInterval,
    model: candidate,
    phase: 'shadow',
  });
  const activatedAt = modelEventsEnd(validation);
  const shadowEvaluation = evaluateShadowCandidate(candidate, validation, { now: activatedAt });
  if (!shadowEvaluation.eligibleForPromotion)
    throw new Error('Invalid promoted full-model fixture.');
  return {
    ...candidate,
    activation: {
      modelId: candidate.id,
      activatedAt,
      shadowEvaluation,
    },
  };
};

export const modelEventsEnd = (events) =>
  Math.max(...events.map((event) => event.recordedAt)) + 1000;

export const createSupersededEarlyScenario = (fullModel) => {
  const training = createLearningEvents({ count: 40 });
  const model = trainEarlyCandidate(training, {
    now: learningStart + 40 * learningInterval,
  }).artifact;
  const future = createLearningEvents({
    count: 40,
    startAt: fullModel.activation.activatedAt + learningInterval,
    model,
    phase: 'shadow',
  });
  const events = [...training, ...future];
  const evaluation = evaluateEarlyShadowCandidate(model, events, { now: modelEventsEnd(events) });
  if (!evaluation.eligibleForPromotion) throw new Error('Invalid prospective early-model fixture.');
  return { model, events };
};
