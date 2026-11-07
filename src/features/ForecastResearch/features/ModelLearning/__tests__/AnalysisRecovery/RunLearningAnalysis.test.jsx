import { act, screen, waitFor, within } from '@testing-library/react';
import { createLearningArchive } from '../helpers/learningArchive';
import {
  createLearningEvents,
  learningStart,
  learningInterval,
} from '../helpers/learningEvidenceFixtures';
import {
  analyzeLearning,
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

test('reloads the learning report when archive access recovers after opening the dialog failed', async () => {
  const archive = createLearningArchive({ events: createLearningEvents() });
  setLearningResponse('analysis', {
    status: 503,
    body: { error: 'Archive report could not be read.' },
  });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: learningStart + 40 * learningInterval,
  });
  const failed = await openLearning(view.user);
  expect(failed.getByRole('alert')).toHaveTextContent('Archive report could not be read.');
  expect(failed.queryByText('Loading archive analysis…')).not.toBeInTheDocument();
  expect(failed.getByRole('button', { name: 'Analyze saved forecasts' })).toBeEnabled();
  expect(archive.writes).toEqual([]);
  await closeLearning(view.user);
  setLearningResponse('analysis');
  const recovered = await openLearning(view.user);
  expect(recovered.queryByRole('alert')).not.toBeInTheDocument();
  expect(recovered.getByText('Ready to train.')).toBeVisible();
  expect(archive.writes).toEqual([]);
  await analyzeLearning(view.user);
  expect(recovered.getByText('Testing candidate.')).toBeVisible();
});

test('waits for archive loading and prevents duplicate analysis while the requested cycle is running', async () => {
  const archive = createLearningArchive();
  pauseLearningRequest('analysis');
  const view = await renderModelLearning({ repository: archive.repository });
  await view.user.click(screen.getByRole('button', { name: 'Research data' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Forecast research and learning' }));
  expect(dialog.getByText('Loading archive analysis…')).toBeVisible();
  expect(dialog.getByRole('button', { name: 'Analyze saved forecasts' })).toBeDisabled();
  await act(async () => releaseLearningRequest('analysis'));
  await waitFor(() =>
    expect(dialog.getByRole('button', { name: 'Analyze saved forecasts' })).toBeEnabled(),
  );
  expect(dialog.getByText(/No learned adjustment is currently active/)).toBeVisible();
  pauseLearningRequest('analyze');
  await view.user.dblClick(dialog.getByRole('button', { name: 'Analyze saved forecasts' }));
  expect(dialog.getByRole('button', { name: 'Analyzing…' })).toBeDisabled();
  expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(1);
  await act(async () => releaseLearningRequest('analyze'));
  await waitFor(() =>
    expect(dialog.getByRole('button', { name: 'Analyze saved forecasts' })).toBeEnabled(),
  );
  expect(dialog.getByText(/Last analysis:/)).toBeVisible();
  expect(dialog.getByText('Collecting events.')).toBeVisible();
  expect(archive.repository.acquireLearningLease).toHaveBeenCalledTimes(1);
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(1);
  expect(archive.artifacts).toEqual([]);
});

test.each([
  [
    'sign-in expiry',
    { status: 401 },
    'Research sign-in is required. Open the archive sign-in link, then retry.',
  ],
  [
    'network outage',
    new TypeError('The research connection was lost.'),
    'The research connection was lost.',
  ],
  [
    'archive outage',
    { status: 503, body: { error: 'The archive is temporarily unavailable.' } },
    'The archive is temporarily unavailable.',
  ],
])(
  'retries manual analysis after %s without discarding the displayed model report',
  async (_scenario, failure, message) => {
    const archive = createLearningArchive();
    const view = await renderModelLearning({ repository: archive.repository });
    const dialog = await openLearning(view.user);
    expect(dialog.getByText(/No learned adjustment is currently active/)).toBeVisible();
    setLearningResponse('analyze', failure);
    await analyzeLearning(view.user);
    expect(dialog.getByRole('alert')).toHaveTextContent(message);
    expect(dialog.getByRole('link', { name: 'Check archive access' })).toHaveAttribute(
      'href',
      '/api/research/status',
    );
    expect(dialog.getByText(/No learned adjustment is currently active/)).toBeVisible();
    expect(archive.writes).toEqual([]);
    setLearningResponse('analyze');
    await analyzeLearning(view.user);
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
    expect(dialog.getByText(/Last analysis:/)).toBeVisible();
    expect(learningRequests.filter((request) => request.path === 'analyze')).toHaveLength(2);
  },
);

test('reports an analysis already running elsewhere and trains only after that lease becomes available', async () => {
  const archive = createLearningArchive({ events: createLearningEvents() });
  archive.setLeaseAvailable(false);
  const view = await renderModelLearning({
    repository: archive.repository,
    now: learningStart + 40 * learningInterval,
  });
  const dialog = await analyzeLearning(view.user);
  expect(
    dialog.getByText('Last analysis: Another analysis cycle is already running.'),
  ).toBeVisible();
  expect(archive.artifacts).toEqual([]);
  expect(archive.repository.releaseLearningLease).not.toHaveBeenCalled();
  archive.setLeaseAvailable(true);
  await analyzeLearning(view.user);
  expect(dialog.getByText('Testing candidate.')).toBeVisible();
  expect(archive.artifacts.some((artifact) => artifact.version === 'outcome-early-kalshi-v1')).toBe(
    true,
  );
  expect(archive.activeId).toBeNull();
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(1);
});

test('releases a failed analysis lease and allows the user to retry the original saved evidence', async () => {
  const archive = createLearningArchive({ events: createLearningEvents({ count: 39 }) });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: learningStart + 40 * learningInterval,
  });
  const dialog = await openLearning(view.user);
  const saved = JSON.stringify(archive.events);
  archive.repository.getLearningEvidenceRows.mockRejectedValueOnce(
    new Error('Archive read interrupted.'),
  );
  await analyzeLearning(view.user);
  expect(dialog.getByRole('alert')).toHaveTextContent('Archive read interrupted.');
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(archive.events)).toBe(saved);
  await analyzeLearning(view.user);
  expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  expect(dialog.getByText('Collecting events.')).toBeVisible();
  expect(archive.artifacts).toEqual([]);
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(2);
});

test('keeps learning inactive after a candidate save fails and retries without losing its evidence', async () => {
  const archive = createLearningArchive({ events: createLearningEvents() });
  const view = await renderModelLearning({
    repository: archive.repository,
    now: learningStart + 40 * learningInterval,
  });
  const dialog = await openLearning(view.user);
  const savedEvidence = JSON.stringify(archive.events);
  archive.repository.writeModelArtifact.mockRejectedValueOnce(
    new Error('The model archive is read-only.'),
  );
  await analyzeLearning(view.user);
  expect(dialog.getByRole('alert')).toHaveTextContent('The model archive is read-only.');
  expect(dialog.getByText(/No learned adjustment is currently active/)).toBeVisible();
  expect(archive.artifacts).toEqual([]);
  expect(archive.activeId).toBeNull();
  expect(archive.repository.releaseLearningLease).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(archive.events)).toBe(savedEvidence);

  await analyzeLearning(view.user);
  expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  expect(dialog.getByText('Testing candidate.')).toBeVisible();
  expect(
    archive.artifacts.filter((artifact) => artifact.version === 'outcome-early-kalshi-v1'),
  ).toHaveLength(1);
  expect(archive.activeId).toBeNull();
  expect(JSON.stringify(archive.events)).toBe(savedEvidence);
});
