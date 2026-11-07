import { screen, within } from '@testing-library/react';

export const openPurchaseValue = async (user) => {
  await user.click(screen.getByRole('button', { name: /view estimated deadline risk/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Deadline and reversal risk' });
  await user.click(within(dialog).getByRole('button', { name: 'Compare purchase value' }));
  return within(dialog);
};

export const chooseAccount = async (user, dialog, name) => {
  await user.click(dialog.getByRole('combobox', { name: 'Account fee basis' }));
  await user.click(dialog.getByRole('option', { name, exact: true }));
};

export const comparisonCells = (dialog, label) =>
  within(dialog.getByRole('row', { name: new RegExp(`^${label} `) })).getAllByRole('cell');

export const changeQuantity = async (user, dialog, quantity) => {
  const input = dialog.getByRole('spinbutton', { name: 'Contracts to compare' });
  await user.clear(input);
  if (quantity !== '') await user.type(input, quantity);
};
