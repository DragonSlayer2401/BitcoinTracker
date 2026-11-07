import { waitFor } from '@testing-library/react';
import { formatTime } from '@/utils/format.utils';
import { openResearch } from '../../helpers/evidenceTestHarness';

export const expectEmptyPendingExport = async (user) => {
  const dialog = await openResearch(user);
  await user.click(dialog.getByRole('button', { name: 'Export pending records' }));
  expect(await dialog.findByText(/No records are available in this export yet/)).toBeVisible();
};

export const expectSyncedAt = async (user, time) => {
  const dialog = await openResearch(user);
  await waitFor(() =>
    expect(dialog.getByText(/Collection needs this page running/)).toHaveTextContent(
      `Last archive sync: ${formatTime(time)}`,
    ),
  );
};
