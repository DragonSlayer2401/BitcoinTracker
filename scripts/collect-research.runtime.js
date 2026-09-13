import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@libsql/client';
import { createCoinbaseStream } from '../src/services/coinbase/stream/coinbaseStream.service';
import { createDerivativesStream } from '../src/services/derivatives/derivativesStream.service';
import {
  fetchCoinbaseCandles,
  fetchCoinbaseTicker,
} from '../src/services/coinbase/coinbase.service';
import {
  createResearchRepository,
  getResearchDatabaseConfiguration,
} from '../src/services/research/research.repository';
import { createLearningService } from '../src/services/research/learning.service';
import { getResearchForecast } from '../src/features/BitcoinTracker/utils/researchForecast.utils';
import { getKalshiMarketConditions } from '../src/features/BitcoinTracker/utils/kalshi/marketConditions.utils';
import { acquireCollectorLock, createCollectorStateStore } from './collect-research.storage';
import {
  fetchKalshiMarkets,
  fetchKalshiMarket,
  fetchKalshiBenchmark,
} from '../src/services/kalshi/kalshi.service';
import { isKalshiContract } from '../src/features/BitcoinTracker/utils/kalshi/contract.utils';

function getFreshStreamTicker(snapshot, now) {
  const ticker = snapshot?.ticker;
  return ticker &&
    Number.isFinite(ticker.receivedAt) &&
    ticker.receivedAt <= now &&
    now - ticker.receivedAt <= 5000 &&
    Number.isFinite(ticker.time) &&
    now - ticker.time <= 5000 &&
    ticker.time <= now + 2000
    ? ticker
    : null;
}

export function parseCollectorOptions(args, projectRoot = process.cwd()) {
  const options = {
    once: false,
    help: false,
    statePath: path.join(projectRoot, 'data/kalshi-collector-state.json'),
  };
  for (const argument of args) {
    if (argument === '--once') options.once = true;
    else if (argument === '--help') options.help = true;
    else if (argument.startsWith('--state-file=')) {
      const selected = path.resolve(projectRoot, argument.slice('--state-file='.length));
      const relative = path.relative(path.join(projectRoot, 'data'), selected);
      if (
        !relative ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        path.extname(selected) !== '.json'
      ) {
        throw new Error('--state-file must name a JSON file inside the project data directory.');
      }
      options.statePath = selected;
    } else throw new Error('Unknown collector option. Use --help for supported options.');
  }
  return options;
}

export async function runResearchCollector({
  once = false,
  statePath,
  repository,
  learningService,
  signal,
  createStream = createCoinbaseStream,
  createFuturesStream = createDerivativesStream,
  loadTicker = fetchCoinbaseTicker,
  loadCandles = fetchCoinbaseCandles,
  loadMarkets = fetchKalshiMarkets,
  loadMarket = fetchKalshiMarket,
  loadBenchmark = fetchKalshiBenchmark,
  now = Date.now,
  sleep = (milliseconds) => delay(milliseconds, undefined, { signal }),
  log = (message) => console.log(message),
}) {
  const releaseLock = await acquireCollectorLock(statePath);
  let stream;
  let futuresStream;
  const tasks = new Map();
  const warnings = new Map();
  const warn = (key, message) => {
    if (warnings.get(key) !== message) log(message);
    warnings.set(key, message);
  };
  let candles = null;
  let restTicker = null;
  let models = {};
  let markets = [];
  let benchmark = null;
  const settledMarkets = new Map();
  const outcomeRefresh = new Map();
  let lastStatus = null;
  const lastRefresh = {
    ticker: -Infinity,
    candles: -Infinity,
    learning: -Infinity,
    markets: -Infinity,
    outcomes: -Infinity,
    benchmark: -Infinity,
  };
  const refresh = (name, task, message) => {
    if (tasks.has(name)) return tasks.get(name);
    lastRefresh[name] = now();
    const pending = task()
      .then(() => warnings.delete(name))
      .catch(() => warn(name, message))
      .finally(() => tasks.delete(name));
    tasks.set(name, pending);
    return pending;
  };
  try {
    const store = await createCollectorStateStore({
      statePath,
      persistRows: (rows) => repository.persistEvidenceRows(rows),
    });
    stream = createStream();
    stream.start();
    futuresStream = createFuturesStream();
    futuresStream.start();
    await Promise.all([
      refresh(
        'ticker',
        async () => {
          restTicker = await loadTicker();
        },
        'Coinbase ticker is unavailable; waiting for a fresh quote.',
      ),
      refresh(
        'candles',
        async () => {
          candles = await loadCandles();
        },
        'Coinbase candle history is unavailable; estimates will wait for valid history.',
      ),
      refresh(
        'learning',
        async () => {
          models = await learningService.getLearningStatus();
        },
        'Model status is unavailable; the current pressure baseline will be used.',
      ),
      ...[
        refresh(
          'markets',
          async () => {
            markets = (await loadMarkets()).markets;
          },
          'Kalshi markets are unavailable; research waits for official targets and deadlines.',
        ),
        refresh(
          'benchmark',
          async () => {
            benchmark = await loadBenchmark();
          },
          'The official benchmark is unavailable; forecasts identify Coinbase as a proxy.',
        ),
      ],
    ]);
    const smokeDeadline = now() + 10_000;
    if (once) {
      while (!signal?.aborted && now() < smokeDeadline) {
        const checkedAt = now();
        const snapshot = stream.getSnapshot(checkedAt);
        if (
          getFreshStreamTicker(snapshot, checkedAt) &&
          Number.isFinite(snapshot.quality?.confirmedThrough)
        )
          break;
        await sleep(250);
      }
    }
    while (!signal?.aborted) {
      const observedAt = now();
      const snapshot = stream.getSnapshot(observedAt);
      const streamTicker = getFreshStreamTicker(snapshot, observedAt);
      const ticker = streamTicker ?? restTicker;
      const kalshiMarket = markets.find(
        (market) =>
          isKalshiContract(market) &&
          market.startsAt <= observedAt &&
          market.expiresAt > observedAt,
      );
      const inputs = {
        candles,
        ticker,
        benchmark,
        stream: snapshot,
        derivatives: futuresStream.getSnapshot(observedAt),
      };
      if (
        once &&
        !getResearchForecast(
          {
            ...inputs,
            target: kalshiMarket?.target,
            kalshiMarket,
            expiresAt: kalshiMarket?.expiresAt,
            now: observedAt,
            horizonMinutes: (kalshiMarket?.expiresAt - observedAt) / 60_000,
          },
          models,
        ).available
      ) {
        throw new Error(
          'Collector smoke check could not obtain fresh, valid price and candle inputs with a supported contract.',
        );
      }
      try {
        const result = await store.advance({
          now: observedAt,
          ticker,
          stream: inputs.stream,
          markets: [...markets, ...settledMarkets.values()],
          benchmark,
          getEstimate: ({ target, now: time, expiresAt, kalshiMarket: recordedMarket }) =>
            getResearchForecast(
              {
                ...inputs,
                target,
                now: time,
                expiresAt,
                ...(recordedMarket ? { kalshiMarket: recordedMarket } : {}),
                horizonMinutes: (expiresAt - time) / 60_000,
              },
              models,
              expiresAt - 900_000,
            ),
          getConditions: ({
            target,
            now: time,
            expiresAt,
            forecast,
            kalshiMarket: recordedMarket,
          }) =>
            getKalshiMarketConditions({
              ...inputs,
              target,
              now: time,
              horizonMinutes: (expiresAt - time) / 60_000,
              forecast,
              ...(recordedMarket ? { kalshiMarket: recordedMarket } : {}),
            }),
        });
        warnings.delete('storage');
        const status = `${result.status.phase}:${result.status.expiresAt ?? result.status.nextStartAt}`;
        if (status !== lastStatus || result.rowsWritten) {
          log(
            `Research ${result.status.phase}; ${result.rowsWritten} event(s) saved. ${result.status.nextStartAt ? `Next contract boundary ${new Date(result.status.nextStartAt).toISOString()}.` : 'Waiting for an official Kalshi contract.'}`,
          );
          lastStatus = status;
        }
      } catch (error) {
        if (once) throw error;
        warn(
          'storage',
          'Research storage failed. Original pending events are retained and will be retried; no replacement forecast is invented.',
        );
      }
      if (once) {
        const status = await repository.getResearchStatus();
        log(
          `Collector check complete: ${status.mode}, ${status.evidenceCount} stored evidence event(s), stream ${snapshot.status}. A complete 15-minute outcome was not implied by this check.`,
        );
        return { status, streamStatus: snapshot.status };
      }
      if (observedAt - lastRefresh.markets >= 15_000) {
        refresh(
          'markets',
          async () => {
            markets = (await loadMarkets()).markets;
          },
          'Kalshi markets could not be refreshed; existing contract targets remain immutable.',
        );
      }
      if (observedAt - lastRefresh.benchmark >= 2000) {
        refresh(
          'benchmark',
          async () => {
            benchmark = await loadBenchmark({ expiresAt: kalshiMarket?.expiresAt });
          },
          'The official benchmark is unavailable; forecasts identify Coinbase as a proxy.',
        );
      }
      if (observedAt - lastRefresh.outcomes >= 5000) {
        refresh(
          'outcomes',
          async () => {
            const pending = store.getState()?.markets ?? [];
            const tickers = new Set(pending.map((saved) => saved.contract.ticker));
            for (const tickerId of settledMarkets.keys())
              if (!tickers.has(tickerId)) settledMarkets.delete(tickerId);
            for (const tickerId of outcomeRefresh.keys())
              if (!tickers.has(tickerId)) outcomeRefresh.delete(tickerId);
            const due = pending
              .filter(
                (saved) =>
                  saved.contract.expiresAt <= now() &&
                  now() - (outcomeRefresh.get(saved.contract.ticker) ?? 0) >= 15_000,
              )
              .slice(0, 10);
            await Promise.all(
              due.map(async (saved) => {
                const tickerId = saved.contract.ticker;
                outcomeRefresh.set(tickerId, now());
                try {
                  settledMarkets.set(tickerId, await loadMarket(tickerId));
                } catch {
                  warn(
                    'official-outcome',
                    'An official Kalshi result is pending; no price-derived outcome will replace it.',
                  );
                }
              }),
            );
          },
          'Official Kalshi outcomes could not be refreshed; unresolved contracts are retained.',
        );
      }
      if (!streamTicker && observedAt - lastRefresh.ticker >= 5000) {
        refresh(
          'ticker',
          async () => {
            restTicker = await loadTicker();
          },
          'Coinbase ticker is unavailable; waiting for a fresh quote.',
        );
      }
      if (observedAt - lastRefresh.candles >= 30_000) {
        refresh(
          'candles',
          async () => {
            candles = await loadCandles();
          },
          'Coinbase candle history is unavailable; estimates will wait for valid history.',
        );
      }
      // Fit/evaluate away from the opening five seconds and fixed-capture window.
      const elapsed = observedAt % 900_000;
      if (elapsed > 330_000 && elapsed < 840_000 && observedAt - lastRefresh.learning >= 300_000) {
        refresh(
          'learning',
          async () => {
            models = await learningService.runLearningCycle({ now: now() });
          },
          'Research analysis could not complete; the previously loaded model remains in use.',
        );
      }
      await sleep(1000);
    }
  } finally {
    futuresStream?.stop();
    stream?.stop();
    await Promise.allSettled([...tasks.values()]);
    await releaseLock();
  }
}

export async function runCollectorCommand(args) {
  const options = parseCollectorOptions(args);
  if (options.help) {
    console.log(
      'Usage: pnpm research:collect [--once] [--state-file=data/kalshi-collector-state.json]\nRequires Node 24. Records real Kalshi contracts at 12/9/6/3/1 minutes remaining and official finalized results. --once performs one recorder step and exits; it never fabricates a historical forecast or outcome.',
    );
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let client;
  try {
    const configuration = getResearchDatabaseConfiguration();
    if (configuration.mode === 'local-database')
      await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
    client = createClient(configuration);
    const repository = createResearchRepository({ client, mode: configuration.mode });
    await runResearchCollector({
      ...options,
      repository,
      learningService: createLearningService(repository),
      signal: controller.signal,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`Collector stopped: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    client?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
