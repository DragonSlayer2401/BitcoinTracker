import {
  getKalshiContract,
  getKalshiOutcome,
  isSameKalshiContract,
} from '@/features/MarketData/utils/kalshi/contract.utils';
import {
  getTradingAdvice,
  getTradingExecutionQuote,
  simulateTradingExecution,
} from '../../utils/tradingAdvisor.utils';
import {
  createMarketMetadata,
  createQuantityRuleEvidence,
  createSpecifiedMarket,
  createTradingInputs,
} from '../helpers/marketRulesFixtures';

test('missing live quantity rules withhold advice without disabling the settlement identity', () => {
  const market = createSpecifiedMarket({ quantityRuleEvidence: null });
  const inputs = createTradingInputs(market);
  expect(getKalshiContract(market)).not.toBeNull();
  expect(market.specification.actionable).toBe(false);
  expect(market.specification.quantityRules).toBeNull();
  expect(getTradingAdvice(inputs)).toMatchObject({ action: 'wait', quantity: 0 });
  expect(
    getTradingExecutionQuote({ ...inputs, action: 'buy', side: 'yes', quantity: 1 }),
  ).toMatchObject({ available: false });
});

test.each(['rules_primary', 'rules_secondary', 'price_ranges', 'custom_strike', 'floor_strike'])(
  'a missing %s cannot produce an actionable recommendation',
  (field) => {
    const raw = createMarketMetadata();
    delete raw[field];
    const market = createSpecifiedMarket({ raw });
    expect(market.specification.actionable).toBe(false);
    expect(getTradingAdvice(createTradingInputs(market))).toMatchObject({
      action: 'wait',
      quantity: 0,
    });
  },
);

test('conflicting comparison and price bands withhold trades instead of choosing a rule', () => {
  for (const override of [
    { strike_type: 'greater' },
    { rules_primary: createMarketMetadata().rules_primary.replace('at least', 'above') },
    {
      price_ranges: [
        { start: '0.0000', end: '0.5000', step: '0.0100' },
        { start: '0.4000', end: '1.0000', step: '0.0100' },
      ],
    },
  ]) {
    const market = createSpecifiedMarket({ raw: createMarketMetadata(override) });
    expect(market.specification.actionable).toBe(false);
    expect(getTradingAdvice(createTradingInputs(market)).action).toBe('wait');
  }
});

test('a verified synthetic market supports advice and snaps adverse prices to its actual grid', () => {
  const contract = createSpecifiedMarket({
    raw: createMarketMetadata({
      price_level_structure: 'synthetic-two-and-half-cents',
      price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0250' }],
    }),
  });
  const inputs = createTradingInputs(contract);
  const advice = getTradingAdvice(inputs);
  expect(advice.action).toBe('buy');
  expect(advice.side).toBe('yes');
  expect(advice.limitPrice).toBe(0.475);
  const quote = getTradingExecutionQuote({ ...inputs, action: 'buy', side: 'yes', quantity: 1 });
  expect(quote).toMatchObject({
    available: true,
    fills: [{ price: 0.425, quantity: 1 }],
    cost: 0.425,
  });
});

test.each([
  ['off-grid price', { price: 0.4001, quantity: 20 }],
  ['off-increment quantity', { price: 0.4, quantity: 20.01 }],
])('%s is rejected before an entry or exit recommendation', (_name, level) => {
  const raw = createMarketMetadata();
  const market = createSpecifiedMarket({
    raw,
    quantityRuleEvidence: createQuantityRuleEvidence(raw, Date.parse(raw.open_time) + 360_000, {
      minimum: '1',
      step: '1',
    }),
  });
  const inputs = createTradingInputs(market);
  inputs.book.yesAsks = [level];
  expect(getTradingAdvice(inputs).action).toBe('wait');
  for (const action of ['buy', 'sell'])
    expect(
      getTradingExecutionQuote({ ...inputs, action, side: 'yes', quantity: 1 }).available,
    ).toBe(false);
});

test('a later loss of rule verification cannot fill an earlier valid paper recommendation', () => {
  const inputs = createTradingInputs();
  const advice = { ...getTradingAdvice(inputs), id: 'synthetic-advice' };
  expect(advice.action).toBe('buy');
  const later = inputs.now + 3000;
  const contract = {
    ...inputs.contract,
    specification: { ...inputs.contract.specification, actionable: false },
  };
  const fill = simulateTradingExecution({
    ...inputs,
    contract,
    advice,
    now: later,
    book: { ...inputs.book, requestedAt: later, receivedAt: later },
  });
  expect(fill.status).not.toBe('filled');
  expect(fill.quantity ?? 0).toBe(0);
});

test('new contracts retain specification provenance without invalidating legacy settlement records', () => {
  const market = createSpecifiedMarket();
  const contract = getKalshiContract(market);
  expect(contract.specification).toEqual(market.specification);
  const { specification: _specification, ...legacy } = contract;
  expect(isSameKalshiContract(legacy, contract)).toBe(true);
  expect(getTradingAdvice(createTradingInputs(legacy)).action).toBe('wait');
  expect(
    getKalshiOutcome(
      {
        ...legacy,
        status: 'settled',
        result: 'yes',
        settlementPrice: legacy.target,
        settledAt: legacy.expiresAt + 60_000,
        receivedAt: legacy.expiresAt + 60_000,
      },
      legacy.expiresAt + 60_000,
    ),
  ).toMatchObject({ result: 'yes', status: 'observed' });
});

test.each([
  'rounding',
  'timestamps',
  'sources',
  'ruleText',
  'quantityRules',
  'priceGrid',
  'settlementTimerSeconds',
])(
  'a normalized specification missing %s cannot bypass verification by retaining its old status',
  (field) => {
    const contract = createSpecifiedMarket();
    const specification = { ...contract.specification };
    delete specification[field];
    const inputs = createTradingInputs({ ...contract, specification });
    expect(getTradingAdvice(inputs).action).toBe('wait');
  },
);

test.each([-1, 0.5])(
  'an invalid normalized settlement timer %s cannot bypass verification',
  (settlementTimerSeconds) => {
    const contract = createSpecifiedMarket();
    const inputs = createTradingInputs({
      ...contract,
      specification: { ...contract.specification, settlementTimerSeconds },
    });
    expect(getTradingAdvice(inputs).action).toBe('wait');
  },
);

test('an out-of-range normalized timestamp withholds advice without throwing', () => {
  const contract = createSpecifiedMarket();
  const inputs = createTradingInputs({
    ...contract,
    specification: {
      ...contract.specification,
      timestamps: {
        ...contract.specification.timestamps,
        expirationAt: Number.MAX_SAFE_INTEGER,
      },
    },
  });
  expect(getTradingAdvice(inputs).action).toBe('wait');
});
