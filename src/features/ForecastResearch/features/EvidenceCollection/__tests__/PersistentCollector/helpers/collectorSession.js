import { runResearchCollector } from '../../../runResearchCollector';
import { createHash } from 'node:crypto';
import { KALSHI_OUTCOME_DEFINITION } from '@/features/MarketData/utils/kalshi/contract.utils';
import { validateResearchInputSnapshot } from '@/services/research/research.validation';

export const eventStart = Date.UTC(2026, 10, 6, 12);
export const eventEnd = eventStart + 900_000;
export const contract = {
  ticker: 'KXBTC15M-26NOV061215-15',
  eventTicker: 'KXBTC15M-26NOV061215',
  seriesTicker: 'KXBTC15M',
  startsAt: eventStart,
  expiresAt: eventEnd,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
};

const copy = (value) => JSON.parse(JSON.stringify(value));

// The repository is the collector's external archive boundary. Production recorder,
// forecast calculation, atomic state files, locks and forward labels run unchanged.
export const createArchive = () => {
  const evidence = new Map();
  const labels = new Map();
  const heartbeats = [];
  const snapshots = new Map();
  const replayPointers = new Map();
  const repository = {
    persistEvidenceRows: jest.fn(async (rows) => {
      for (const row of rows) {
        if (evidence.has(row.eventId)) continue;
        if (row.researchInputSnapshot) {
          const json = validateResearchInputSnapshot(row);
          const contentHash = createHash('sha256').update(json).digest('hex');
          snapshots.set(row.eventId, {
            snapshotId: row.eventId,
            contentHash,
            snapshot: JSON.parse(json),
          });
          replayPointers.set(row.eventId, {
            status: 'stored',
            snapshotId: row.eventId,
            contentHash,
            replayable: row.researchInputSnapshot.timing?.replayable === true,
          });
        }
        evidence.set(row.eventId, copy(row));
      }
      return { inserted: rows.length };
    }),
    persistForwardLabels: jest.fn(async (rows) => {
      for (const row of rows) if (!labels.has(row.labelId)) labels.set(row.labelId, copy(row));
      return { inserted: rows.length };
    }),
    getPendingForwardCaptures: async () =>
      [...evidence.values()]
        .filter((row) => row.event === 'decision' && row.featureCutoffAt !== null)
        .map((decision) => ({
          decision,
          completedHorizons: [...labels.values()]
            .filter((label) => label.snapshotId === decision.eventId)
            .map((label) => label.horizonSeconds),
        })),
    writeCollectorHeartbeat: async (heartbeat) => heartbeats.push(copy(heartbeat)),
    getLearningEvidenceRows: jest.fn(async () =>
      [...evidence.values()].map((row) => {
        const { researchInputSnapshot, ...stored } = copy(row);
        const researchReplay = replayPointers.get(row.eventId);
        return researchReplay ? { ...stored, researchReplay: copy(researchReplay) } : stored;
      }),
    ),
    getForwardResearchLabels: async () => copy([...labels.values()]),
    readResearchInputSnapshot: jest.fn(async (snapshotId) =>
      snapshots.has(snapshotId) ? copy(snapshots.get(snapshotId)) : null,
    ),
    readCollectorHeartbeats: async () => copy(heartbeats),
    readModelArtifacts: async () => [],
    getActiveModelArtifact: async () => null,
    getResearchStatus: async () => ({
      mode: 'isolated-test-archive',
      evidenceCount: evidence.size,
    }),
  };
  return { repository, evidence, labels, heartbeats, snapshots };
};

export const createCollectorSession = ({
  statePath,
  archive = createArchive(),
  startTime = eventStart + 180_000,
  price = 50_100,
} = {}) => {
  let clock = startTime;
  let spot = price;
  const controller = new AbortController();
  const logs = [];
  const createFeed = () => {
    const samples = Array.from({ length: 1201 }, (_, index) => ({
      time: Math.floor(clock / 1000) * 1000 - (1200 - index) * 1000,
      price: spot * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
      receivedAt: clock,
    }));
    return {
      ticker: {
        price: spot,
        bid: spot - 1,
        ask: spot + 1,
        volume: 100,
        time: clock,
        receivedAt: clock,
      },
      benchmark: { available: true, receivedAt: clock, current: samples.at(-1), samples },
      candles: Array.from({ length: 120 }, (_, index) => {
        const open = spot * Math.exp(Math.sin((index - 120) / 5) * 0.0005);
        const close = spot * Math.exp(Math.sin((index - 119) / 5) * 0.0005);
        return {
          time: Math.floor(clock / 60_000) * 60_000 - (120 - index) * 60_000,
          open,
          close,
          high: Math.max(open, close) * 1.0002,
          low: Math.min(open, close) * 0.9998,
          volume: 5 + (index % 7),
        };
      }),
    };
  };
  const streams = [
    {
      start: jest.fn(),
      stop: jest.fn(),
      getSnapshot: () => ({
        status: 'live',
        ticker: createFeed().ticker,
        quality: { confirmedThrough: clock },
      }),
    },
    { start: jest.fn(), stop: jest.fn(), getSnapshot: () => ({}) },
    {
      start: jest.fn(),
      stop: jest.fn(),
      seed: jest.fn(),
      getSnapshot: () => createFeed().benchmark,
    },
  ];
  const learningService = { getResearchModels: async () => ({}) };
  return {
    archive,
    logs,
    streams,
    controller,
    learningService,
    now: () => clock,
    setTime: (time) => (clock = time),
    setPrice: (value) => (spot = value),
    run: (overrides = {}) =>
      runResearchCollector({
        once: true,
        statePath,
        repository: archive.repository,
        learningService,
        signal: controller.signal,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        log: (message) => logs.push(message),
        createStream: () => streams[0],
        createFuturesStream: () => streams[1],
        createBenchmarkStream: () => streams[2],
        loadTicker: async () => createFeed().ticker,
        loadCandles: async () => createFeed().candles,
        loadMarkets: async () => ({ markets: [{ ...contract, receivedAt: clock }] }),
        loadMarket: async () => ({ ...contract, status: 'closed', receivedAt: clock }),
        loadBenchmark: async () => createFeed().benchmark,
        updateResearchModels: async () => ({}),
        ...overrides,
      }),
  };
};
