import { screen } from '@testing-library/react';
import {
  analyzeLearning,
  closeLearning,
  openLearning,
  renderModelLearning,
  setupLearningTests,
} from '../helpers/learningTestHarness';
import { createLearningArchive } from '../helpers/learningArchive';
import { learningInterval, learningStart } from '../helpers/learningEvidenceFixtures';
import {
  createActiveFullModel,
  createFullLearningEvents,
  createStoredFullCandidate,
  createSupersededEarlyScenario,
  fullTrainingAt,
  modelEventsEnd,
} from './helpers/fullLearningFixtures';
import { expectBaselineInUse, expectLearningCount } from './helpers/fullLearningControls';

setupLearningTests();

test('reports independent training windows without inflating them for duplicate archive observations', async () => {
  const events = createFullLearningEvents({ count: 200 });
  const duplicates = events.map((event) => ({ ...event, eventId: `duplicate-${event.eventId}` }));
  const archive = createLearningArchive({ events: [...events, ...duplicates] });
  const view = await renderModelLearning({ repository: archive.repository, now: fullTrainingAt });
  let dialog = await openLearning(view.user);
  expectLearningCount(dialog, 'Training windows', '100 / 120');
  expectLearningCount(dialog, 'Calibration windows', '50 / 60');
  expectLearningCount(dialog, 'Later test windows', '50 / 60');
  dialog = await analyzeLearning(view.user);
  expectBaselineInUse(dialog);
  expectLearningCount(dialog, 'Training windows', '100 / 120');
  expect(
    archive.artifacts.filter((model) => model.version === 'outcome-logistic-kalshi-v2'),
  ).toEqual([]);
});

test('keeps native BRTI training separate when more recent proxy observations arrive', async () => {
  const events = createFullLearningEvents({ count: 200 });
  const proxy = createFullLearningEvents({
    count: 100,
    startAt: learningStart + 200 * learningInterval,
    pipeline: { referenceSource: 'coinbase-proxy', featureInputSource: 'coinbase-candles' },
  });
  const archive = createLearningArchive({ events: [...events, ...proxy] });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: modelEventsEnd(proxy),
  });
  const dialog = await analyzeLearning(view.user);
  expectLearningCount(dialog, 'Training windows', '100 / 120');
  expectLearningCount(dialog, 'Calibration windows', '50 / 60');
  expect(dialog.getByText(/Training price history:/)).toHaveTextContent(
    'Training price history: BRTI',
  );
  expectBaselineInUse(dialog);
  expect(
    archive.artifacts.filter((model) => model.version === 'outcome-logistic-kalshi-v2'),
  ).toEqual([]);
});

test('excludes a calibration window when the last training outcome was published after it started', async () => {
  const events = createFullLearningEvents();
  events[119 * 2 + 1].recordedAt = learningStart + 120 * learningInterval + 1000;
  const archive = createLearningArchive({ events });
  const view = await renderModelLearning({ repository: archive.repository, now: fullTrainingAt });
  const dialog = await analyzeLearning(view.user);
  expectLearningCount(dialog, 'Training windows', '120 / 120');
  expectLearningCount(dialog, 'Calibration windows', '59 / 60');
  expectLearningCount(dialog, 'Later test windows', '60 / 60');
  expectBaselineInUse(dialog);
  expect(
    archive.artifacts.filter((model) => model.version === 'outcome-logistic-kalshi-v2'),
  ).toEqual([]);
});

test('fits and saves a full model through Analyze while keeping it shadow-only until future evidence arrives', async () => {
  const archive = createLearningArchive({ events: createFullLearningEvents() });
  const view = await renderModelLearning({ repository: archive.repository, now: fullTrainingAt });
  let dialog = await openLearning(view.user);
  expect(
    dialog.getByText(/Enough independent windows are available to attempt training/),
  ).toBeVisible();
  dialog = await analyzeLearning(view.user);
  const model = archive.artifacts.find(
    (artifact) => artifact.version === 'outcome-logistic-kalshi-v2',
  );
  expect(model).toMatchObject({
    status: 'shadow',
    evaluation: { eligibleForShadow: true, counts: { training: 120, calibration: 60, test: 60 } },
  });
  expect(model.activation).toBeUndefined();
  expect(model.trainingCutoffAt).toBeLessThan(model.calibrationCutoffAt);
  expect(model.calibrationCutoffAt).toBeLessThan(model.evaluationCutoffAt);
  expect(
    dialog.getByText(new RegExp(`Candidate ${model.id} is being tested alongside`)),
  ).toBeVisible();
  expectLearningCount(dialog, 'Future shadow windows', '0 / 120');
  expectBaselineInUse(dialog);
  await closeLearning(view.user);
  await view.reload();
  dialog = await openLearning(view.user);
  expect(
    dialog.getByText(new RegExp(`Candidate ${model.id} is being tested alongside`)),
  ).toBeVisible();
  expectBaselineInUse(dialog);
});

test('rejects a fitted candidate that fails untouched later windows and keeps the baseline available', async () => {
  const archive = createLearningArchive({
    events: createFullLearningEvents({
      outcomeForIndex: (index) => (index < 180 ? index % 2 : 1 - (index % 2)),
    }),
  });
  const view = await renderModelLearning({ repository: archive.repository, now: fullTrainingAt });
  const dialog = await analyzeLearning(view.user);
  expectBaselineInUse(dialog);
  expect(
    dialog.getAllByText(
      /Candidate does not improve accuracy over the current model at the same capture times/,
    ).length,
  ).toBeGreaterThan(0);
  const model = archive.artifacts.find(
    (artifact) => artifact.version === 'outcome-logistic-kalshi-v2',
  );
  expect(model.evaluation.eligibleForShadow).toBe(false);
  expect(model.activation).toBeUndefined();
  expect(
    dialog.queryByText(new RegExp(`Candidate ${model.id} is being tested alongside`)),
  ).not.toBeInTheDocument();
});

test('holds a delayed selected outcome in its original slot and promotes only after all 120 future windows resolve', async () => {
  const model = createStoredFullCandidate();
  const future = createFullLearningEvents({
    count: 121,
    startAt: fullTrainingAt + learningInterval,
    model,
    phase: 'shadow',
  });
  const delayed = future[119 * 2 + 1];
  const archive = createLearningArchive({
    events: [...createFullLearningEvents(), ...future.filter((event) => event !== delayed)],
    artifacts: [model],
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: modelEventsEnd(future),
  });
  let dialog = await analyzeLearning(view.user);
  expectLearningCount(dialog, 'Future shadow windows', '119 / 120');
  expectBaselineInUse(dialog);
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).activation).toBeUndefined();
  archive.addEvents([delayed]);
  dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(new RegExp(`^Learned model ${model.id}\\.`))).toBeVisible();
  expect(
    dialog.getByText(
      /The candidate passed the predeclared checks on independent future background windows/,
    ),
  ).toBeVisible();
  expect(
    archive.artifacts.find((artifact) => artifact.id === model.id).activation.shadowEvaluation,
  ).toMatchObject({ eligibleForPromotion: true, independentWindows: 120, callCoverage: 1 });
});

test('does not repair missing prospective predictions by replacing the first validation group with later wins', async () => {
  const model = createStoredFullCandidate();
  const future = createFullLearningEvents({
    count: 120,
    startAt: fullTrainingAt + learningInterval,
    model,
    phase: 'shadow',
  });
  delete future[0].shadowPrediction;
  const archive = createLearningArchive({
    events: [...createFullLearningEvents(), ...future],
    artifacts: [model],
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: modelEventsEnd(future),
  });
  let dialog = await openLearning(view.user);
  expectLearningCount(dialog, 'Future shadow windows', '119 / 120');
  expect(
    dialog.getAllByText(/first 120 eligible windows lack complete candidate coverage/).length,
  ).toBeGreaterThan(0);
  expectBaselineInUse(dialog);
  const later = createFullLearningEvents({
    count: 20,
    startAt: fullTrainingAt + 122 * learningInterval,
    model,
    phase: 'shadow',
  });
  archive.addEvents(later);
  await closeLearning(view.user);
  await view.update(modelEventsEnd(later));
  dialog = await openLearning(view.user);
  expectLearningCount(dialog, 'Future shadow windows', '119 / 120');
  expect(
    dialog.getAllByText(/first 120 eligible windows lack complete candidate coverage/).length,
  ).toBeGreaterThan(0);
  expectBaselineInUse(dialog);
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).activation).toBeUndefined();
});

test('keeps incomplete monitoring pending then suspends and durably retires a deteriorated active model', async () => {
  const model = createActiveFullModel();
  const future = createFullLearningEvents({
    count: 120,
    startAt: model.activation.activatedAt + learningInterval,
    model,
    phase: 'active',
    outcomeForIndex: (index) => 1 - (index % 2),
  });
  const delayed = future.at(-1);
  const archive = createLearningArchive({
    events: future.filter((event) => event !== delayed),
    artifacts: [model],
    activeId: model.id,
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: modelEventsEnd(future),
  });
  let dialog = await openLearning(view.user);
  expect(dialog.getByText(new RegExp(`^Learned model ${model.id}\\.`))).toBeVisible();
  expect(
    dialog.getByText(
      /Full model outcome check: Wait for all 120 selected independent official outcomes/,
    ),
  ).toBeVisible();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toBeUndefined();
  archive.addEvents([delayed]);
  await closeLearning(view.user);
  await view.reload();
  dialog = await openLearning(view.user);
  expect(
    dialog.getByText(/full learned model is suspended after its latest outcome check/),
  ).toBeVisible();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toBeUndefined();
  dialog = await analyzeLearning(view.user);
  expect(
    dialog.getByText(/full learned model is suspended after its latest outcome check/),
  ).toBeVisible();
  expect(
    dialog.getByText(/Full model outcome check: The paired 95% interval shows probability error/),
  ).toBeVisible();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toMatchObject({
    wasActive: true,
  });
  expect(archive.artifacts).toHaveLength(1);
});

test('retains a healthy active full model after reviewing matched post-activation outcomes', async () => {
  const model = createActiveFullModel();
  const events = createFullLearningEvents({
    count: 120,
    startAt: model.activation.activatedAt + learningInterval,
    model,
    phase: 'active',
  });
  const archive = createLearningArchive({ events, artifacts: [model], activeId: model.id });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: modelEventsEnd(events),
  });
  const dialog = await analyzeLearning(view.user);
  expect(dialog.getByText(new RegExp(`^Learned model ${model.id}\\.`))).toBeVisible();
  expect(
    dialog.getByText(
      /Full model outcome check: The latest 120 matched windows do not establish deterioration/,
    ),
  ).toBeVisible();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toBeUndefined();
  expect(
    screen.queryByText('Research needs attention · see Research data'),
  ).not.toBeInTheDocument();
});

test('waits for 60 new independent windows before fitting another rejected full candidate', async () => {
  const archive = createLearningArchive({
    events: createFullLearningEvents({
      outcomeForIndex: (index) => (index >= 220 ? 1 - (index % 2) : index % 2),
    }),
  });
  const view = await renderModelLearning({ repository: archive.repository, now: fullTrainingAt });
  await analyzeLearning(view.user);
  const original = archive.artifacts.find(
    (artifact) => artifact.version === 'outcome-logistic-kalshi-v2',
  );
  expect(original.evaluation.eligibleForShadow).toBe(false);

  const future = createFullLearningEvents({
    count: 60,
    startAt: fullTrainingAt + learningInterval,
  });
  archive.addEvents(future.slice(0, -2));
  await view.update(modelEventsEnd(future.slice(0, -2)));
  let dialog = await analyzeLearning(view.user);
  expect(
    dialog.getByText(
      'Last analysis: Collect 60 new independent windows before fitting another candidate.',
    ),
  ).toBeVisible();
  expect(archive.artifacts.filter((artifact) => artifact.version === original.version)).toEqual([
    original,
  ]);
  expectBaselineInUse(dialog);

  archive.addEvents(future.slice(-2));
  await view.update(modelEventsEnd(future));
  dialog = await analyzeLearning(view.user);
  const replacements = archive.artifacts.filter(
    (artifact) => artifact.version === original.version,
  );
  expect(replacements).toHaveLength(2);
  expect(replacements[0]).toEqual(original);
  expect(replacements[1].trainedAt).toBe(modelEventsEnd(future));
  expectLearningCount(dialog, 'Training windows', '150 / 120');
  expectLearningCount(dialog, 'Calibration windows', '75 / 60');
  expectLearningCount(dialog, 'Later test windows', '75 / 60');
  expectBaselineInUse(dialog);
});

test('keeps the full model in use when an older early correction has enough passing future evidence', async () => {
  const fullModel = createActiveFullModel();
  const early = createSupersededEarlyScenario(fullModel);
  const archive = createLearningArchive({
    events: early.events,
    artifacts: [early.model, fullModel],
    activeId: fullModel.id,
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: modelEventsEnd(early.events),
  });
  let dialog = await openLearning(view.user);
  expect(dialog.getByText('Full model in use.')).toBeVisible();
  expect(dialog.getByText(new RegExp(`^Learned model ${fullModel.id}\\.`))).toBeVisible();
  dialog = await analyzeLearning(view.user);
  expect(dialog.getByText('Full model in use.')).toBeVisible();
  expect(dialog.getByText(new RegExp(`^Learned model ${fullModel.id}\\.`))).toBeVisible();
  expect(archive.activeId).toBe(fullModel.id);
  expect(
    archive.artifacts.find((artifact) => artifact.id === early.model.id).activation,
  ).toBeUndefined();
  expect(archive.writes.filter((write) => write.type === 'activated')).toEqual([]);
});
