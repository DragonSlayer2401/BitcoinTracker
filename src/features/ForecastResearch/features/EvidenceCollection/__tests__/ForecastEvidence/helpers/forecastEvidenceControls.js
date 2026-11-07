import { screen, waitFor, within } from '@testing-library/react';
import { closeResearch, exportPendingEvidence } from '../../helpers/evidenceTestHarness';

export const exportManualEvidence = async (user) => {
  const rows = await exportPendingEvidence(user);
  await closeResearch(user);
  return rows.filter((row) => row.cohort === 'manual');
};

export const checkpointRow = (minutes) =>
  within(screen.getByRole('region', { name: 'Saved and upcoming fixed checkpoints' })).getByRole(
    'row',
    { name: new RegExp(`^${minutes} min left`) },
  );

export const clearCompleted = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Clear completed' }));
  const confirmation = await screen.findByRole('dialog', { name: 'Clear completed forecasts?' });
  await user.click(within(confirmation).getByRole('button', { name: 'Clear completed' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('dialog', { name: 'Clear completed forecasts?' }),
    ).not.toBeInTheDocument(),
  );
};
