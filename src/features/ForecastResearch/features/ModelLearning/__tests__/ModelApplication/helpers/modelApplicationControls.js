import { screen, within } from '@testing-library/react';

export const liveEstimate = () => within(screen.getByRole('region', { name: 'Live estimate' }));

export const fixedCheckpoint = (minutes) => {
  const checkpoints = within(
    screen.getByRole('region', { name: 'Saved and upcoming fixed checkpoints' }),
  );
  return checkpoints.getByRole('row', { name: new RegExp(`${minutes} min left`) });
};

export const expectKnownProbability = (percentage) => {
  expect(liveEstimate().getByText(/^(Live estimate · )?Learned model$/)).toBeVisible();
  expect(liveEstimate().getByRole('img')).toHaveAccessibleName(
    `Yes · at or above ${percentage.toFixed(1)}%, No · below ${(100 - percentage).toFixed(1)}%`,
  );
};
