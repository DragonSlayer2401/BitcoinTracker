import { screen, within } from '@testing-library/react';
import { createLearningArchive } from '../../helpers/learningArchive';
import {
  createLearningEvents,
  learningInterval,
  learningStart,
} from '../../helpers/learningEvidenceFixtures';
import { analyzeLearning, renderModelLearning } from '../../helpers/learningTestHarness';

export const earlySection = () => within(screen.getByRole('region', { name: 'Early learning' }));

export const expectEarlyCount = (label, count, minimum) => {
  const term = earlySection().getByText(label);
  expect(term.parentElement).toHaveTextContent(`${label}${count} / ${minimum}`);
};

export const trainEarlyThroughResearch = async () => {
  const archive = createLearningArchive({ events: createLearningEvents() });
  const trainedAt = learningStart + 40 * learningInterval;
  const view = await renderModelLearning({ repository: archive.repository, now: trainedAt });
  await analyzeLearning(view.user);
  expect(earlySection().getByText('Testing candidate.')).toBeVisible();
  const model = archive.artifacts.find(
    (artifact) => artifact.version === 'outcome-early-kalshi-v1',
  );
  expect(model).toBeDefined();
  expect(archive.activeId).toBeNull();
  return { archive, view, model, trainedAt };
};

export const promoteEarlyThroughResearch = async () => {
  const scenario = await trainEarlyThroughResearch();
  const startAt = scenario.trainedAt + learningInterval;
  scenario.archive.addEvents(
    createLearningEvents({ startAt, model: scenario.model, phase: 'shadow' }),
  );
  const activatedAt = startAt + 40 * learningInterval;
  await scenario.view.update(activatedAt);
  await analyzeLearning(scenario.view.user);
  expect(earlySection().getByText('Active limited adjustment.')).toBeVisible();
  expect(scenario.archive.activeId).toBe(scenario.model.id);
  return {
    ...scenario,
    model: scenario.archive.artifacts.find((artifact) => artifact.id === scenario.model.id),
    activatedAt,
  };
};
