import { getPublicationRisk } from '../utils/publicationRisk.utils';

function createInputs(overrides = {}) {
  return {
    target: 49_750,
    direction: 'above',
    conditions: { available: true, canPublish: true, riskFlags: [] },
    stream: {
      quality: { available: true },
      liquidity: {
        available: true,
        bid: 49_999,
        ask: 50_001,
        midpoint: 50_000,
        depthChange60: { available: true, totalFraction: 0 },
      },
      flow: {
        windows: Object.fromEntries(
          [15, 60, 180].map((seconds) => [
            seconds,
            { available: true, totalBtc: 10, imbalance: 0 },
          ]),
        ),
      },
    },
    ...overrides,
  };
}

describe('current order-book publication checks', () => {
  test.each([
    ['above', 49_750],
    ['below', 50_250],
  ])(
    'permits a consistent %s call without returning a boosted probability',
    (direction, target) => {
      expect(getPublicationRisk(createInputs({ direction, target }))).toEqual({
        canPublish: true,
        code: null,
        reason: null,
      });
    },
  );

  test.each([49_999, 50_000, 50_001])(
    'withholds target %i inside or on the latest book spread despite passing quote guards',
    (target) => {
      expect(getPublicationRisk(createInputs({ target }))).toMatchObject({
        canPublish: false,
        code: 'market-conditions',
        reason: 'The saved target is inside the current order-book spread.',
      });
    },
  );

  test.each([
    ['above', 50_250],
    ['below', 49_750],
  ])('withholds a midpoint that opposes a proposed %s call', (direction, target) => {
    expect(getPublicationRisk(createInputs({ direction, target }))).toMatchObject({
      canPublish: false,
      code: 'market-conditions',
      reason: 'The current order-book midpoint opposes the proposed fixed call.',
    });
  });

  test('derives midpoint from book prices even if a supplied midpoint disagrees', () => {
    const inputs = createInputs({ target: 50_250 });
    inputs.stream.liquidity.midpoint = 51_000;

    expect(getPublicationRisk(inputs).canPublish).toBe(false);
  });

  test.each([
    ['missing target', { target: undefined }],
    ['non-numeric target', { target: '49750' }],
    ['infinite target', { target: Infinity }],
    ['non-positive target', { target: 0 }],
  ])('requires a real saved target: %s', (_label, overrides) => {
    expect(getPublicationRisk(createInputs(overrides))).toMatchObject({
      canPublish: false,
      code: 'market-data-unavailable',
    });
  });

  test.each([
    ['missing bid', { bid: undefined }],
    ['missing ask', { ask: undefined }],
    ['non-numeric bid', { bid: '49999' }],
    ['infinite ask', { ask: Infinity }],
    ['zero bid', { bid: 0 }],
    ['negative ask', { ask: -1 }],
    ['crossed book', { bid: 50_002 }],
    ['locked book', { bid: 50_001 }],
  ])('rejects %s even if availability is incorrectly asserted', (_label, overrides) => {
    const inputs = createInputs();
    Object.assign(inputs.stream.liquidity, overrides);

    expect(getPublicationRisk(inputs)).toMatchObject({
      canPublish: false,
      code: 'market-data-unavailable',
    });
  });
});
