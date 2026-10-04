import 'server-only';
import { createHash } from 'node:crypto';
import {
  createAdvisorLanguageModelProvider,
  getAdvisorLanguageModelConfiguration,
} from './advisorLanguageModel.service';

const observationId = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** Observe existing collector data after its execution lease ends; inference never blocks it. */
export function createAdvisorHistoryTrialService({
  repository,
  policy,
  now = Date.now,
  provider,
  configuration = getAdvisorLanguageModelConfiguration(),
}) {
  const model =
    provider ??
    createAdvisorLanguageModelProvider({
      configuration,
      now,
      reserveBudget: repository.reserveBudget,
      completeReservation: repository.completeReservation,
    });
  let registration = null;
  let running = null;
  let stopped = false;
  let lastError = null;
  let hasRecordingGap = false;
  const controller = new AbortController();
  async function start() {
    registration ??= repository.ensureTrial(policy, model.configuration, now()).catch((error) => {
      registration = null;
      lastError = 'shadow_registration_unavailable';
      hasRecordingGap = true;
      throw error;
    });
    return registration;
  }
  function launch(state) {
    const request = state.strategies['language-model'].pendingRequest;
    if (stopped || running || !model.configuration.enabled || !request || request.result) return;
    running = (async () => {
      // Budget reservation is durable and global. A restart never retries the same paid
      // request; an abandoned reservation remains charged at its maximum estimate.
      const result = await model.invoke({
        requestId: request.requestId,
        evidence: request.evidence,
        signal: controller.signal,
      });
      await repository.record(state.id, {
        id: observationId(`response:${request.requestId}`),
        kind: 'response',
        requestId: request.requestId,
        evidence: request.evidence,
        result,
        observedAt: now(),
      });
    })()
      .catch(() => {
        lastError = 'response_archive_unavailable';
        hasRecordingGap = true;
      })
      .finally(() => {
        running = null;
      });
  }
  const service = {
    start,
    async observe(input) {
      try {
        const enrolled = await start();
        const observedAt = now();
        if (hasRecordingGap) {
          await repository.record(enrolled.id, {
            id: observationId(`gap:${observedAt}`),
            kind: 'gap',
            observedAt,
          });
          hasRecordingGap = false;
        }
        const captured = {
          ...input,
          capturedAt: input.observedAt,
          observedAt,
          id: observationId(`${input.kind ?? 'observation'}:${input.sourceId}:${input.observedAt}`),
          kind: input.kind ?? 'observation',
        };
        const state = await repository.record(enrolled.id, captured);
        launch(state);
        lastError = null;
      } catch {
        lastError = 'shadow_recording_unavailable';
        hasRecordingGap = true;
      }
    },
    async getReport() {
      try {
        return { ...(await repository.getReport(policy.id)), recordingError: lastError };
      } catch {
        return {
          status: 'unavailable',
          experimental: true,
          recordingError: 'shadow_report_unavailable',
          strategies: [],
        };
      }
    },
    async captureExecutionObservation(readBook) {
      if (stopped) return;
      try {
        const enrolled = await start();
        const at = now();
        const claim = await repository.claimExecutionObservation(enrolled.id, at);
        if (claim) {
          // All due candidate accounts share one request through the collector's
          // existing Kalshi limiter, after the incumbent execution lease ends.
          let book = null;
          try {
            book = await readBook(claim.contract.ticker, claim.deadline);
          } catch {
            // One failed observation cancels the order; it never triggers a retry.
          }
          await service.observe({
            kind: 'observation',
            contract: claim.contract,
            book,
            sourceId: claim.sourceId,
            observedAt: now(),
          });
          return;
        }
        const state = await repository.readState(enrolled.id);
        const expired = Object.values(state.strategies).some((strategy) =>
          strategy.account.pendingIntents.some(
            (intent) =>
              at > intent.evaluatedAt + intent.policy.maximumFillDelayMs ||
              at >= intent.contract.expiresAt,
          ),
        );
        if (expired)
          await service.observe({
            kind: 'observation',
            sourceId: `expired-orders:${at}`,
            observedAt: at,
          });
      } catch {
        lastError = 'shadow_execution_unavailable';
        hasRecordingGap = true;
      }
    },
    async stop() {
      stopped = true;
      controller.abort();
      if (running) await running;
    },
    // Used by mocked integration tests and orderly shutdown, never the collector's tick.
    async flush() {
      if (running) await running;
    },
  };
  return service;
}
