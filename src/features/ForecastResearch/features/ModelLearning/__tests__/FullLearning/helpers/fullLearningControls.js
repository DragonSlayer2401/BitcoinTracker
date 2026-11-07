export const expectLearningCount = (dialog, label, count) => {
  const term = dialog.getByText(label, { selector: 'dt', exact: true });
  expect(term.parentElement).toHaveTextContent(`${label}${count}`);
};

export const expectBaselineInUse = (dialog) => {
  expect(dialog.getByText(/^Kalshi settlement-average model\./)).toBeVisible();
  expect(dialog.queryByText(/^Learned model /)).not.toBeInTheDocument();
};
