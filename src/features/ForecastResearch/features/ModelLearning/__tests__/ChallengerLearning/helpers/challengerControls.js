import { within } from '@testing-library/react';

export const openCandidate = async (user, dialog, label = 'Half pressure') => {
  const summary = dialog.getByText(/^Candidate validation ·/);
  if (!summary.closest('details').open) await user.click(summary);
  const card = dialog
    .getAllByRole('listitem')
    .find((item) => within(item).queryByText(label, { exact: true }));
  expect(card).toBeVisible();
  return within(card);
};

export const openCheckpointValidation = async (
  user,
  candidate,
  phase = 'Development validation',
) => {
  const summary = candidate.getByText(`${phase} by countdown time`);
  if (!summary.closest('details').open) await user.click(summary);
  return within(
    candidate.getByRole('table', { name: `${phase} checkpoint coverage and decisions` }),
  );
};
