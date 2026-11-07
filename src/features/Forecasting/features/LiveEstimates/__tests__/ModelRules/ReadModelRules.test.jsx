import { screen, waitFor, within } from '@testing-library/react';
import { renderLiveEstimates, setupLiveEstimateTests } from '../helpers/liveEstimateTestHarness';

setupLiveEstimateTests();

test.each(['Close rules', 'Close', 'Escape'])(
  'opens the model explanation and closes it using %s',
  async (dismissAction) => {
    const view = await renderLiveEstimates({ includeMethodology: true });
    const rulesButton = screen.getByRole('button', { name: 'View model rules' });
    await view.user.click(rulesButton);
    const dialog = screen.getByRole('dialog', { name: 'Model and data rules' });
    const rules = within(dialog);
    expect(dialog).toBeVisible();
    expect(rules.getByRole('heading', { name: 'What the prediction means' })).toBeVisible();
    expect(
      rules.getByText(/A tie is Yes\. The official Kalshi result determines the score/),
    ).toBeVisible();
    expect(rules.getByRole('heading', { name: 'The final minute' })).toBeVisible();
    expect(rules.getByText(/Missing readings from elapsed seconds stay uncertain/)).toBeVisible();
    expect(
      rules.getByRole('heading', { name: 'Fixed prediction and reversal risk' }),
    ).toBeVisible();
    expect(rules.getByText(/Its target, deadline and percentages stay unchanged/)).toBeVisible();
    expect(rules.getByRole('link', { name: 'Market rules and official results' })).toHaveAttribute(
      'href',
      'https://docs.kalshi.com/api-reference/market/get-market',
    );
    if (dismissAction === 'Escape') await view.user.keyboard('{Escape}');
    else await view.user.click(rules.getByRole('button', { name: dismissAction, exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rulesButton).toHaveFocus();
    await view.user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Model and data rules' })).toBeVisible();
  },
);
