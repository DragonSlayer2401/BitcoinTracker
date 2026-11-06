import { screen, within } from '@testing-library/react';

export const checkpointRow = (minutes) =>
  screen.getByRole('row', { name: new RegExp(`^${minutes} min left `) });

export const fixedCall = (minutes) =>
  within(checkpointRow(minutes)).getAllByRole('cell')[0].textContent;
