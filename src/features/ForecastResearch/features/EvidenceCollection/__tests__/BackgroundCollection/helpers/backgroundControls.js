import { exportPendingEvidence, openResearch } from '../../helpers/evidenceTestHarness';

export const exportBackgroundEvidence = async (user) =>
  (await exportPendingEvidence(user)).filter((row) => row.cohort === 'kalshi-background');

export const expectNoPendingEvidence = async (user) => {
  const dialog = await openResearch(user);
  await user.click(dialog.getByRole('button', { name: 'Export pending records' }));
  expect(await dialog.findByText(/No records are available in this export yet/)).toBeVisible();
};
