import { screen, within } from '@testing-library/react';

export const getLiveEstimate = () => within(screen.getByRole('region', { name: 'Live estimate' }));

export const getDisplayedYesChance = () => {
  const probabilityLabel =
    getLiveEstimate().getByText('Yes · at or above').parentElement.textContent;
  return Number(probabilityLabel.match(/(\d+(?:\.\d+)?)%/)[1]);
};
