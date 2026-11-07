import { openResearch } from '../../helpers/evidenceTestHarness';

export const expectNoPendingRecords = async (user) => {
  const research = await openResearch(user);
  await user.click(research.getByRole('button', { name: 'Export pending records' }));
  expect(await research.findByRole('alert')).toHaveTextContent(
    'No records are available in this export yet.',
  );
};
