import {
  createTradingDomainRecord,
  validateTradingDomainRecord,
} from '@/utils/tradingDomain.utils';
import { formatDecimalUnits, parseDecimalUnits } from '@/utils/fixedPoint.utils';
import { createSpecifiedMarket, marketNow } from '../helpers/marketRulesFixtures';

const createRecord = (kind, fields = {}, specification = createSpecifiedMarket().specification) =>
  createTradingDomainRecord(
    kind,
    {
      id: `synthetic-${kind}`,
      marketTicker: specification.marketTicker,
      specificationVersion: specification.version,
      source: { id: 'synthetic-fixture', kind: 'synthetic' },
      observedAt: marketNow,
      receivedAt: marketNow,
      ...fields,
    },
    specification,
  );

test('forecast, quote, paper order, fill, position and decision share exact serializable units', () => {
  const specification = createSpecifiedMarket().specification;
  expect(validateTradingDomainRecord(specification).valid).toBe(true);
  const observation = createRecord('observation', {
    status: 'observed',
    value: '50000.125',
    unit: 'USD/BTC',
  });
  const forecast = createRecord('forecast', {
    probabilityYesUnits: '900000',
    probabilityScale: 6,
    modelVersion: 'synthetic-model-v1',
    inputObservedThroughAt: marketNow,
    validUntil: marketNow + 5000,
  });
  const quote = createRecord('quote', {
    side: 'YES',
    bookSide: 'ask',
    priceUnits: '4000',
    quantityUnits: '100',
    validUntil: marketNow + 5000,
  });
  const decision = createRecord('decision', {
    action: 'BUY',
    side: 'YES',
    position: { state: 'flat', positionId: null, quantityUnits: '0' },
    quantityUnits: '100',
    limitPriceUnits: '4000',
    reason: 'synthetic-acceptance',
    validUntil: marketNow + 5000,
  });
  const order = createRecord('order', {
    mode: 'paper',
    side: 'YES',
    action: 'BUY',
    quantityUnits: '100',
    filledQuantityUnits: '0',
    limitPriceUnits: '4000',
    status: 'pending',
  });
  const fill = createRecord('fill', {
    mode: 'paper',
    orderId: order.id,
    side: 'YES',
    action: 'BUY',
    priceUnits: '4000',
    quantityUnits: '100',
    feeUnits: '16800',
  });
  const position = createRecord('position', {
    side: 'YES',
    quantityUnits: '100',
    costBasisUnits: '416800',
  });
  for (const record of [observation, forecast, quote, decision, order, fill, position]) {
    expect(validateTradingDomainRecord(JSON.parse(JSON.stringify(record)), specification)).toEqual({
      valid: true,
      errors: [],
    });
    expect(record).toMatchObject({ currency: 'USD', timestampUnit: 'unix-ms' });
  }
  expect(
    formatDecimalUnits(
      BigInt(fill.priceUnits) * BigInt(fill.quantityUnits) + BigInt(fill.feeUnits),
      6,
    ),
  ).toBe('0.416800');
  expect(position.costBasisUnits).toBe('416800');
});

test('HOLD while flat has no new order quantity and SELL requires a matching held position', () => {
  const hold = {
    action: 'HOLD',
    side: null,
    position: { state: 'flat', positionId: null, quantityUnits: '0' },
    quantityUnits: '0',
    limitPriceUnits: null,
    reason: 'rules-unverified',
    validUntil: marketNow + 5000,
  };
  expect(createRecord('decision', hold).action).toBe('HOLD');
  expect(() => createRecord('decision', { ...hold, quantityUnits: '100' })).toThrow();
  expect(() =>
    createRecord('decision', {
      ...hold,
      action: 'SELL',
      side: 'YES',
      quantityUnits: '100',
      limitPriceUnits: '4000',
    }),
  ).toThrow();
  expect(
    createRecord('decision', {
      ...hold,
      action: 'SELL',
      side: 'YES',
      position: { state: 'held', positionId: 'synthetic-position', quantityUnits: '100' },
      quantityUnits: '100',
      limitPriceUnits: '4000',
    }).action,
  ).toBe('SELL');
});

test('missing observations and source-agency outages are distinct records, not settlement verdicts', () => {
  const missing = createRecord('observation', {
    status: 'locally-missing',
    value: null,
    unit: 'USD/BTC',
  });
  expect(missing.status).toBe('locally-missing');
  expect(() =>
    createRecord('observation', { status: 'source-agency-outage', value: null, unit: 'USD/BTC' }),
  ).toThrow();
  const outage = createRecord('observation', {
    status: 'source-agency-outage',
    value: null,
    unit: 'USD/BTC',
    sourceEvidence: {
      url: 'https://example.invalid/synthetic-source-notice',
      retrievedAt: marketNow,
    },
  });
  expect(outage.status).toBe('source-agency-outage');
  expect(missing.result).toBeUndefined();
  expect(outage.result).toBeUndefined();
});

test('serialized versions, units, chronology and venue increments are enforced at the boundary', () => {
  const specification = createSpecifiedMarket().specification;
  const quote = createRecord('quote', {
    side: 'YES',
    bookSide: 'ask',
    priceUnits: '4000',
    quantityUnits: '100',
    validUntil: marketNow + 5000,
  });
  for (const patch of [
    { version: 'market-quote-v999' },
    { currency: 'BTC' },
    { timestampUnit: 'seconds' },
    { observedAt: marketNow + 1 },
    { priceUnits: '4001' },
    { quantityUnits: '0.1' },
    { marketTicker: 'OTHER-MARKET' },
  ])
    expect(validateTradingDomainRecord({ ...quote, ...patch }, specification).valid).toBe(false);
  expect(parseDecimalUnits('0.1001', 4)).toBe(1001n);
  expect(parseDecimalUnits('0.10001', 4)).toBeNull();
  expect(parseDecimalUnits('1e-4', 4)).toBeNull();
  expect(parseDecimalUnits(0.1, 4)).toBeNull();
});

test('production-mode order records cannot be created', () => {
  expect(() =>
    createRecord('order', {
      mode: 'production',
      side: 'YES',
      action: 'BUY',
      quantityUnits: '100',
      filledQuantityUnits: '0',
      limitPriceUnits: '4000',
      status: 'pending',
    }),
  ).toThrow();
});

test('paper order state cannot contradict its filled quantity', () => {
  const specification = createSpecifiedMarket().specification;
  const order = createRecord(
    'order',
    {
      mode: 'paper',
      side: 'NO',
      action: 'BUY',
      quantityUnits: '200',
      filledQuantityUnits: '0',
      limitPriceUnits: '4000',
      status: 'pending',
    },
    specification,
  );
  for (const patch of [
    { status: 'pending', filledQuantityUnits: '100' },
    { status: 'partially-filled', filledQuantityUnits: '0' },
    { status: 'partially-filled', filledQuantityUnits: '200' },
    { status: 'filled', filledQuantityUnits: '100' },
    { status: 'filled', filledQuantityUnits: '300' },
  ])
    expect(validateTradingDomainRecord({ ...order, ...patch }, specification).valid).toBe(false);
  for (const patch of [
    { status: 'partially-filled', filledQuantityUnits: '100' },
    { status: 'filled', filledQuantityUnits: '200' },
    { status: 'canceled', filledQuantityUnits: '100' },
  ])
    expect(validateTradingDomainRecord({ ...order, ...patch }, specification).valid).toBe(true);
});
