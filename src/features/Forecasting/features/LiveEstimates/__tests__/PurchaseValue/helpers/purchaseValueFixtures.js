export const createPurchaseBook = (contract, now, overrides = {}) => ({
  ticker: contract.ticker,
  receivedAt: now,
  yesAsks: [{ price: 0.4, quantity: 10 }],
  noAsks: [{ price: 0.65, quantity: 10 }],
  depthLimit: 100,
  fee: {
    available: true,
    type: 'quadratic',
    multiplier: 1,
    checkedAt: now,
    validUntil: now + 30_000,
  },
  ...overrides,
});
