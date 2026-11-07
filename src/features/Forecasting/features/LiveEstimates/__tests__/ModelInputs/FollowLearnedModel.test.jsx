import { screen, within } from '@testing-library/react';
import { isOutcomeModelArtifact } from '@/features/ForecastResearch/features/ModelLearning/utils/model.utils';
import { renderLiveEstimates, setupLiveEstimateTests } from '../helpers/liveEstimateTestHarness';
import { eventStart } from '../helpers/liveEstimateFixtures';
import { createLearnedModel } from './helpers/learnedModelFixture';

setupLiveEstimateTests();

test('uses an approved outcome model while keeping a shadow candidate out of the displayed estimate', async () => {
  const model = createLearnedModel();
  // Reject an invalid fixture before a silent production fallback could hide it.
  expect(isOutcomeModelArtifact(model)).toBe(true);
  const view = await renderLiveEstimates();
  const estimate = within(screen.getByRole('region', { name: 'Live estimate' }));
  const baselineProbabilities = estimate.getByRole('img').getAttribute('aria-label');
  const { activation, ...candidate } = model;

  await view.update(eventStart, { models: { candidate } });
  expect(estimate.getByRole('img')).toHaveAttribute('aria-label', baselineProbabilities);
  expect(estimate.queryByText(/Learned model/)).not.toBeInTheDocument();

  await view.update(eventStart, { models: { active: { ...candidate, activation } } });
  expect(estimate.getByText('Live estimate · Learned model')).toBeVisible();
  expect(estimate.getByTitle(`Outcome model ${model.id}`)).toBeVisible();
  expect(estimate.getByRole('img')).toHaveAccessibleName(
    'Yes · at or above 70.0%, No · below 30.0%',
  );
  expect(estimate.getByRole('img')).not.toHaveAttribute('aria-label', baselineProbabilities);

  await view.update(eventStart, {
    models: {
      active: {
        ...model,
        retirement: { retiredAt: eventStart, reason: 'Monitoring suspended this model.' },
      },
    },
  });
  expect(estimate.queryByText(/Learned model/)).not.toBeInTheDocument();
  expect(estimate.queryByTitle(`Outcome model ${model.id}`)).not.toBeInTheDocument();
  expect(estimate.getByRole('img')).toHaveAttribute('aria-label', baselineProbabilities);
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
});

test('uses the baseline for a proxy feed outside the active model domain and reapplies the model when BRTI returns', async () => {
  const model = createLearnedModel();
  expect(isOutcomeModelArtifact(model)).toBe(true);
  const view = await renderLiveEstimates({ models: { active: model } });
  const estimate = within(screen.getByRole('region', { name: 'Live estimate' }));
  expect(estimate.getByText('Live estimate · Learned model')).toBeVisible();
  expect(estimate.getByRole('img')).toHaveAccessibleName(
    'Yes · at or above 70.0%, No · below 30.0%',
  );

  await view.update(eventStart + 1000, { benchmark: null });
  expect(
    screen.getByText('Coinbase proxy · BRTI access needed for the settlement feed'),
  ).toBeVisible();
  expect(estimate.queryByText(/Learned model/)).not.toBeInTheDocument();
  expect(estimate.queryByRole('heading', { name: 'Estimate paused' })).not.toBeInTheDocument();
  expect(estimate.getByRole('img')).not.toHaveAccessibleName(
    'Yes · at or above 70.0%, No · below 30.0%',
  );

  await view.update(eventStart + 2000);
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(estimate.getByText('Live estimate · Learned model')).toBeVisible();
  expect(estimate.getByTitle(`Outcome model ${model.id}`)).toBeVisible();
  expect(estimate.getByRole('img')).toHaveAccessibleName(
    'Yes · at or above 70.0%, No · below 30.0%',
  );
});
