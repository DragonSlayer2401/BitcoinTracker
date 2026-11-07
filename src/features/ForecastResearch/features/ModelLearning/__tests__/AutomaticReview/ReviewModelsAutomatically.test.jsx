import { act, screen, waitFor } from '@testing-library/react';
import { createLearningArchive } from '../helpers/learningArchive';
import { eventStart } from '../helpers/learningMarketFixtures';
import {
  closeLearning,
  openLearning,
  renderModelLearning,
  setupLearningTests,
} from '../helpers/learningTestHarness';
import {
  learningRequests,
  pauseLearningRequest,
  releaseLearningRequest,
  setLearningResponse,
} from '../helpers/learningServer';

setupLearningTests();

test('waits for the initial model response before reviewing and continues periodic review with the dialog closed', async () => {
  const archive = createLearningArchive();
  pauseLearningRequest('models');
  const view = await renderModelLearning({ repository: archive.repository, lock: 'owner' });
  await openLearning(view.user);
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(0);
  await act(async () => releaseLearningRequest('models'));
  await waitFor(() =>
    expect(
      learningRequests.filter((request) => request.path === 'models' && request.completed),
    ).toHaveLength(2),
  );
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(1);
  await closeLearning(view.user);
  await view.update(eventStart + 15 * 60_000 - 1);
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(1);
  await view.update(eventStart + 15 * 60_000);
  await waitFor(() =>
    expect(
      learningRequests.filter((request) => request.path === 'analyze' && request.completed),
    ).toHaveLength(2),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(2);
});

test('keeps a following tab from automatic review until it acquires recording ownership', async () => {
  const archive = createLearningArchive();
  const view = await renderModelLearning({ repository: archive.repository });
  await openLearning(view.user);
  await closeLearning(view.user);
  await view.update(eventStart + 15 * 60_000);
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(0);
  await view.acquireOwnership();
  await waitFor(() =>
    expect(
      learningRequests.filter((request) => request.path === 'analyze' && request.completed),
    ).toHaveLength(1),
  );
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(1);
});

test('retains baseline estimates after model access fails and resumes review after the user reloads', async () => {
  setLearningResponse('models', {
    status: 503,
    body: { error: 'Models temporarily unavailable.' },
  });
  const view = await renderModelLearning({ lock: 'owner' });
  await openLearning(view.user);
  expect(screen.getByRole('region', { name: 'Live estimate' })).toHaveTextContent('Price only');
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(0);
  setLearningResponse('models');
  await view.reload();
  await waitFor(() =>
    expect(
      learningRequests.filter((request) => request.path === 'analyze' && request.completed),
    ).toHaveLength(1),
  );
  expect(screen.getByRole('region', { name: 'Live estimate' })).toBeVisible();
});

test('shows automatic review failure and clears the warning after the next scheduled successful cycle', async () => {
  setLearningResponse('analyze', { status: 503, body: { error: 'Learning archive is offline.' } });
  const view = await renderModelLearning({ lock: 'owner' });
  expect(await screen.findByText('Research needs attention · see Research data')).toBeVisible();
  const dialog = await openLearning(view.user);
  expect(dialog.getByRole('alert')).toHaveTextContent('Learning archive is offline.');
  setLearningResponse('analyze');
  await closeLearning(view.user);
  await view.update(eventStart + 15 * 60_000 - 1);
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(1);
  await view.update(eventStart + 15 * 60_000);
  await waitFor(() =>
    expect(
      screen.queryByText('Research needs attention · see Research data'),
    ).not.toBeInTheDocument(),
  );
  expect((await openLearning(view.user)).queryByRole('alert')).not.toBeInTheDocument();
});

test('shares the same running cycle when a user requests analysis during automatic review', async () => {
  const archive = createLearningArchive();
  const view = await renderModelLearning({ repository: archive.repository });
  const dialog = await openLearning(view.user);
  let finishRead;
  const databaseRead = new Promise((resolve) => {
    finishRead = resolve;
  });
  archive.repository.getLearningEvidenceRows.mockImplementationOnce(async () => {
    await databaseRead;
    return [];
  });
  await view.acquireOwnership();
  await waitFor(() =>
    expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(1),
  );
  await view.user.click(dialog.getByRole('button', { name: 'Analyze saved forecasts' }));
  expect(dialog.getByRole('button', { name: 'Analyzing…' })).toBeDisabled();
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(2);
  expect(archive.repository.acquireLearningLease).toHaveBeenCalledTimes(1);
  await act(async () => finishRead());
  await waitFor(() =>
    expect(dialog.getByRole('button', { name: 'Analyze saved forecasts' })).toBeEnabled(),
  );
  expect(dialog.getByText(/Last analysis:/)).toBeVisible();
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(1);
});
