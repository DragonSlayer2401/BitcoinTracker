import 'server-only';
import { fetchKalshiPurchaseValue } from '@/services/kalshi/purchaseValue/purchaseValue.service';
import { getKalshiContract } from '@/features/BitcoinTracker/utils/kalshi/contract.utils';
import { PAPER_TRADING_POLICY } from '@/features/BitcoinTracker/features/PaperTrading/utils/paperTrading.utils';

const copy = (value) => JSON.parse(JSON.stringify(value));

/** Observe both sides on a fixed schedule, independently of model probabilities or trade intent. */
export function createPatternResearchService({
  repository,
  loadBook = fetchKalshiPurchaseValue,
  now = Date.now,
}) {
  let advancing;
  let pending = null;
  const completed = new Set();
  const policy = PAPER_TRADING_POLICY;
  const stage = (contract, name, extra = {}) => ({
    version: 'pattern-paper-observation-v2',
    id: `${contract.ticker}:${name}`,
    ticker: contract.ticker,
    contract,
    stage: name,
    recordedAt: now(),
    ...extra,
  });
  async function save(value) {
    // Preserve the exact observed book across uncertain writes, including nested quote arrays.
    pending = copy(value);
    await repository.save(pending);
    pending = null;
  }
  async function observeBook(contract, name) {
    const requestedAt = now();
    let book = null;
    try {
      book = { ...(await loadBook(contract.ticker)), requestedAt };
    } catch {
      /* Missing coverage is retained. */
    }
    await save(stage(contract, name, { requestedAt, observedAt: now(), book }));
  }
  async function advanceOnce({ market, getForecast }) {
    if (pending) await save(pending);
    const contract = getKalshiContract(market);
    const capturedAt = now();
    if (!contract || completed.has(contract.ticker)) return;
    const checkpointAt = contract.expiresAt - policy.checkpointMinutes * 60_000;
    if (capturedAt < checkpointAt || capturedAt >= contract.expiresAt) return;
    let stages = await repository.readStages(contract.ticker);
    if (!stages.claim) {
      const timely = now() <= checkpointAt + policy.captureGraceMs;
      const estimate = timely ? getForecast() : null;
      const forecast = {
        available: estimate?.available === true,
        aboveProbability: estimate?.aboveProbability ?? null,
        capturedAt: estimate?.capturedAt ?? capturedAt,
        modelVersion: estimate?.modelVersion ?? null,
      };
      const expected = estimate?.researchInputSnapshot?.expectedPatterns ?? estimate;
      const claimed = await repository.claim(
        stage(contract, 'claim', {
          capturedAt: forecast.capturedAt,
          forecast,
          patternShadowPredictions: copy(expected?.patternShadowPredictions ?? []),
          patternLearningFeatures: copy(expected?.patternLearningFeatures ?? null),
          patternSuites: copy(estimate?.researchInputSnapshot?.models?.patterns?.suites ?? []),
        }),
      );
      if (claimed && timely) await observeBook(contract, 'initial');
      else if (claimed)
        await save(
          stage(contract, 'initial', { requestedAt: null, observedAt: now(), book: null }),
        );
      stages = await repository.readStages(contract.ticker);
    }
    // A request claimed before a crash gets missing coverage, never a favorable retry.
    if (!stages.initial) {
      if (now() <= stages.claim.recordedAt + policy.maximumFillDelayMs) return;
      await save(
        stage(contract, 'initial', {
          requestedAt: null,
          observedAt: stages.claim.recordedAt,
          book: null,
        }),
      );
      stages = await repository.readStages(contract.ticker);
    }
    if (stages.execution) {
      completed.add(contract.ticker);
      return;
    }
    const initialAt = stages.initial.observedAt;
    if (now() < initialAt + policy.minimumFillDelayMs) return;
    if (
      stages['delay-claim'] &&
      now() <= stages['delay-claim'].recordedAt + policy.maximumFillDelayMs
    )
      return;
    const claimed = await repository.claim(stage(contract, 'delay-claim'));
    if (claimed && stages.initial.book && now() <= initialAt + policy.maximumFillDelayMs)
      await observeBook(contract, 'execution');
    else
      await save(
        stage(contract, 'execution', { requestedAt: null, observedAt: now(), book: null }),
      );
    completed.add(contract.ticker);
    if (completed.size > 1000) completed.delete(completed.values().next().value);
  }
  return {
    advance(input) {
      if (!advancing)
        advancing = advanceOnce(input).finally(() => {
          advancing = null;
        });
      return advancing;
    },
    async stop() {
      if (advancing) await advancing;
      if (pending) await save(pending);
    },
  };
}
