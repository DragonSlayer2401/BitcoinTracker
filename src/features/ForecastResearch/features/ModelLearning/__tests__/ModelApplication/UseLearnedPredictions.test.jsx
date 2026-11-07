import { act, screen, waitFor } from '@testing-library/react';
import { isOutcomeModelArtifact } from '../../utils/model.utils';
import { createLearningArchive } from '../helpers/learningArchive';
import { eventStart, eventEnd } from '../helpers/learningMarketFixtures';
import { learningRequests } from '../helpers/learningServer';
import { renderModelLearning, setupLearningTests } from '../helpers/learningTestHarness';
import { createStoredOutcomeModel } from './helpers/storedOutcomeModel';
import {
  expectKnownProbability,
  fixedCheckpoint,
  liveEstimate,
} from './helpers/modelApplicationControls';

setupLearningTests();
afterEach(() => jest.useRealTimers());

test('keeps a fetched shadow candidate out of the live estimate until a later session activates it', async () => {
  const model = createStoredOutcomeModel();
  expect(isOutcomeModelArtifact(model)).toBe(true);
  const { activation, ...candidate } = model;
  const archive = createLearningArchive({ artifacts: [candidate] });
  const view = await renderModelLearning({ repository: archive.repository });
  await waitFor(() =>
    expect(learningRequests.find((request) => request.path === 'models')?.completed).toBe(true),
  );
  const baseline = liveEstimate().getByRole('img').getAttribute('aria-label');
  expect(liveEstimate().queryByText(/Learned model/)).not.toBeInTheDocument();
  expect(learningRequests.find((request) => request.path === 'models').response.body).toMatchObject(
    { active: null, candidate: { id: candidate.id } },
  );

  // Another recording session approves this stored artifact. A page reload must
  // read the new archive state through the real model endpoint and hook.
  archive.artifacts[0].activation = activation;
  archive.setActive(model.id);
  await view.reload();
  await waitFor(() => expectKnownProbability(70));
  expect(liveEstimate().getByRole('img')).not.toHaveAttribute('aria-label', baseline);
  expect(liveEstimate().getByTitle(`Outcome model ${model.id}`)).toBeVisible();
});

test('preserves a manually saved probability when the active archive model changes and is later retired', async () => {
  const model = createStoredOutcomeModel();
  const archive = createLearningArchive({ artifacts: [model], activeId: model.id });
  const view = await renderModelLearning({ repository: archive.repository, lock: 'owner' });
  await waitFor(() => expectKnownProbability(70));
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(eventEnd - 9 * 60_000);
  expect(fixedCheckpoint(9)).toHaveTextContent(/Yes · 70.0%.*Saved/);

  const replacement = createStoredOutcomeModel({ probability: 0.8, name: 'replacement-fixture' });
  archive.artifacts.push(replacement);
  archive.setActive(replacement.id);
  await view.reload();
  await waitFor(() => expectKnownProbability(80));
  expect(fixedCheckpoint(9)).toHaveTextContent(/Yes · 70.0%.*Saved/);

  await archive.repository.retireModelArtifact(replacement.id, {
    retiredAt: eventEnd - 9 * 60_000,
    reason: 'Later outcome checks suspended the adjustment.',
  });
  const previousModelRequests = learningRequests.filter(
    (request) => request.path === 'models',
  ).length;
  await view.reload();
  await waitFor(() =>
    expect(
      learningRequests
        .filter((request) => request.path === 'models')
        .slice(previousModelRequests)
        .some((request) => request.completed && request.response.body.active === null),
    ).toBe(true),
  );
  await waitFor(() => expect(liveEstimate().queryByText(/Learned model/)).not.toBeInTheDocument());
  expect(liveEstimate().getByRole('img')).not.toHaveAccessibleName(
    'Yes · at or above 80.0%, No · below 20.0%',
  );
  expect(fixedCheckpoint(9)).toHaveTextContent(/Yes · 70.0%.*Saved/);
});

test('uses baseline probabilities for an unsupported proxy input and resumes the fetched learned model after reconnection', async () => {
  const model = createStoredOutcomeModel();
  const archive = createLearningArchive({ artifacts: [model], activeId: model.id });
  const view = await renderModelLearning({ repository: archive.repository });
  await waitFor(() => expectKnownProbability(70));
  await view.update(eventStart + 1000, { benchmark: null });
  expect(
    screen.getByText('Coinbase proxy · BRTI access needed for the settlement feed'),
  ).toBeVisible();
  expect(liveEstimate().queryByText(/Learned model/)).not.toBeInTheDocument();
  expect(
    liveEstimate().queryByRole('heading', { name: 'Estimate paused' }),
  ).not.toBeInTheDocument();
  expect(liveEstimate().getByRole('img')).not.toHaveAccessibleName(
    'Yes · at or above 70.0%, No · below 30.0%',
  );
  expect(archive.activeId).toBe(model.id);
  await view.update(eventStart + 2000);
  expectKnownProbability(70);
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
});

test('refreshes active model changes and retirement on the real model query polling schedule', async () => {
  jest.useFakeTimers({
    now: eventStart,
    doNotFake: ['performance', 'nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
  });
  const model = createStoredOutcomeModel();
  const { activation, ...candidate } = model;
  const archive = createLearningArchive({ artifacts: [candidate] });
  const view = await renderModelLearning({ repository: archive.repository });
  await waitFor(() =>
    expect(
      learningRequests.filter((request) => request.path === 'models' && request.completed),
    ).toHaveLength(1),
  );
  expect(liveEstimate().queryByText(/Learned model/)).not.toBeInTheDocument();
  archive.artifacts[0].activation = activation;
  archive.setActive(model.id);
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  await view.update(eventStart + 60_000);
  await waitFor(() => expectKnownProbability(70));
  expect(
    learningRequests.filter((request) => request.path === 'models' && request.completed),
  ).toHaveLength(2);

  await archive.repository.retireModelArtifact(model.id, {
    retiredAt: eventStart + 60_000,
    reason: 'The stored model was suspended.',
  });
  await act(async () => jest.advanceTimersByTimeAsync(60_000));
  await view.update(eventStart + 120_000);
  await waitFor(() => expect(liveEstimate().queryByText(/Learned model/)).not.toBeInTheDocument());
  expect(
    learningRequests.filter((request) => request.path === 'models' && request.completed),
  ).toHaveLength(3);
  expect(liveEstimate().getByRole('img')).not.toHaveAccessibleName(
    'Yes · at or above 70.0%, No · below 30.0%',
  );
});
