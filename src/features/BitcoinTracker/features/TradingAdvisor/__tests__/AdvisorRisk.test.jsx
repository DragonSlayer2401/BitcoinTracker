import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdvisorRisk from '../components/AdvisorRisk';

const NOW = Date.UTC(2026, 9, 3, 12);
const report = {
  policy: { maxDailyLoss: 5 },
  portfolio: { cash: 90, openRisk: 10, positions: [] },
  risk: {
    isCurrent: true,
    valuation: {
      observedAt: NOW,
      validUntil: NOW + 30000,
      complete: true,
      executableEquity: 97,
      totalMarkedPnl: -3,
      unrealizedPnl: -3,
      liquidationValue: 7,
      positions: [],
    },
    history: {
      startedAt: NOW - 60000,
      lastCompleteAt: NOW,
      completeCount: 3,
      incompleteCount: 1,
      maxDrawdown: 4,
      drawdown: 3,
    },
  },
};
const metric = (label) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
function openRisk(props = {}) {
  render(<AdvisorRisk report={report} now={NOW} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Account risk', exact: true }));
}

test('shows estimated whole-account losses separately from remaining capital at risk', () => {
  openRisk();
  expect(metric('Estimated account value')).toHaveTextContent('$97.00');
  expect(metric('Total P&L vs keeping cash')).toHaveTextContent('-$3.00');
  expect(metric('Capital still at risk')).toHaveTextContent('$10.00');
  expect(metric('Cash left if all exposure loses')).toHaveTextContent('$90.00');
  expect(metric('Largest observed drawdown')).toHaveTextContent('$4.00');
  expect(screen.getByText(/It does not cap losses on positions already open/)).toBeVisible();
});

test.each([
  ['expired', { now: NOW + 30000 }],
  ['future dated', { now: NOW - 1 }],
  ['failed report refresh', { isStale: true }],
  [
    'quote or contract expiry',
    {
      report: {
        ...report,
        risk: { ...report.risk, valuation: { ...report.risk.valuation, validUntil: NOW } },
      },
    },
  ],
  ['different holdings', { report: { ...report, risk: { ...report.risk, isCurrent: false } } }],
])('hides actionable market-value amounts when %s', (_label, props) => {
  openRisk(props);
  expect(metric('Estimated account value')).toHaveTextContent('—');
  expect(metric('Total P&L vs keeping cash')).toHaveTextContent('—');
  expect(metric('Current observed drawdown')).toHaveTextContent('—');
  expect(screen.getByRole('alert')).toHaveTextContent('A current sale estimate is unavailable');
  expect(metric('Largest observed drawdown')).toHaveTextContent('$4.00');
});

test('does not call an unpriced position worthless or claim a complete account total', () => {
  openRisk({
    report: {
      ...report,
      risk: {
        ...report.risk,
        valuation: {
          ...report.risk.valuation,
          complete: false,
          executableEquity: null,
          unrealizedPnl: null,
          positions: [
            {
              positionId: 'held-1',
              quantity: 10,
              status: 'insufficient_execution_depth',
              netProceeds: null,
            },
          ],
        },
      },
    },
  });
  expect(metric('Estimated account value')).toHaveTextContent('—');
  expect(metric('Unrealized P&L')).toHaveTextContent('—');
  expect(screen.getByText('Not enough buyers for the whole position')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('account total stays unknown');
});

test('keeps risk details in a keyboard-accessible dialog with focus restoration', async () => {
  const user = userEvent.setup();
  render(<AdvisorRisk report={report} now={NOW} />);
  const button = screen.getByRole('button', { name: 'Account risk', exact: true });
  await user.click(button);
  expect(screen.getByRole('dialog', { name: 'Paper account value & risk' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Close account risk' }));
  expect(button).toHaveFocus();
});
