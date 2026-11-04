import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCoinbaseStream } from '@/services/coinbase/stream/coinbaseStream.service';
import { createDerivativesStream } from '@/services/derivatives/derivativesStream.service';
import { createKalshiBenchmarkStream } from '@/services/kalshi/benchmarkStream/benchmarkStream.service';
import { createResearchInputSnapshot } from '../../utils/researchExperiments.utils';
import { getCollectorAnalysis } from './utils/collectorAnalysis.utils';
import { fetchCoinbaseCandles, fetchCoinbaseTicker } from '@/services/coinbase/coinbase.service';
import { getResearchForecast } from '../../utils/researchForecast.utils';
import {
  createAdvisorForecast,
  getAdvisorBookQuote,
} from '@/features/SimulatedTrading/features/TradingAdvisor/utils/advisorForecast.utils';
import { getKalshiMarketConditions } from '@/features/Forecasting/features/LiveEstimates/utils/kalshi/marketConditions.utils';
import {
  acquireCollectorLock,
  collectForwardResearchLabels,
  createCollectorStateStore,
  writeCollectorState,
} from '@/services/research/collectorStorage.service';
import {
  fetchKalshiMarkets,
  fetchKalshiMarket,
  fetchKalshiBenchmark,
} from '@/services/kalshi/kalshi.service';
import { isKalshiContract } from '@/features/MarketData/utils/kalshi/contract.utils';
import { getKalshiQuoteSnapshot } from '@/features/MarketData/utils/kalshi/marketQuote.utils';
import {
  COLLECTOR_HEARTBEAT_VERSION,
  COLLECTOR_HEALTH_POLICY,
  CURRENT_COLLECTOR_CODE_VERSION,
  CURRENT_COLLECTOR_RESEARCH_VERSION,
  COLLECTOR_FAILURE_MESSAGES,
  getCollectorFailureCode,
} from './utils/collectorHealth.utils';

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

function getObservedTicker(ticker, now) {
  return ticker &&
    Number.isSafeInteger(ticker.time) &&
    ticker.time > 0 &&
    ticker.time <= now &&
    Number.isSafeInteger(ticker.receivedAt) &&
    ticker.receivedAt > 0 &&
    ticker.receivedAt <= now
    ? ticker
    : null;
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
  patternResearchService = null,
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
      const causalRestTicker = getObservedTicker(restTicker, observedAt);
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
      // Prospective experiments share the production forecast contract. Pattern book capture
      // remains independent of every account's entry decisions.
      for (const [taskName, service] of [
        ['paper-trading', paperTradingService],
        ['pattern-research', patternResearchService],
        ['trading-advisor', tradingAdvisorService],
      ]) {
        if (!service) continue;
        refresh(
          taskName,
          () =>
            service.advance({
              market: kalshiMarket,
              getForecast: (execution) => {
                // Advice and delayed fills recapture live inputs after the execution book arrives.
                // The entry-and-hold paper experiment keeps its original tick capture.
                const capturedAt = execution ? execution.now : observedAt;
                const contract = execution ? execution.contract : kalshiMarket;
                let currentInputs = {
                  ...inputs,
                  kalshiQuote: getKalshiQuoteSnapshot(kalshiMarket, observedAt),
                };
                if (execution) {
                  const currentStream = stream.getSnapshot(capturedAt);
                  const currentTicker = getFreshStreamTicker(currentStream, capturedAt);
                  const currentBenchmark = benchmarkStream.getSnapshot(capturedAt);
                  currentInputs = {
                    candles: candles?.filter(
                      (candle) =>
                        Number.isSafeInteger(candle.time) &&
                        candle.time <= capturedAt &&
                        (candle.receivedAt === undefined ||
                          (Number.isSafeInteger(candle.receivedAt) &&
                            candle.receivedAt <= capturedAt)),
                    ),
                    ticker: currentTicker ?? getObservedTicker(restTicker, capturedAt),
                    benchmark: currentBenchmark?.available ? currentBenchmark : benchmark,
                    stream: { ...currentStream, ticker: currentTicker },
                    derivatives: futuresStream.getSnapshot(capturedAt),
                    kalshiQuote: getAdvisorBookQuote({
                      contract,
                      book: execution.book,
                      now: capturedAt,
                    }),
                  };
                }
                const capturedInput = {
                  ...currentInputs,
                  kalshiMarket: contract,
                  target: contract?.target,
                  expiresAt: contract?.expiresAt,
                  now: capturedAt,
                  horizonMinutes: (contract?.expiresAt - capturedAt) / 60_000,
                };
                return createAdvisorForecast(capturedInput, capturedModels, contract?.startsAt);
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
            const label =
              taskName === 'pattern-research'
                ? 'Pattern book collection'
                : taskName === 'trading-advisor'
                  ? 'Trading adviser'
                  : 'Paper trading';
            return `${label} could not advance (${category}). Saved decisions and capital reservations are retained; forecast research continues.`;
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
              patterns: {
                candidates: report.patterns?.candidates ?? [],
                active: report.patterns?.active ?? null,
                suites: report.patterns?.suites ?? [],
              },
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
      if (patternResearchService)
        await waitForCollectorTask(patternResearchService.stop(), shutdownTimeoutMs);
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
