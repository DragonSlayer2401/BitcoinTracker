import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Methodology from '../components/Methodology';

describe('Model and data rules panel', () => {
  test('keeps the summary visible and opens the full model, timing, and source rules on demand', async () => {
    const user = userEvent.setup();
    render(<Methodology />);
    const panel = within(screen.getByRole('region', { name: 'Model and data rules' }));

    expect(panel.getByText(/fixed estimate after three minutes/)).toHaveTextContent(
      'accuracy remains unvalidated',
    );
    expect(screen.queryByRole('heading', { name: 'Probability model' })).not.toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: 'View model rules' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Model and data rules' }));

    expect(dialog.getByRole('heading', { name: 'Probability model' })).toBeInTheDocument();
    expect(dialog.getByRole('heading', { name: 'Data requirements' })).toBeInTheDocument();
    expect(
      dialog.getByRole('heading', { name: 'Start and observation windows' }),
    ).toBeInTheDocument();
    expect(dialog.getByRole('heading', { name: 'Journal metrics' })).toBeInTheDocument();
    expect(dialog.getByText(/deadline is exactly 15 minutes after that start/)).toBeInTheDocument();
    expect(
      dialog.getByText(/fixed prediction keeps its original probabilities/),
    ).toBeInTheDocument();
    expect(dialog.getByRole('heading', { name: 'Fixed prediction observation' })).toBeVisible();
    expect(dialog.getByText(/There is no 65% minimum/)).toHaveTextContent(
      'no full minute of matching directional signals',
    );
    expect(dialog.getByText(/not a proven ability to predict future returns/)).toHaveTextContent(
      'Older saved windows retain their original publication policy and percentages',
    );
    expect(dialog.getByText(/probabilities wait for capture/)).toBeInTheDocument();
    expect(dialog.getByRole('link', { name: 'Coinbase Exchange ticker' })).toHaveAttribute(
      'href',
      'https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker',
    );
    expect(dialog.getByRole('link', { name: 'one-minute candles' })).toHaveAttribute(
      'href',
      'https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles',
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
