/** @jest-environment node */
import { createClient } from '@libsql/client';
import { createResearchRepository } from '../../../services/research/research.repository';
import { validateResearchInputSnapshot } from '../../../services/research/research.validation';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { createResearchInputSnapshot } from '../utils/researchExperiments.utils';
import { getEvidenceRow } from '../utils/evidenceStorage.utils';
import { getForwardResearchLabels } from '../utils/researchForwardLabels.utils';
import { createKalshiForecastRecord } from '../utils/kalshi/forecastRecord.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

jest.mock('server-only', () => ({}));

const START = Date.UTC(2026, 8, 14, 12);
const CAPTURE = START + 180_000;
const contract = {
  ticker: 'KXBTC15M-FORWARD',
  eventTicker: 'KXBTC15M-FORWARD',
  seriesTicker: 'KXBTC15M',
  startsAt: START,
  expiresAt: START + 900_000,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
const samples = Array.from({ length: 1201 }, (_, index) => ({
  time: CAPTURE - (1200 - index) * 1000,
  price: 50_000 * Math.exp(Math.sin(index / 30) * 0.0001),
}));
const input = {
  kalshiMarket: contract,
  now: CAPTURE,
  candles: [],
  ticker: { price: 50_000, bid: 49_999, ask: 50_001, time: CAPTURE, receivedAt: CAPTURE },
  benchmark: { available: true, samples, current: samples.at(-1), receivedAt: CAPTURE },
};

function makeDecision(referenceOverrides = {}) {
  const estimate = getResearchForecast(input, {}, START);
  const entry = {
    ...createKalshiForecastRecord({
      id: 'forward-capture',
      contract,
      createdAt: CAPTURE,
      price: 50_000,
    }),
    status: 'pending',
    aboveProbability: estimate.aboveProbability,
    belowProbability: estimate.belowProbability,
    direction: estimate.direction,
    modelVersion: estimate.modelVersion,
    kalshi: estimate.kalshi,
  };
  return {
    ...getEvidenceRow({
      entry,
      event: 'decision',
      now: CAPTURE,
      inputObservedAt: CAPTURE,
      ticker: input.ticker,
      estimate,
      researchInputSnapshot: createResearchInputSnapshot(input, {}, START, estimate),
    }),
    ...referenceOverrides,
  };
}

function makeLabels(decision, now = CAPTURE + 180_000) {
  const readings = [15, 60, 180].map((seconds) => ({
    time: CAPTURE + seconds * 1000,
    price: 50_010 + seconds,
    receivedAt: CAPTURE + seconds * 1000,
  }));
  return getForwardResearchLabels([{ decision }], { samples: readings, receivedAt: now }, now);
}

let client;
let repository;
let decision;
beforeEach(async () => {
  client = createClient({ url: 'file::memory:' });
  repository = createResearchRepository({ client });
  decision = makeDecision();
  await repository.persistEvidenceRows([decision]);
});
afterEach(() => client.close());

test('stores labels for the exact original anchor and retries identical content idempotently', async () => {
  const labels = makeLabels(decision);
  expect(await repository.persistForwardLabels(labels)).toEqual({ inserted: 3, duplicates: 0 });
  expect(await repository.persistForwardLabels(labels)).toEqual({ inserted: 0, duplicates: 3 });
  expect(await repository.getForwardResearchLabels()).toEqual(labels);
  const changed = { ...labels[0], recordedAt: labels[0].recordedAt + 1 };
  await expect(repository.persistForwardLabels([changed])).rejects.toMatchObject({ status: 409 });
  expect(await repository.getForwardResearchLabels()).toEqual(labels);
});

test.each([
  [
    'different forecast',
    (label) => {
      label.forecastId = 'different-forecast';
    },
  ],
  [
    'different reference price',
    (label) => {
      label.reference.price += 100;
      label.logReturn = Math.log(label.reading.price / label.reference.price);
    },
  ],
  [
    'different source time',
    (label) => {
      label.reference.time -= 1000;
    },
  ],
  [
    'different source',
    (label) => {
      label.reference.source = 'coinbase-proxy';
    },
  ],
  [
    'unknown version',
    (label) => {
      label.version = 'brti-forward-label-v99';
    },
  ],
  [
    'invalid status',
    (label) => {
      label.status = 'pending';
    },
  ],
  [
    'receipt before reading',
    (label) => {
      label.reading.receivedAt = label.reading.time - 1;
    },
  ],
  [
    'receipt after recording',
    (label) => {
      label.reading.receivedAt = label.recordedAt + 1;
    },
  ],
  [
    'reference received after capture',
    (label) => {
      label.reference.receivedAt = CAPTURE + 1;
    },
  ],
  [
    'reference receipt before price',
    (label) => {
      label.reference.receivedAt = label.reference.time - 1;
    },
  ],
  [
    'noncanonical reference',
    (label) => {
      label.reference.time -= 1;
    },
  ],
  [
    'changed return',
    (label) => {
      label.logReturn += 0.001;
    },
  ],
  [
    'unknown input snapshot',
    (label) => {
      label.snapshotId = 'absent';
      label.labelId = 'absent:forward:15';
    },
  ],
])('rejects %s without storing any replacement outcome', async (_name, modify) => {
  const label = makeLabels(decision)[0];
  modify(label);
  await expect(repository.persistForwardLabels([label])).rejects.toThrow();
  expect(await repository.getForwardResearchLabels()).toEqual([]);
});

test('an original-reference mismatch rolls back the whole otherwise valid label batch', async () => {
  const labels = makeLabels(decision);
  labels[1].forecastId = 'wrong-forecast';
  await expect(repository.persistForwardLabels(labels)).rejects.toMatchObject({ status: 409 });
  expect(await repository.getForwardResearchLabels()).toEqual([]);
});

test.each([
  { referenceSource: 'coinbase-proxy' },
  { referenceSource: null, spot: null, quoteTime: null, receivedAt: null },
])(
  'missing labels retain original nullable/proxy references without inventing returns: %j',
  async (reference) => {
    const missingDecision = makeDecision(reference);
    missingDecision.eventId = 'missing-reference:decision';
    missingDecision.forecastId = 'missing-reference';
    await repository.persistEvidenceRows([missingDecision]);
    const labels = makeLabels(missingDecision);
    expect(labels).toHaveLength(3);
    expect(
      labels.every(
        (label) => label.status === 'missing' && label.reading === null && label.logReturn === null,
      ),
    ).toBe(true);
    expect(await repository.persistForwardLabels(labels)).toEqual({ inserted: 3, duplicates: 0 });
    expect(await repository.getForwardResearchLabels()).toEqual(labels);
  },
);

test.each(['reading', 'logReturn'])('missing status cannot carry an observed %s', async (field) => {
  const label = makeLabels(decision)[0];
  label.status = 'missing';
  label.reason = 'exact-forward-brti-reading-unavailable';
  if (field === 'reading') label.logReturn = null;
  else label.reading = null;
  await expect(repository.persistForwardLabels([label])).rejects.toThrow('Invalid forward');
});

test('missing labels are still bound to the originally recorded source', async () => {
  const label = makeLabels(decision)[0];
  Object.assign(label, {
    status: 'missing',
    reading: null,
    logReturn: null,
    reason: 'exact-forward-brti-reading-unavailable',
  });
  label.reference.source = 'coinbase-proxy';
  await expect(repository.persistForwardLabels([label])).rejects.toMatchObject({ status: 409 });
});

test('withheld decisions retain raw replay estimates without inventing published probabilities', async () => {
  const withheld = {
    ...JSON.parse(JSON.stringify(decision)),
    eventId: 'withheld-reference:decision',
    forecastId: 'withheld-reference',
    decision: 'withheld',
    capturedAt: null,
    aboveProbability: null,
    belowProbability: null,
    direction: 'neutral',
    modelVersion: 'kalshi-snapshot-v4',
  };
  const originalInput = JSON.parse(JSON.stringify(withheld.researchInputSnapshot));
  expect(originalInput.expectedExperiment.production.aboveProbability).not.toBeNull();
  expect(originalInput.expectedExperiment.production.modelVersion).not.toBe(withheld.modelVersion);
  await expect(repository.persistEvidenceRows([withheld])).resolves.toMatchObject({ inserted: 1 });
  const stored = await repository.readResearchInputSnapshot(withheld.eventId);
  expect(stored.snapshot).toEqual(originalInput);
  const labels = makeLabels(withheld);
  await expect(repository.persistForwardLabels(labels)).resolves.toEqual({
    inserted: 3,
    duplicates: 0,
  });
});

test.each([
  [
    'capture marker',
    (row) => {
      row.inputStatus = 'restored-without-inputs';
    },
  ],
  [
    'capture timestamp',
    (row) => {
      row.capturedAt += 1;
    },
  ],
  [
    'different event identity',
    (row) => {
      row.researchInputSnapshot.input.kalshiMarket.eventTicker = 'KXBTC15M-OTHER';
    },
  ],
  [
    'invalid contract rules',
    (row) => {
      row.researchInputSnapshot.input.kalshiMarket.comparison = 'greater';
    },
  ],
  [
    'experiment time',
    (row) => {
      row.researchExperiment.capturedAt += 1;
      row.researchInputSnapshot.expectedExperiment.capturedAt += 1;
    },
  ],
  [
    'production prediction',
    (row) => {
      row.researchExperiment.production.aboveProbability += 0.001;
      row.researchInputSnapshot.expectedExperiment.production.aboveProbability += 0.001;
    },
  ],
  [
    'published model version',
    (row) => {
      row.modelVersion = 'different-published-model';
    },
  ],
])(
  'replay storage rejects changed %s even when compact metadata was changed to match',
  (_name, modify) => {
    const changed = JSON.parse(JSON.stringify(decision));
    modify(changed);
    expect(() => validateResearchInputSnapshot(changed)).toThrow('Replay inputs');
  },
);
