import { screen } from '@testing-library/react';
import { createLearningArchive } from '../helpers/learningArchive';
import {
  createLearningEvents,
  learningInterval,
  learningStart,
} from '../helpers/learningEvidenceFixtures';
import {
  analyzeLearning,
  openLearning,
  renderModelLearning,
  setupLearningTests,
} from '../helpers/learningTestHarness';
import {
  earlySection,
  expectEarlyCount,
  promoteEarlyThroughResearch,
  trainEarlyThroughResearch,
} from './helpers/earlyLearningControls';

setupLearningTests();

test('counts independent events once and fits a shadow correction only after the fortieth event', async () => {
  const events = createLearningEvents({ count: 39 });
  const extraCheckpoint = createLearningEvents({ count: 39, checkpointMinutes: 6 });
  const archive = createLearningArchive({ events: [...events, ...events, ...extraCheckpoint] });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: learningStart + 40 * learningInterval,
  });
  await analyzeLearning(view.user);
  expectEarlyCount('Available early training events', 39, 40);
  expect(earlySection().getByText('Collecting events.')).toBeVisible();
  expect(
    archive.artifacts.filter((model) => model.version === 'outcome-early-kalshi-v1'),
  ).toHaveLength(0);

  archive.addEvents(
    createLearningEvents({ count: 1, startAt: learningStart + 40 * learningInterval }),
  );
  await view.update(learningStart + 41 * learningInterval);
  await analyzeLearning(view.user);
  expectEarlyCount('Available early training events', 40, 40);
  expect(earlySection().getByText('Testing candidate.')).toBeVisible();
  expect(
    earlySection().getByText(/is experimental and does not change displayed predictions/),
  ).toBeVisible();
  expect(earlySection().getByText(/at most 5 percentage points/)).toHaveTextContent('20%');
  const model = archive.artifacts.find(
    (artifact) => artifact.version === 'outcome-early-kalshi-v1',
  );
  expect(model.evaluation.counts.trainingCheckpoints).toBe(79);
  expect(archive.activeId).toBeNull();
  await analyzeLearning(view.user);
  expect(
    archive.artifacts.filter((artifact) => artifact.version === 'outcome-early-kalshi-v1'),
  ).toEqual([model]);
  expectEarlyCount('Selected future events', 0, 40);
});

test('explains an imbalanced training archive and waits for enough outcomes from both sides', async () => {
  const events = createLearningEvents({ outcomeForIndex: (index) => (index < 7 ? 'no' : 'yes') });
  const archive = createLearningArchive({ events });
  const now = learningStart + 40 * learningInterval;
  const view = await renderModelLearning({ repository: archive.repository, now });
  await analyzeLearning(view.user);
  expectEarlyCount('Available early training events', 40, 40);
  expectEarlyCount('Yes training events', 33, 8);
  expectEarlyCount('No training events', 7, 8);
  expect(earlySection().getByText('Collecting events.')).toBeVisible();
  expect(archive.activeId).toBeNull();
  archive.addEvents(
    createLearningEvents({
      count: 1,
      startAt: now,
      probabilityForIndex: () => 0.4,
      outcomeForIndex: () => 'no',
    }),
  );
  await view.update(now + learningInterval);
  await analyzeLearning(view.user);
  expectEarlyCount('No training events', 8, 8);
  expect(earlySection().getByText('Testing candidate.')).toBeVisible();
  expect(archive.activeId).toBeNull();
});

test('keeps manual calls and a different price history out of the automatic native training cohort', async () => {
  const native = createLearningEvents({ count: 20 });
  const proxy = createLearningEvents({
    count: 20,
    startAt: learningStart + 20 * learningInterval,
    pipeline: { referenceSource: 'coinbase-proxy', featureInputSource: 'coinbase-candles' },
  });
  const manual = createLearningEvents({
    count: 20,
    startAt: learningStart + 40 * learningInterval,
  }).map((row) => ({ ...row, cohort: 'manual' }));
  const archive = createLearningArchive({ events: [...native, ...proxy, ...manual] });
  const now = learningStart + 60 * learningInterval;
  const view = await renderModelLearning({ repository: archive.repository, now });
  await analyzeLearning(view.user);
  expectEarlyCount('Available early training events', 20, 40);
  expect(earlySection().getByText('Collecting events.')).toBeVisible();
  expect(screen.getByText(/Training price history: BRTI/)).toBeVisible();
  archive.addEvents(createLearningEvents({ count: 20, startAt: now }));
  await view.update(now + 20 * learningInterval);
  await analyzeLearning(view.user);
  expectEarlyCount('Available early training events', 40, 40);
  expect(earlySection().getByText('Testing candidate.')).toBeVisible();
});

test('waits for the original forty future outcomes before activation instead of replacing a delayed result', async () => {
  const { archive, view, model, trainedAt } = await trainEarlyThroughResearch();
  const startAt = trainedAt + learningInterval;
  const future = createLearningEvents({ startAt, model, phase: 'shadow' });
  const delayedOutcome = future.splice(1, 1)[0];
  archive.addEvents(future);
  archive.addEvents(
    createLearningEvents({
      count: 10,
      startAt: startAt + 40 * learningInterval,
      model,
      phase: 'shadow',
    }),
  );
  const evaluationAt = startAt + 50 * learningInterval;
  await view.update(evaluationAt);
  await analyzeLearning(view.user);
  expectEarlyCount('Selected future events', 40, 40);
  expectEarlyCount('Scored validation predictions', 39, 40);
  expect(earlySection().getByText('Testing candidate.')).toBeVisible();
  expect(archive.activeId).toBeNull();

  archive.addEvents([{ ...delayedOutcome, recordedAt: evaluationAt }]);
  await view.update(evaluationAt + 1000);
  await analyzeLearning(view.user);
  expect(earlySection().getByText('Active limited adjustment.')).toBeVisible();
  expectEarlyCount('Selected future events', 40, 40);
  expectEarlyCount('Scored validation predictions', 40, 40);
  expect(archive.activeId).toBe(model.id);
  const active = archive.artifacts.find((artifact) => artifact.id === model.id);
  expect(active.activation.shadowEvaluation.lastDeadlineAt).toBe(
    startAt + 39 * learningInterval + 900_000,
  );
  expect(active.activation.shadowEvaluation.eligibleForPromotion).toBe(true);
  await view.reload();
  await openLearning(view.user);
  expect(earlySection().getByText('Active limited adjustment.')).toBeVisible();
  expect(screen.getByText(new RegExp(`Early learning model ${model.id}`))).toBeVisible();
});

test('rejects missing recorded shadow coverage and requires twenty genuinely new events before retraining', async () => {
  const { archive, view, model, trainedAt } = await trainEarlyThroughResearch();
  const startAt = trainedAt + learningInterval;
  const future = createLearningEvents({ startAt, model, phase: 'shadow' });
  delete future[0].earlyShadowPrediction;
  archive.addEvents(future);
  // Later complete predictions cannot replace the missing first-cohort slot.
  archive.addEvents(
    createLearningEvents({ startAt: startAt + 40 * learningInterval, model, phase: 'shadow' }),
  );
  const retiredAt = startAt + 80 * learningInterval;
  await view.update(retiredAt);
  await analyzeLearning(view.user);
  expect(
    earlySection().getByText(
      /The previous early candidate was not promoted|The first 40 eligible windows lack complete recorded coverage/,
    ),
  ).toHaveTextContent('Collect 20 new independent events');
  expect(archive.activeId).toBeNull();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toMatchObject({
    retiredAt,
  });
  await analyzeLearning(view.user);
  expect(
    archive.artifacts.filter((artifact) => artifact.version === 'outcome-early-kalshi-v1'),
  ).toHaveLength(1);

  archive.addEvents(createLearningEvents({ count: 19, startAt: retiredAt + learningInterval }));
  await view.update(retiredAt + 20 * learningInterval);
  await analyzeLearning(view.user);
  expect(earlySection().getByText('Collecting events.')).toBeVisible();
  expect(
    archive.artifacts.filter((artifact) => artifact.version === 'outcome-early-kalshi-v1'),
  ).toHaveLength(1);
  archive.addEvents(createLearningEvents({ count: 1, startAt: retiredAt + 20 * learningInterval }));
  await view.update(retiredAt + 21 * learningInterval);
  await analyzeLearning(view.user);
  expect(earlySection().getByText('Testing candidate.')).toBeVisible();
  expect(
    archive.artifacts.filter((artifact) => artifact.version === 'outcome-early-kalshi-v1'),
  ).toHaveLength(2);
  expect(archive.activeId).toBeNull();
});

test('rejects a complete prospective cohort whose bounded correction worsens its recorded outcomes', async () => {
  const { archive, view, model, trainedAt } = await trainEarlyThroughResearch();
  const startAt = trainedAt + learningInterval;
  archive.addEvents(
    createLearningEvents({
      startAt,
      model,
      phase: 'shadow',
      outcomeForIndex: (index) => (index % 2 ? 'yes' : 'no'),
    }),
  );
  await view.update(startAt + 40 * learningInterval);
  await analyzeLearning(view.user);
  expect(
    earlySection().getByText(
      /paired 95% probability-error interval does not establish improvement/,
    ),
  ).toBeVisible();
  expect(archive.activeId).toBeNull();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toBeDefined();
});

test('shows healthy post-activation checks only for forty matching recorded uses', async () => {
  const { archive, view, model, activatedAt } = await promoteEarlyThroughResearch();
  const startAt = activatedAt + learningInterval;
  const uses = createLearningEvents({ startAt, model, phase: 'active' });
  archive.addEvents(uses.slice(0, -2));
  await view.update(startAt + 40 * learningInterval);
  await analyzeLearning(view.user);
  expect(
    earlySection().getByText(
      /Forty recent independent windows with matching recorded probabilities/,
    ),
  ).toBeVisible();
  expect(archive.activeId).toBe(model.id);
  archive.addEvents(uses.slice(-2));
  await view.update(startAt + 40 * learningInterval + 1000);
  await analyzeLearning(view.user);
  expect(
    earlySection().getByText(/latest 40 matched independent windows remain within/),
  ).toBeVisible();
  expect(earlySection().getByRole('table', { name: /Early model after activation/ })).toBeVisible();
  expect(archive.activeId).toBe(model.id);
});

test('suspends a degraded active adjustment and keeps it suspended after reload', async () => {
  const { archive, view, model, activatedAt } = await promoteEarlyThroughResearch();
  const startAt = activatedAt + learningInterval;
  archive.addEvents(
    createLearningEvents({
      startAt,
      model,
      phase: 'active',
      outcomeForIndex: (index) => (index % 2 ? 'yes' : 'no'),
    }),
  );
  const reviewAt = startAt + 40 * learningInterval;
  await view.update(reviewAt);
  await analyzeLearning(view.user);
  expect(earlySection().getByText('Adjustment suspended.')).toBeVisible();
  expect(earlySection().getByRole('status')).toHaveTextContent(
    'Recent probability error exceeds the baseline',
  );
  expect(archive.activeId).toBeNull();
  expect(archive.artifacts.find((artifact) => artifact.id === model.id).retirement).toMatchObject({
    retiredAt: reviewAt,
    wasActive: true,
  });
  await view.reload();
  await openLearning(view.user);
  expect(earlySection().getByText('Adjustment suspended.')).toBeVisible();
  expect(
    screen.getByText(/The early adjustment is suspended after its latest outcome check/),
  ).toBeVisible();
});
