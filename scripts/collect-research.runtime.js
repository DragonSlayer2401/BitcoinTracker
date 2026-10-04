import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@libsql/client';
import { createCoinbaseStream } from '../src/services/coinbase/stream/coinbaseStream.service';
import { createDerivativesStream } from '../src/services/derivatives/derivativesStream.service';
import { createKalshiBenchmarkStream } from '../src/services/kalshi/benchmarkStream/benchmarkStream.service';
import { createResearchInputSnapshot } from '../src/features/BitcoinTracker/utils/researchExperiments.utils';
import { collectForwardResearchLabels, getCollectorAnalysis } from './collect-research.analysis';
import { createCollectorBackgroundTasks } from './collect-research.background';
import {
  fetchCoinbaseCandles,
  fetchCoinbaseTicker,
} from '../src/services/coinbase/coinbase.service';
import {
  createResearchRepository,
  getResearchDatabaseConfiguration,
} from '../src/services/research/research.repository';
import { createLearningService } from '../src/services/research/learning.service';
import { createPaperTradingRepository } from '../src/services/research/paperTrading/paperTrading.repository';
import { createPaperTradingService } from '../src/services/research/paperTrading/paperTrading.service';
import { createTradingAdvisorRepository } from '../src/services/research/tradingAdvisor/tradingAdvisor.repository';
import { createConfiguredTradingAdvisorService } from '../src/services/research/tradingAdvisor/tradingAdvisor.service';
import { createTradingPolicyTrialRepository } from '../src/services/research/tradingAdvisor/tradingPolicyTrials.repository';
import { createAdvisorHistoryTrialRepository } from '../src/services/research/tradingAdvisor/advisorHistoryTrials.repository';
import { getResearchForecast } from '../src/features/BitcoinTracker/utils/researchForecast.utils';
import { getKalshiMarketConditions } from '../src/features/BitcoinTracker/utils/kalshi/marketConditions.utils';
import {
  acquireCollectorLock,
  createCollectorStateStore,
  writeCollectorState,
} from './collect-research.storage';
import {
  fetchKalshiMarkets,
  fetchKalshiMarket,
  fetchKalshiBenchmark,
} from '../src/services/kalshi/kalshi.service';
import { isKalshiContract } from '../src/features/BitcoinTracker/utils/kalshi/contract.utils';
import {
  COLLECTOR_HEARTBEAT_VERSION,
  COLLECTOR_HEALTH_POLICY,
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
  COLLECTOR_FAILURE_MESSAGES,
  getCollectorFailureCode,
} from '../src/features/BitcoinTracker/utils/collectorHealth.utils';

/** Stop waiting without starting a competing operation against the same state file or database. */
export async function waitForCollectorTask(task, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      task,
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              Object.assign(new Error('Collector operation timed out.'), {
                code: 'COLLECTOR_OPERATION_TIMEOUT',
              }),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function getFreshStreamTicker(snapshot, now) {
  const ticker = snapshot?.ticker;
  return ticker &&
    Number.isFinite(ticker.receivedAt) &&
    ticker.receivedAt <= now &&
    now - ticker.receivedAt <= 5000 &&
    Number.isFinite(ticker.time) &&
    now - ticker.time <= 5000 &&
    ticker.time <= now
    ? ticker
    : null;
}

export function parseCollectorOptions(args, projectRoot = process.cwd()) {
  const options = {
    once: false,
    help: false,
    report: false,
    paperTrading: false,
    paperReport: false,
    tradingAdvisor: false,
    advisorReport: false,
    statePath: path.join(projectRoot, 'data/kalshi-collector-state.json'),
  };
  for (const argument of args) {
    if (argument === '--once') options.once = true;
    else if (argument === '--report') options.report = true;
    else if (argument === '--paper-trading') options.paperTrading = true;
    else if (argument === '--paper-report') options.paperReport = true;
    else if (argument === '--trading-advisor') options.tradingAdvisor = true;
    else if (argument === '--advisor-report') options.advisorReport = true;
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
  if (
    Number(options.once) +
      Number(options.report) +
      Number(options.paperReport) +
      Number(options.advisorReport) >
      1 ||
    ((options.paperTrading || options.tradingAdvisor) &&
      (options.once || options.report || options.paperReport || options.advisorReport))
  )
    throw new Error(
      'Use --paper-trading and/or --trading-advisor for continuous collection, or a report option by itself.',
    );
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
  createBenchmarkStream = createKalshiBenchmarkStream,
  loadTicker = fetchCoinbaseTicker,
  loadCandles = fetchCoinbaseCandles,
  loadMarkets = fetchKalshiMarkets,
  loadMarket = fetchKalshiMarket,
  loadBenchmark = fetchKalshiBenchmark,
  now = Date.now,
  sleep = (milliseconds) => delay(milliseconds, undefined, { signal }),
  log = (message) => console.log(message),
  operationTimeoutMs = 30_000,
  shutdownTimeoutMs = 5000,
  analyzeResearch = (options) => getCollectorAnalysis({ repository, ...options }),
  updateResearchModels = (options) => learningService.runLearningCycle(options),
  stopBackgroundTasks = async () => {},
  paperTradingService = null,
  tradingAdvisorService = null,
}) {
  const releaseLock = await acquireCollectorLock(statePath);
  let stream;
  let futuresStream;
  let benchmarkStream;
  const collectorId = randomUUID();
  const startedAt = now();
  let shutdownStatus = 'stopped';
  let lastEvidenceAt = null;
  let healthInputs = null;
  let healthMarket = null;
  let lastMarketQuoteAt = null;
  let hasRunningHeartbeat = false;
  let lastSuccessfulTickAt = null;
  let lastFailureAt = null;
  let failureCode = null;
  let storageFailures = 0;
  let nextStorageAttemptAt = 0;
  let pendingStateAdvance = null;
  const savedCandidatePredictions = new Map();
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
    labels: -Infinity,
    comparison: -Infinity,
    health: -Infinity,
  };
  const refresh = (name, task, message) => {
    if (tasks.has(name)) return tasks.get(name);
    lastRefresh[name] = now();
    const pending = task()
      .then(() => warnings.delete(name))
      .catch((error) => warn(name, typeof message === 'function' ? message(error) : message))
      .finally(() => tasks.delete(name));
    tasks.set(name, pending);
    return pending;
  };
  const publishHeartbeat = (status) => {
    if (!repository.writeCollectorHeartbeat) return Promise.resolve();
    return refresh(
      'health',
      async () => {
        const heartbeatAt = now();
        const observed = (time) =>
          Number.isSafeInteger(time) && time > 0 && time <= heartbeatAt ? time : null;
        await repository.writeCollectorHeartbeat({
          version: COLLECTOR_HEARTBEAT_VERSION,
          collectorId,
          codeVersion: CURRENT_COLLECTOR_CODE_VERSION,
          researchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
          startedAt,
          heartbeatAt,
          status,
          feeds: {
            benchmarkAt: observed(healthInputs?.benchmark?.current?.time),
            spotAt: observed(healthInputs?.ticker?.time),
            futuresAt: observed(healthInputs?.derivatives?.quality?.lastTradeAt),
            marketAt: observed(healthMarket?.receivedAt),
          },
          lastEvidenceAt,
          progress: { lastSuccessfulTickAt, lastFailureAt, failureCode },
          recording: {
            loadedCandidateIds: (models.challengers?.candidates ?? []).map((model) => model.id),
            savedCandidateIds: (models.challengers?.candidates ?? [])
              .filter((model) => savedCandidatePredictions.has(model.id))
              .map((model) => model.id),
            lastPredictionAt: observed(Math.max(0, ...savedCandidatePredictions.values())),
            lastMarketQuoteAt: observed(lastMarketQuoteAt),
          },
        });
      },
      'Collector health could not be saved; recording continues and the heartbeat will be retried.',
    );
  };
  try {
    publishHeartbeat('starting');
    const store = await createCollectorStateStore({
      statePath,
      assertOwnership: releaseLock.assertOwned,
      persistRows: async (rows) => {
        const result = await repository.persistEvidenceRows(rows);
        for (const row of rows) {
          if (Number.isSafeInteger(row.recordedAt) && row.recordedAt > 0 && row.recordedAt <= now())
            lastEvidenceAt = Math.max(lastEvidenceAt ?? 0, row.recordedAt);
          if (row.event !== 'decision') continue;
          for (const variant of Object.values(row.researchExperiment?.variants ?? {})) {
            if (variant.available && variant.modelId)
              savedCandidatePredictions.set(variant.modelId, row.recordedAt);
          }
          if (row.researchExperiment?.variants?.['market-blend']?.appliedMarket)
            lastMarketQuoteAt = row.recordedAt;
        }
        const proofEventIds = rows
          .filter((row) => row.event === 'decision')
          .map((row) => row.eventId);
        if (proofEventIds.length && learningService.enrollChallengerCandidates) {
          // Enrollment only inspects committed evidence. Its failure must not turn a
          // successful forecast write into a failed or reconstructed observation.
          refresh(
            'enrollment',
            async () => {
              await learningService.enrollChallengerCandidates({
                now: now(),
                collectorId,
                codeVersion: CURRENT_COLLECTOR_CODE_VERSION,
                researchVersion: CURRENT_COLLECTOR_RESEARCH_VERSION,
                candidateIds: (models.challengers?.candidates ?? []).map((model) => model.id),
                proofEventIds,
              });
            },
            'New-model recording verification failed; normal forecasts continue and verification will retry at the next saved checkpoint.',
          );
        }
        return result;
      },
    });
    stream = createStream();
    stream.start();
    futuresStream = createFuturesStream();
    futuresStream.start();
    benchmarkStream = createBenchmarkStream();
    benchmarkStream.start();
    await waitForCollectorTask(
      Promise.all([
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
            models = learningService.getResearchModels
              ? await learningService.getResearchModels()
              : await learningService.getLearningStatus();
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
              benchmarkStream.seed(benchmark);
            },
            'The official benchmark is unavailable; forecasts identify Coinbase as a proxy.',
          ),
        ],
      ]),
      operationTimeoutMs,
    ).catch((error) => {
      if (error.code !== 'COLLECTOR_OPERATION_TIMEOUT') throw error;
      warn(
        'startup',
        'Some startup tasks are still waiting. Available feeds will continue; pending tasks are not duplicated.',
      );
    });
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
      const receivedSnapshot = stream.getSnapshot(observedAt);
      const streamTicker = getFreshStreamTicker(receivedSnapshot, observedAt);
      // An exchange clock can lead local receipt. Exclude an ineligible ticker from
      // both the calculation and its archived stream snapshot until that time arrives.
      const snapshot = { ...receivedSnapshot, ticker: streamTicker };
      const causalRestTicker =
        restTicker?.time <= observedAt && restTicker?.receivedAt <= observedAt ? restTicker : null;
      const ticker = streamTicker ?? causalRestTicker;
      const kalshiMarket = markets.find(
        (market) =>
          isKalshiContract(market) &&
          market.startsAt <= observedAt &&
          market.expiresAt > observedAt,
      );
      const streamedBenchmark = benchmarkStream.getSnapshot(observedAt);
      const inputs = {
        candles,
        ticker,
        benchmark: streamedBenchmark?.available ? streamedBenchmark : benchmark,
        stream: snapshot,
        derivatives: futuresStream.getSnapshot(observedAt),
      };
      healthInputs = inputs;
      healthMarket = kalshiMarket;
      if (
        !hasRunningHeartbeat ||
        observedAt - lastRefresh.health >= COLLECTOR_HEALTH_POLICY.heartbeatIntervalMs
      ) {
        publishHeartbeat('running');
        hasRunningHeartbeat = true;
      }
      const capturedModels = models;
      // Both prospective experiments capture the same production forecast contract. Each owns
      // its own cadence, immutable policy, account and execution evidence.
      for (const [taskName, service] of [
        ['paper-trading', paperTradingService],
        ['trading-advisor', tradingAdvisorService],
      ]) {
        if (!service) continue;
        refresh(
          taskName,
          () =>
            service.advance({
              market: kalshiMarket,
              getForecast: () => {
                const capturedInput = {
                  ...inputs,
                  kalshiMarket,
                  target: kalshiMarket?.target,
                  expiresAt: kalshiMarket?.expiresAt,
                  now: observedAt,
                  horizonMinutes: (kalshiMarket?.expiresAt - observedAt) / 60_000,
                };
                const estimate = getResearchForecast(
                  capturedInput,
                  capturedModels,
                  kalshiMarket?.startsAt,
                );
                const researchInputSnapshot = createResearchInputSnapshot(
                  capturedInput,
                  capturedModels,
                  kalshiMarket?.startsAt,
                  estimate,
                );
                return {
                  available: estimate.available && researchInputSnapshot.timing.replayable,
                  reason: estimate.reason ?? null,
                  aboveProbability: estimate.aboveProbability,
                  capturedAt: observedAt,
                  modelVersion: estimate.modelVersion,
                  modelId: estimate.learning?.modelId ?? null,
                  referencePrice: estimate.kalshi?.referencePrice ?? null,
                  referenceAt: estimate.kalshi?.referenceAt ?? null,
                  referenceReceivedAt: estimate.kalshi?.referenceReceivedAt ?? null,
                  referenceSource: estimate.kalshi?.referenceSource ?? null,
                  volatility: estimate.volatility ?? null,
                  minuteVolatility:
                    estimate.kalshi?.minuteVolatility ??
                    estimate.pressure?.components?.minuteVolatility ??
                    null,
                  researchInputSnapshot,
                };
              },
            }),
          (error) => {
            // Expose a known category for diagnosis, never raw database paths or network errors.
            const category =
              {
                ADVISOR_RECORD_INVALID: 'adviser-record-invalid',
                ADVISOR_STORAGE_CORRUPT: 'adviser-integrity-check',
                ADVISOR_LEASE_LOST: 'adviser-lease-lost',
              }[error?.code] ?? getCollectorFailureCode(error);
            return `${taskName === 'trading-advisor' ? 'Trading adviser' : 'Paper trading'} could not advance (${category}). Saved decisions and capital reservations are retained; forecast research continues.`;
          },
        );
      }
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
          capturedModels,
        ).available
      ) {
        throw new Error(
          'Collector smoke check could not obtain fresh, valid price and candle inputs with a supported contract.',
        );
      }
      if (observedAt >= nextStorageAttemptAt)
        try {
          pendingStateAdvance = store.advance({
            now: observedAt,
            ticker,
            stream: inputs.stream,
            markets: [...markets, ...settledMarkets.values()],
            benchmark: inputs.benchmark,
            getEstimate: ({
              target,
              now: time,
              expiresAt,
              kalshiMarket: recordedMarket,
              kalshiQuote,
            }) => {
              const capturedInput = {
                ...inputs,
                target,
                now: time,
                expiresAt,
                ...(recordedMarket ? { kalshiMarket: recordedMarket } : {}),
                kalshiQuote,
                horizonMinutes: (expiresAt - time) / 60_000,
              };
              const estimate = getResearchForecast(
                capturedInput,
                capturedModels,
                expiresAt - 900_000,
              );
              return {
                ...estimate,
                researchInputSnapshot: createResearchInputSnapshot(
                  capturedInput,
                  capturedModels,
                  expiresAt - 900_000,
                  estimate,
                ),
              };
            },
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
          const result = await waitForCollectorTask(pendingStateAdvance, operationTimeoutMs);
          pendingStateAdvance = null;
          lastSuccessfulTickAt = now();
          failureCode = null;
          storageFailures = 0;
          nextStorageAttemptAt = 0;
          warnings.delete('storage');
          const status = `${result.status.phase}:${result.status.expiresAt ?? result.status.nextStartAt}`;
          if (status !== lastStatus || result.rowsWritten) {
            log(
              `Research ${result.status.phase}; ${result.rowsWritten} event(s) saved. ${result.status.nextStartAt ? `Next contract boundary ${new Date(result.status.nextStartAt).toISOString()}.` : 'Waiting for an official Kalshi contract.'}`,
            );
            lastStatus = status;
          }
        } catch (error) {
          if (error.code !== 'COLLECTOR_OPERATION_TIMEOUT') pendingStateAdvance = null;
          lastFailureAt = now();
          failureCode = getCollectorFailureCode(error);
          if (
            once ||
            [
              'COLLECTOR_OPERATION_TIMEOUT',
              'COLLECTOR_STATE_INVALID',
              'COLLECTOR_LOCK_LOST',
            ].includes(error.code)
          )
            throw error;
          storageFailures++;
          // Keep retries within a checkpoint's five-second grace, using only the next tick's data.
          nextStorageAttemptAt =
            now() + Math.min(5000, 1000 * 2 ** Math.min(storageFailures - 1, 3));
          warn(
            'storage',
            `Research recording failed (${failureCode}). ${COLLECTOR_FAILURE_MESSAGES[failureCode]} No replacement forecast is invented.`,
          );
        }
      if (once) {
        await collectForwardResearchLabels({
          repository,
          benchmark: inputs.benchmark,
          now: observedAt,
          statePath,
        });
        const analysis = await analyzeResearch({ now: observedAt });
        await writeCollectorState(`${statePath}.comparison.json`, analysis);
        const status = await repository.getResearchStatus();
        log(
          `Collector check complete: ${status.mode}, ${status.evidenceCount} stored evidence event(s), stream ${snapshot.status}. A complete 15-minute outcome was not implied by this check.`,
        );
        log(
          `Research comparisons checked; replay ${analysis.replay.matched} matched, ${analysis.replay.failed} failed; ${analysis.forwardLabels.observed} observed forward labels. Report: ${statePath}.comparison.json`,
        );
        if (analysis.replay.failed)
          throw new Error(
            'Saved prediction replay failed. Inspect the comparison report; original records are retained.',
          );
        return { status, streamStatus: snapshot.status, analysis };
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
      if (
        observedAt - lastRefresh.benchmark >=
        (inputs.benchmark?.transport === 'kalshi-websocket' && inputs.benchmark.available
          ? 60_000
          : 2000)
      ) {
        refresh(
          'benchmark',
          async () => {
            benchmark = await loadBenchmark({ expiresAt: kalshiMarket?.expiresAt });
            benchmarkStream.seed(benchmark);
          },
          'The official benchmark is unavailable; forecasts identify Coinbase as a proxy.',
        );
      }
      if (observedAt - lastRefresh.labels >= 5000) {
        refresh(
          'labels',
          async () => {
            await collectForwardResearchLabels({
              repository,
              benchmark: inputs.benchmark,
              now: observedAt,
              statePath,
            });
          },
          'Forward BRTI labels could not be saved; captures remain pending and will be retried.',
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
                  const settledMarket = await loadMarket(tickerId);
                  await tradingAdvisorService?.observeOutcome?.(settledMarket);
                  settledMarkets.set(tickerId, settledMarket);
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
      if (
        elapsed > 330_000 &&
        elapsed < 840_000 &&
        observedAt - lastRefresh.comparison >= 300_000
      ) {
        refresh(
          'comparison',
          async () => {
            const analysis = await analyzeResearch({ now: now() });
            await writeCollectorState(`${statePath}.comparison.json`, analysis);
            log(
              `Research comparisons updated; replay ${analysis.replay.matched} matched, ${analysis.replay.failed} failed; forward labels ${analysis.forwardLabels.observed} observed / ${analysis.forwardLabels.missing} missing. Report: ${statePath}.comparison.json`,
            );
          },
          'Model comparison analysis could not complete; saved inputs and outcomes are retained.',
        );
      }
      if (elapsed > 330_000 && elapsed < 840_000 && observedAt - lastRefresh.learning >= 300_000) {
        refresh(
          'learning',
          async () => {
            const report = await updateResearchModels({ now: now() });
            // Reports contain outcome statistics, not forecasting inputs. Snapshot only
            // frozen artifacts so collector and browser use the same compact contract.
            models = {
              active: report.active,
              candidate: report.candidate,
              earlyCandidate: report.earlyCandidate,
              challengers: {
                active: report.challengers?.active ?? null,
                candidates: report.challengers?.candidates ?? [],
              },
            };
          },
          'Research analysis could not complete; the previously loaded model remains in use.',
        );
      }
      await sleep(1000);
    }
  } catch (error) {
    shutdownStatus = signal?.aborted ? 'stopped' : 'error';
    throw error;
  } finally {
    benchmarkStream?.stop();
    futuresStream?.stop();
    stream?.stop();
    let canReleaseLock = true;
    try {
      await waitForCollectorTask(stopBackgroundTasks(), shutdownTimeoutMs);
      await waitForCollectorTask(
        Promise.allSettled([
          ...tasks.values(),
          ...(pendingStateAdvance ? [pendingStateAdvance] : []),
        ]),
        shutdownTimeoutMs,
      );
      await waitForCollectorTask(publishHeartbeat(shutdownStatus), shutdownTimeoutMs);
      if (paperTradingService)
        await waitForCollectorTask(paperTradingService.stop(shutdownStatus), shutdownTimeoutMs);
      if (tradingAdvisorService)
        await waitForCollectorTask(tradingAdvisorService.stop(shutdownStatus), shutdownTimeoutMs);
    } catch {
      canReleaseLock = false;
      log(
        'Collector shutdown is waiting on an unfinished operation. Its state lock was retained; stop this process before removing only its lock file.',
      );
    }
    if (canReleaseLock) await releaseLock();
  }
}

export async function runCollectorCommand(args) {
  const options = parseCollectorOptions(args);
  if (options.help) {
    console.log(
      'Usage: npm run research:collect -- [--once | --report | --paper-report | --advisor-report | --paper-trading --trading-advisor] [--state-file=data/kalshi-collector-state.json]\nRequires Node 24. Records real Kalshi 12/9/6/3/1-minute checkpoints, paired variants, replay inputs, forward BRTI labels and official results. --once checks one current recorder step and local comparisons; it does not imply a completed outcome. --report analyzes saved comparisons and replays the latest 100 captured inputs, without opening market feeds or training models. --paper-trading records the original entry-and-hold experiment. --trading-advisor records position-aware buy/hold/sell advice and delayed simulated execution in a separate $100 account; these two collection flags may be combined. --paper-report and --advisor-report print their respective saved results without market requests, fitting, or starting collection.',
    );
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let client;
  let background;
  try {
    const configuration = getResearchDatabaseConfiguration();
    if (configuration.mode === 'local-database')
      await mkdir(path.dirname(fileURLToPath(configuration.url)), { recursive: true });
    client = createClient(configuration);
    const repository = createResearchRepository({ client, mode: configuration.mode });
    const paperTradingService =
      options.paperTrading || options.paperReport
        ? createPaperTradingService({ repository: createPaperTradingRepository({ client }) })
        : null;
    const tradingAdvisorService =
      options.tradingAdvisor || options.advisorReport
        ? createConfiguredTradingAdvisorService({
            repository: createTradingAdvisorRepository({ client }),
            trialRepository: createTradingPolicyTrialRepository({ client }),
            historyTrialRepository: createAdvisorHistoryTrialRepository({ client }),
          })
        : null;
    if (options.advisorReport) {
      console.log(JSON.stringify(await tradingAdvisorService.getReport(), null, 2));
      return;
    }
    if (options.paperReport) {
      console.log(JSON.stringify(await paperTradingService.getReport(), null, 2));
      return;
    }
    if (options.report) {
      const analysis = await getCollectorAnalysis({
        repository,
        now: Date.now(),
        replayLimit: 100,
      });
      console.log(JSON.stringify(analysis, null, 2));
      if (analysis.replay.failed) process.exitCode = 1;
      return;
    }
    background = createCollectorBackgroundTasks();
    await runResearchCollector({
      ...options,
      repository,
      learningService: createLearningService(repository),
      signal: controller.signal,
      analyzeResearch: () => background.run('analysis'),
      updateResearchModels: () => background.run('learning'),
      stopBackgroundTasks: () => background.close(),
      paperTradingService,
      tradingAdvisorService,
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(`Collector stopped: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await background?.close();
    client?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
