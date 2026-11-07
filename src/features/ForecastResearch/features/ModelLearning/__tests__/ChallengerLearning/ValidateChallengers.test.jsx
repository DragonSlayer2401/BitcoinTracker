import { createLearningArchive } from '../helpers/learningArchive';
import {
  analyzeLearning,
  openLearning,
  renderModelLearning,
  setupLearningTests,
} from '../helpers/learningTestHarness';
import {
  contractDuration,
  createChallenger,
  createChallengerEvents,
  createConfirmation,
  createForwardTrainingHistory,
  createTrainingSeed,
  endOfEvents,
  trainedAt,
} from './helpers/challengerFixtures';
import { openCandidate, openCheckpointValidation } from './helpers/challengerControls';

setupLearningTests();

test('waits for exact forward observations before fitting a pressure-response candidate', async () => {
  const { events, labels } = createForwardTrainingHistory();
  const archive = createLearningArchive({ events });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: endOfEvents(events) + 1000,
  });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog, 'Forward pressure candidate');
  expect(candidate.getByText('Training events: 0 / 60')).toBeVisible();
  expect(candidate.getByText(/forward fitting needs exact 60-second labels/)).toBeVisible();
  dialog = await analyzeLearning(view.user);
  expect(archive.artifacts.some((artifact) => artifact.kind === 'forward-pressure')).toBe(false);
  expect(archive.activeId).toBeNull();

  // The collector subsequently commits the original exact-second observations.
  archive.labels.push(...labels);
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog, 'Forward pressure candidate');
  expect(
    candidate.getByText('Collector check: waiting for a matching saved prediction.'),
  ).toBeVisible();
  expect(candidate.getByText('Training events: 60 / 60')).toBeVisible();
  expect(candidate.getByText('Separate calibration events: 20 / 20')).toBeVisible();
  expect(archive.artifacts.find((artifact) => artifact.kind === 'forward-pressure')).toMatchObject({
    status: 'shadow',
    enrollmentPolicy: 'collector-enrollment-v1',
    evaluation: { eligibleForShadow: true },
    calibration: { independentWindows: 20 },
  });
  expect(archive.activeId).toBeNull();
});

test('fits frozen candidates from earlier events and keeps later calibration separate from future approval', async () => {
  const priorPolicy = createChallenger();
  const events = createChallengerEvents({ model: priorPolicy, count: 80 });
  for (let index = 0; index < 80; index += 4) {
    // Some real outcomes reverse the observed side, which is required for
    // fitting the reversal lane alongside the fixed Half pressure policy.
    const decision = events[index * 2];
    decision.spot = 49_950;
    decision.learningFeatures.targetDistance = -1;
    decision.learningFeatures.values[1] = -1;
    for (const variant of Object.values(decision.researchExperiment.variants))
      variant.referencePrice = decision.spot;
  }
  const archive = createLearningArchive({ events });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: endOfEvents(events) + 1000,
  });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText(
      /Enough independent native BRTI events are available to freeze a prospective candidate/,
    ),
  ).toBeVisible();
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText('Collector check: waiting for a matching saved prediction.'),
  ).toBeVisible();
  expect(candidate.getByText('Training events: 60 / 60')).toBeVisible();
  expect(candidate.getByText('Separate calibration events: 20 / 20')).toBeVisible();
  expect(dialog.getByText(/No challenger is currently in use/)).toBeVisible();
  const frozenPolicy = archive.artifacts.find((artifact) => artifact.kind === 'reduced-pressure');
  const frozenReversal = archive.artifacts.find((artifact) => artifact.kind === 'reversal');
  expect(frozenPolicy).toMatchObject({
    status: 'shadow',
    enrollmentPolicy: 'collector-enrollment-v1',
    evaluation: { eligibleForShadow: true },
  });
  expect(frozenPolicy.calibration.primaryCutoffAt).toBeLessThan(frozenPolicy.calibration.startedAt);
  expect(frozenPolicy.calibration.independentWindows).toBe(20);
  expect(
    frozenPolicy.calibration.checkpoints.find((checkpoint) => checkpoint.checkpointMinutes === 9),
  ).toMatchObject({ status: 'fitted', samples: 20 });
  expect(frozenReversal.model.coefficients).toHaveLength(11);
  expect(
    frozenReversal.calibration.checkpoints.find((checkpoint) => checkpoint.checkpointMinutes === 9),
  ).toMatchObject({ status: 'fitted', samples: 20 });
  expect(archive.activeId).toBeNull();
  const writes = archive.repository.writeModelArtifact.mock.calls.length;
  await analyzeLearning(view.user);
  expect(archive.repository.writeModelArtifact).toHaveBeenCalledTimes(writes);
  expect(archive.activeId).toBeNull();
});

test('keeps a frozen candidate experimental until the collector establishes a future evaluation boundary', async () => {
  const model = createChallenger({ enrolled: true });
  const archive = createLearningArchive({ artifacts: [model], events: createTrainingSeed() });
  const view = await renderModelLearning({ repository: archive.repository, now: trainedAt + 1000 });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText('Collector check: waiting for a matching saved prediction.'),
  ).toBeVisible();
  expect(dialog.getByText(/No challenger is currently in use/)).toBeVisible();
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText('Collector check: waiting for a matching saved prediction.'),
  ).toBeVisible();
  expect(archive.activeId).toBeNull();
  expect(archive.developments).toEqual([]);

  const beginsAt = trainedAt + contractDuration;
  // This committed archive record represents a separate collector proving it
  // saved a matching prediction; the analysis UI cannot invent that proof.
  archive.developments.push({
    modelId: model.id,
    startedAt: beginsAt,
    updatedAt: trainedAt + 1000,
    status: 'collecting',
    cohortForecastIds: [],
    inclusiveBoundary: true,
    readiness: { collectorId: 'isolated-collector', proofEventId: 'saved-matching-prediction' },
  });
  await view.update(beginsAt - 1000);
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText(/Collector check passed. Evaluation begins with the event starting/),
  ).toBeVisible();
  expect(archive.activeId).toBeNull();

  archive.addEvents(createChallengerEvents({ model, count: 1, startAt: beginsAt }));
  await view.update(beginsAt + contractDuration);
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText(/Collector check passed. Evaluation started/)).toBeVisible();
  expect(candidate.getByText(/Scored future events: 1 \/ 60/)).toBeVisible();
  expect(archive.activeId).toBeNull();
});

test('waits for the original delayed result, nominates only the successful checkpoint, then activates after a fresh confirmation cohort', async () => {
  const model = createChallenger();
  const completeDevelopment = createChallengerEvents({ model });
  const delayedOutcome = completeDevelopment[1];
  const archive = createLearningArchive({
    artifacts: [model],
    events: [
      ...createTrainingSeed(),
      ...completeDevelopment.filter((row) => row !== delayedOutcome),
    ],
  });
  const firstReviewAt = endOfEvents(completeDevelopment) + 1000;
  const view = await renderModelLearning({ repository: archive.repository, now: firstReviewAt });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText(/Scored future events: 59 \/ 60 · 59 resolved/)).toBeVisible();
  dialog = await analyzeLearning(view.user);
  expect(archive.trials).toEqual([]);
  expect(archive.activeId).toBeNull();

  archive.addEvents([delayedOutcome]);
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText('Stage: Final confirmation on fresh events')).toBeVisible();
  expect(candidate.getByText('Confirmation attempt 1 · collecting')).toBeVisible();
  expect(archive.trials).toHaveLength(1);
  expect(archive.trials[0].approvedCheckpoints).toEqual([9]);
  expect(archive.activeId).toBeNull();
  const checkpointTable = await openCheckpointValidation(
    view.user,
    candidate,
    'Final confirmation',
  );
  expect(checkpointTable.getByRole('row', { name: /12m/ })).toHaveTextContent(
    'Not nominated; uses baseline',
  );
  expect(checkpointTable.getByRole('row', { name: /9m/ })).toHaveTextContent('0 / 60');

  const confirmation = createChallengerEvents({ model, startAt: firstReviewAt + contractDuration });
  archive.addEvents(confirmation);
  await view.update(endOfEvents(confirmation) + 1000);
  dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(new RegExp(`Validated challenger ${model.id}`))).toBeVisible();
  expect(dialog.getByText(/Active challenger: Half pressure/)).toBeVisible();
  expect(archive.activeId).toBe(model.id);
  expect(
    archive.artifacts.find((artifact) => artifact.id === model.id).activation.shadowEvaluation,
  ).toMatchObject({
    phase: 'confirmation',
    eligibleForPromotion: true,
    approvedCheckpoints: [9],
    independentWindows: 60,
  });
  expect(archive.trials[0].status).toBe('passed');
});

test('rejects a candidate that fails its fixed development cohort and does not approve it using later favorable events', async () => {
  const model = createChallenger();
  const badResults = createChallengerEvents({ model, improve: false });
  const archive = createLearningArchive({
    artifacts: [model],
    events: [...createTrainingSeed(), ...badResults],
  });
  const reviewAt = endOfEvents(badResults) + 1000;
  const view = await renderModelLearning({ repository: archive.repository, now: reviewAt });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText(/No nominated checkpoint passed all comparisons on the fixed cohort/),
  ).toBeVisible();
  dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(/No challenger is currently in use/)).toBeVisible();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toBeTruthy();
  expect(archive.trials).toEqual([]);

  const favorable = createChallengerEvents({
    model,
    count: 10,
    startAt: reviewAt + contractDuration,
  });
  archive.addEvents(favorable);
  await view.update(endOfEvents(favorable) + 1000);
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(
    candidate.getByText(/Collect 20 new independent events after the prior candidate/),
  ).toBeVisible();
  expect(archive.activeId).toBeNull();
  expect(archive.trials).toEqual([]);
});

test('reports missing captured predictions as unusable evidence rather than a valid performance comparison', async () => {
  const model = createChallenger();
  const events = createChallengerEvents({ model, missingPredictionIndex: 0 });
  const archive = createLearningArchive({
    artifacts: [model],
    events: [...createTrainingSeed(), ...events],
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: endOfEvents(events) + 1000,
  });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText(/Required recordings were missing or incompatible/)).toBeVisible();
  const table = await openCheckpointValidation(view.user, candidate);
  expect(table.getByRole('row', { name: /9m/ })).toHaveTextContent('59 / 60');
  expect(table.getByRole('row', { name: /9m/ })).toHaveTextContent('Incomplete evidence');
  dialog = await analyzeLearning(view.user);
  candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText(/Recovering from incomplete evidence/)).toBeVisible();
  expect(archive.activeId).toBeNull();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement.reason).toMatch(
    /^\[unusable-evidence\]/,
  );
});

test('abandons a persisted confirmation when its original cohort members disappear instead of replacing them after reload', async () => {
  const model = createChallenger();
  const startedAt = trainedAt + contractDuration;
  const events = createChallengerEvents({ model, count: 2, startAt: startedAt + contractDuration });
  const missingId = events[0].forecastId;
  const trial = createConfirmation(model, startedAt, { cohortForecastIds: [missingId] });
  const archive = createLearningArchive({
    artifacts: [model],
    events: [...createTrainingSeed(), ...events],
    trials: [trial],
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: endOfEvents(events) + 1000,
  });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText('Confirmation attempt 1 · collecting')).toBeVisible();
  archive.events.splice(
    archive.events.findIndex((row) => row.forecastId === missingId),
    2,
  );
  await view.reload();
  dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(/No challenger is currently in use/)).toBeVisible();
  expect(archive.trials[0]).toMatchObject({ status: 'abandoned', cohortForecastIds: [missingId] });
  expect(archive.trials[0].evaluation.failureCode).toBe('missing-cohort-members');
  expect(archive.activeId).toBeNull();
});

test('does not reuse a confirmation trial after the incumbent model changes', async () => {
  const model = createChallenger();
  const startedAt = trainedAt + contractDuration;
  const events = createChallengerEvents({ model, count: 2, startAt: startedAt + contractDuration });
  const archive = createLearningArchive({
    artifacts: [model],
    events: [...createTrainingSeed(), ...events],
    trials: [
      createConfirmation(model, startedAt, {
        productionModelId: 'previous-production',
        productionActivatedAt: trainedAt,
      }),
    ],
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: endOfEvents(events) + 1000,
  });
  const dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(/No challenger is currently in use/)).toBeVisible();
  expect(archive.trials[0].status).toBe('abandoned');
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement.reason).toBe(
    'Production changed during confirmation; this trial cannot be reused.',
  );
  expect(archive.activeId).toBeNull();
});

test('falls back immediately after an approved checkpoint deteriorates and persists retirement on analysis', async () => {
  const activationAt = trainedAt + contractDuration;
  const model = createChallenger({ activeAt: activationAt });
  const recorded = createChallengerEvents({
    model,
    count: 40,
    startAt: activationAt + contractDuration,
    improve: false,
    active: true,
  });
  const archive = createLearningArchive({
    artifacts: [model],
    activeId: model.id,
    events: [...createTrainingSeed(), ...recorded],
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: endOfEvents(recorded) + 1000,
  });
  let dialog = await openLearning(view.user);
  let candidate = await openCandidate(view.user, dialog);
  expect(candidate.getByText(/Active model monitoring: Suspended/)).toBeVisible();
  expect(dialog.getByText(/No learned adjustment is currently active/)).toBeVisible();
  expect(archive.activeId).toBe(model.id);
  expect(archive.repository.retireModelArtifact).not.toHaveBeenCalled();

  dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(/No challenger is currently in use/)).toBeVisible();
  expect(archive.activeId).toBeNull();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toMatchObject({
    wasActive: true,
  });
  expect(
    archive.events.filter((row) => row.event === 'decision' && row.learning?.modelId === model.id),
  ).toHaveLength(40);
});
