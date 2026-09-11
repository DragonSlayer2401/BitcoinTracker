import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Methodology from '../components/Methodology';

describe('Model and data rules panel', () => {
  test('keeps the summary visible and opens the full model, timing, and source rules on demand', async () => {
    const user = userEvent.setup();
    render(<Methodology />);
    const panel = within(screen.getByRole('region', { name: 'Model and data rules' }));

    expect(panel.getByText(/Predicts the selected Kalshi event/)).toHaveTextContent(
      'Accuracy remains unvalidated',
    );
    expect(screen.queryByRole('heading', { name: 'Probability model' })).not.toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: 'View model rules' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Model and data rules' }));

    expect(dialog.getByRole('heading', { name: 'Probability model' })).toBeInTheDocument();
    expect(dialog.getByRole('heading', { name: 'The final minute' })).toBeVisible();
    expect(
      dialog.getByRole('heading', { name: 'Fixed prediction and reversal risk' }),
    ).toBeVisible();
    expect(dialog.getByRole('heading', { name: 'Learning and validation' })).toBeVisible();
    expect(dialog.getByText(/A tie is Yes/)).toBeVisible();
    expect(dialog.getByText(/including a weak lean/)).toBeVisible();
    expect(dialog.getByRole('link', { name: 'Kalshi settlement' })).toHaveAttribute(
      'href',
      'https://help.kalshi.com/en/articles/13823838-crypto-markets',
    );
  });

  test.each(['Close rules', 'Close', 'Escape'])(
    'closes using %s and restores keyboard focus',
    async (control) => {
      const user = userEvent.setup();
      render(<Methodology />);
      const openButton = screen.getByRole('button', { name: 'View model rules' });
      await user.click(openButton);
      const dialog = within(screen.getByRole('dialog', { name: 'Model and data rules' }));

      if (control === 'Escape') await user.keyboard('{Escape}');
      else await user.click(dialog.getByRole('button', { name: control, exact: true }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(openButton).toHaveFocus();
    },
  );
});
