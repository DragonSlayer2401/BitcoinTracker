import {
  evaluateKalshiSettlementSamples,
  parseKalshiUtcTimestamp,
} from '@/features/MarketData/utils/kalshi/marketSpecification.utils';
import {
  createMarketMetadata,
  createRoundingRuleEvidence,
  createSpecifiedMarket,
  createTradingInputs,
} from '../helpers/marketRulesFixtures';
import { getTradingAdvice } from '../../utils/tradingAdvisor.utils';
import { isTradableMarketSpecification } from '@/utils/tradingDomain.utils';

const createObservations = (specification, value) =>
  Array.from({ length: 60 }, (_, index) => ({
    observedAt: specification.closingWindow.startAt + (index + 1) * 1000,
    receivedAt: specification.closingWindow.endAt + 1000,
    value,
    source: { id: 'cf-brti', kind: 'official' },
  }));

test('equality is YES in the local comparison, while only the exchange can provide an official result', () => {
  const specification = createSpecifiedMarket().specification;
  const comparison = evaluateKalshiSettlementSamples({
    specification,
    observations: createObservations(specification, '50000.00'),
  });
  expect(comparison).toMatchObject({
    status: 'local_comparison_only',
    localResult: 'YES',
    roundedAverage: '50000.00',
    officialResult: null,
  });
});

test.each([
  ['49999.9949', '49999.99', 'NO'],
  ['49999.9951', '50000.00', 'YES'],
  ['50000.0049', '50000.00', 'YES'],
  ['50000.0051', '50000.01', 'YES'],
])(
  'exact decimal averaging rounds %s without binary floating-point drift',
  (value, rounded, result) => {
    const specification = createSpecifiedMarket().specification;
    expect(
      evaluateKalshiSettlementSamples({
        specification,
        observations: createObservations(specification, value),
      }),
    ).toMatchObject({
      localResult: result,
      roundedAverage: rounded,
      officialResult: null,
    });
  },
);

test.each(['49999.995', '50000.005'])(
  'an undocumented exact halfway value %s remains indeterminate',
  (value) => {
    const specification = createSpecifiedMarket({ roundingRuleEvidence: null }).specification;
    expect(
      evaluateKalshiSettlementSamples({
        specification,
        observations: createObservations(specification, value),
      }),
    ).toMatchObject({
      status: 'awaiting_official_result',
      reason: 'undocumented_halfway_rounding',
      localResult: null,
      officialResult: null,
    });
  },
);

test.each([
  ['half-up', '50000.01', 'YES'],
  ['half-even', '50000.00', 'NO'],
])(
  'explicit synthetic %s evidence controls exact midpoint arithmetic',
  (halfway, rounded, result) => {
    const raw = createMarketMetadata({ floor_strike: 50000.01 });
    const now = Date.parse(raw.open_time) + 360_000;
    const specification = createSpecifiedMarket({
      raw,
      now,
      roundingRuleEvidence: createRoundingRuleEvidence(raw, now, { halfway }),
    }).specification;
    expect(isTradableMarketSpecification(specification)).toBe(true);
    expect(
      evaluateKalshiSettlementSamples({
        specification,
        observations: createObservations(specification, '50000.005'),
      }),
    ).toMatchObject({
      status: 'local_comparison_only',
      localResult: result,
      roundedAverage: rounded,
      officialResult: null,
    });
  },
);

test('unknown midpoint rules block recommendations even away from a midpoint', () => {
  const contract = createSpecifiedMarket({ roundingRuleEvidence: null });
  expect(contract.specification.verification.reasons).toContain('unverified_halfway_rounding');
  expect(contract.specification.actionable).toBe(false);
  expect(getTradingAdvice(createTradingInputs(contract)).action).toBe('wait');
  expect(
    isTradableMarketSpecification({
      ...contract.specification,
      actionable: true,
      verification: { status: 'verified', reasons: [] },
    }),
  ).toBe(false);
});

test.each([
  { version: 'kalshi-rounding-rule-evidence-v0' },
  { marketTicker: 'KXBTC15M-OTHER-00' },
  { halfway: 'half-down' },
  { source: null },
])('invalid midpoint evidence stays unavailable (%j)', (overrides) => {
  const raw = createMarketMetadata();
  const now = Date.parse(raw.open_time) + 360_000;
  const contract = createSpecifiedMarket({
    raw,
    now,
    roundingRuleEvidence: createRoundingRuleEvidence(raw, now, overrides),
  });
  expect(contract.specification.rounding).toMatchObject({ halfway: 'unspecified', source: null });
  expect(contract.specification.verification.reasons).toContain('unverified_halfway_rounding');
  expect(isTradableMarketSpecification(contract.specification)).toBe(false);
});

test('missing local samples and a confirmed source-agency outage never share a settlement verdict', () => {
  const specification = createSpecifiedMarket().specification;
  const observations = createObservations(specification, '49900');
  const missing = evaluateKalshiSettlementSamples({
    specification,
    observations: observations.slice(1),
  });
  expect(missing).toMatchObject({
    reason: 'locally_missing_observations',
    missingSampleCount: 1,
    localResult: null,
    officialResult: null,
  });
  const outage = evaluateKalshiSettlementSamples({
    specification,
    observations: [],
    sourceAgencyStatus: 'confirmed_outage',
  });
  expect(outage).toMatchObject({
    reason: 'source_agency_outage_subject_to_contract_and_exchange_review',
    localResult: null,
    officialResult: null,
  });
});

test('the closing window excludes its starting second and includes its deadline second', () => {
  const specification = createSpecifiedMarket().specification;
  const observations = createObservations(specification, '50000.00');
  const preceding = {
    ...observations[0],
    observedAt: specification.closingWindow.startAt,
    value: '10000.00',
  };
  expect(
    evaluateKalshiSettlementSamples({ specification, observations: [preceding, ...observations] })
      .roundedAverage,
  ).toBe('50000.00');
  expect(
    evaluateKalshiSettlementSamples({
      specification,
      observations: [preceding, ...observations.slice(0, -1)],
    }),
  ).toMatchObject({ reason: 'locally_missing_observations', missingSampleCount: 1 });
});

test.each([
  Date.UTC(2026, 10, 6, 23, 45),
  Date.UTC(2026, 11, 31, 23, 45),
  Date.UTC(2026, 2, 8, 6, 45),
  Date.UTC(2026, 10, 1, 5, 45),
])(
  'UTC date and Eastern daylight-saving boundaries preserve the actual 15-minute windows (%s)',
  (startsAt) => {
    const market = createSpecifiedMarket({ raw: createMarketMetadata({ startsAt }) });
    expect(market.rulesVerified).toBe(true);
    expect(market.specification.timestamps).toMatchObject({
      opensAt: startsAt,
      closesAt: startsAt + 900_000,
      expectedExpirationAt: startsAt + 1_200_000,
    });
    expect(market.specification.referenceWindow).toMatchObject({
      startAt: startsAt - 60_000,
      endAt: startsAt,
    });
    expect(market.specification.closingWindow).toMatchObject({
      startAt: startsAt + 840_000,
      endAt: startsAt + 900_000,
    });
    expect(market.specification.timestamps.expirationAt).toBeGreaterThan(market.expiresAt);
  },
);

test('invalid calendar times and normalized missing rounding rules cannot silently select a result', () => {
  expect(parseKalshiUtcTimestamp('2026-02-30T00:00:00Z')).toBeNull();
  expect(parseKalshiUtcTimestamp('2026-11-06T23:45:00-05:00')).toBeNull();
  const original = createSpecifiedMarket().specification;
  const { rounding: _rounding, ...missingRounding } = original;
  expect(
    evaluateKalshiSettlementSamples({
      specification: missingRounding,
      observations: createObservations(original, '49999.995'),
    }).localResult,
  ).toBeNull();
  expect(
    evaluateKalshiSettlementSamples({
      specification: { ...original, comparison: 'greater' },
      observations: createObservations(original, '50000.00'),
    }).localResult,
  ).toBeNull();
});
