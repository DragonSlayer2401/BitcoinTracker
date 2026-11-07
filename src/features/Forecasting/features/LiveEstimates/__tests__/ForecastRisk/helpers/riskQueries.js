import { screen, waitFor, within } from '@testing-library/react';

export const openForecastRisk = async (user) => {
  await user.click(screen.getByRole('button', { name: /view estimated deadline risk/ }));
  return within(await screen.findByRole('dialog', { name: 'Deadline and reversal risk' }));
};

export const closeForecastRisk = async (user) => {
  await user.click(
    within(screen.getByRole('dialog', { name: 'Deadline and reversal risk' })).getByRole('button', {
      name: 'Close forecast risk',
    }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
};

export const getFixedCall = (minutes) => {
  const checkpoints = within(
    screen.getByRole('region', { name: 'Saved and upcoming fixed checkpoints' }),
  );
  const row = checkpoints.getByRole('row', { name: new RegExp(`^${minutes} min left `) });
  return within(row).getAllByRole('cell')[0].textContent;
};

export const getLiveProbability = (side) => {
  const estimate = within(screen.getByRole('region', { name: 'Live estimate' }));
  const label = estimate.getByRole('img').getAttribute('aria-label');
  const probabilities = label.match(/Yes · at or above ([\d.]+)%, No · below ([\d.]+)%/);
  return Number(probabilities[side === 'Yes' ? 1 : 2]);
};
