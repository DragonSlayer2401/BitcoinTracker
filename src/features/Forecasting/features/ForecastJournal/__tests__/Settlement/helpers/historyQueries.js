import { screen, within } from '@testing-library/react';

export const openHistory = async (user) => {
  await user.click(screen.getByRole('button', { name: 'View history' }));
  return within(await screen.findByRole('dialog', { name: 'Forecast history' }));
};

export const getCheckpointRow = (history, minutes) =>
  history.getByRole('row', { name: new RegExp(` · ${minutes} min left `) });
