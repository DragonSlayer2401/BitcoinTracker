import { screen, within } from '@testing-library/react';

export const getLiveEstimate = () => within(screen.getByRole('region', { name: 'Live estimate' }));
export const getLiveProbabilities = () =>
  getLiveEstimate().getByRole('img').getAttribute('aria-label');
