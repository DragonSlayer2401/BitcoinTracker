import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    database: { type: 'string' },
    policy: { type: 'string' },
    advice: { type: 'string' },
    'as-of': { type: 'string' },
    'max-sequence': { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log(`Read-only comparison of saved adviser entry forecasts against the execution book.

node scripts/research/compare-advisor-forecasts.mjs [--database PATH] [--policy ID]
  [--as-of ISO_TIMESTAMP] [--max-sequence INTEGER]
node scripts/research/compare-advisor-forecasts.mjs --advice ID [--database PATH]

Defaults: local research database, current configured policy, command start time,
latest event sequence. Outputs JSON. Requires Node.js with node:sqlite.
--advice replays archived inputs, then substitutes each saved entry/fill book.
That historical counterfactual cannot recover the current inputs at purchase time.
No network requests, database writes, historical backfill, fitting or activation.`);
} else {
  const asOf = values['as-of'] ? Date.parse(values['as-of']) : Date.now();
  if (
    !Number.isSafeInteger(asOf) ||
    asOf <= 0 ||
    (values['as-of'] && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(values['as-of']))
  )
    throw new Error('--as-of must include an explicit timezone.');
  const requestedSequence = values['max-sequence'];
  if (
    requestedSequence !== undefined &&
    (!/^\d+$/.test(requestedSequence) || !Number.isSafeInteger(Number(requestedSequence)))
  )
    throw new Error('--max-sequence must be a nonnegative safe integer.');

  process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
  await import('tsx');
  const { getAdvisorForecastEvaluation } =
    await import('../../src/features/BitcoinTracker/features/TradingAdvisor/utils/advisorForecastEvaluation.utils.js');
  const { createAdvisorForecast, getAdvisorBookQuote } =
    await import('../../src/features/BitcoinTracker/features/TradingAdvisor/utils/advisorForecast.utils.js');
  const { replayResearchInputSnapshot, RESEARCH_EXPERIMENT_VERSION } =
    await import('../../src/features/BitcoinTracker/utils/researchExperiments.utils.js');
  const { isSameKalshiContract } =
    await import('../../src/features/BitcoinTracker/utils/kalshi/contract.utils.js');
  const { MAXIMUM_RESEARCH_INPUT_BYTES } =
    await import('../../src/services/research/research.validation.js');
  const databasePath = path.resolve(projectRoot, values.database ?? 'data/bitcoin-research.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const decode = (row) => {
    if (!row) throw new Error('The requested adviser evidence is unavailable.');
    if (createHash('sha256').update(row.payload).digest('hex') !== row.content_hash)
      throw new Error('Saved adviser evidence failed its integrity check.');
    return JSON.parse(row.payload);
  };
  const summarize = (forecast) => ({
    available: forecast.available,
    reason: forecast.reason,
    capturedAt: forecast.capturedAt,
    aboveProbability: forecast.aboveProbability,
    modelVersion: forecast.modelVersion,
    modelId: forecast.modelId,
    marketProbability: forecast.marketProbability,
    marketQuoteReceivedAt: forecast.marketQuoteReceivedAt,
    marketBlend: forecast.marketBlend,
    activeMarketBlend: forecast.activeMarketBlend,
  });
  try {
    database.exec('BEGIN');
    const latestSequence =
      database.prepare('SELECT MAX(sequence) AS value FROM advisor_events').get().value ?? 0;
    const maxSequence =
      requestedSequence === undefined ? latestSequence : Number(requestedSequence);
    if (maxSequence > latestSequence) throw new Error('--max-sequence exceeds the saved snapshot.');
    let report;
    if (values.advice !== undefined) {
      if (!values.advice.trim()) throw new Error('--advice must name a saved advice ID.');
      const advice = decode(
        database
          .prepare(
            'SELECT payload, content_hash FROM advisor_advice WHERE id = ? AND evaluated_at <= ?',
          )
          .get(values.advice, asOf),
      );
      if (values.policy && values.policy !== advice.policyId)
        throw new Error('--policy does not match the requested advice.');
      const archive = database
        .prepare('SELECT encoding, payload, content_hash FROM advisor_inputs WHERE advice_id = ?')
        .get(advice.id);
      if (!archive || archive.encoding !== 'gzip-json')
        throw new Error('The requested advice has no supported archived input snapshot.');
      const payload = gunzipSync(archive.payload, {
        maxOutputLength: MAXIMUM_RESEARCH_INPUT_BYTES,
      }).toString('utf8');
      const saved = decode({ payload, content_hash: archive.content_hash });
      if (saved.expectedExperiment?.version !== RESEARCH_EXPERIMENT_VERSION)
        throw new Error('Historical book substitution requires the current research generation.');
      if (
        !isSameKalshiContract(saved.input?.kalshiMarket, advice.contract) ||
        saved.capturedAt > advice.evaluatedAt ||
        saved.capturedAt !== advice.forecast?.capturedAt
      )
        throw new Error('The archived inputs do not match the saved advice contract and capture.');
      const replayed = replayResearchInputSnapshot(saved);
      if (
        replayed.aboveProbability !== advice.forecast.aboveProbability ||
        replayed.modelVersion !== advice.forecast.modelVersion ||
        (replayed.learning?.modelId ?? null) !== (advice.forecast.modelId ?? null)
      )
        throw new Error('The replayed production forecast does not match the saved advice.');
      const original = createAdvisorForecast(saved.input, saved.models, saved.windowStartAt);
      const executionRow = database
        .prepare(
          `SELECT payload, content_hash FROM advisor_events
         WHERE id = ? AND sequence <= ? AND recorded_at <= ?`,
        )
        .get(`${advice.id}:execution`, maxSequence, asOf);
      const execution = executionRow ? decode(executionRow) : null;
      if (
        execution &&
        (execution.adviceId !== advice.id ||
          execution.policyId !== advice.policyId ||
          !isSameKalshiContract(execution.contract, advice.contract))
      )
        throw new Error('The saved execution does not match the requested advice.');
      const observations = [
        { role: 'advice-book', book: advice.book, observedAt: advice.evaluatedAt },
      ];
      if (execution)
        observations.push({
          role: 'execution-book',
          book: execution.book,
          observedAt: execution.recordedAt,
        });
      report = {
        mode: 'historical-book-substitution',
        warning:
          'Archived underlying inputs are held fixed while the saved book and calculation time are substituted. This is not a current-input recomputation or prospective evidence, and does not establish a stale-data bug or model improvement.',
        snapshot: {
          adviceId: advice.id,
          policyId: advice.policyId,
          asOf: new Date(asOf).toISOString(),
          maxSequence,
          researchVersion: saved.expectedExperiment.version,
          originalCapturedAt: saved.capturedAt,
          replayMatched: true,
        },
        original: summarize(original),
        bookSubstitutions: observations.map(({ role, book, observedAt }) => {
          if (!Number.isSafeInteger(observedAt) || observedAt < saved.capturedAt)
            throw new Error('A saved book observation precedes the archived forecast inputs.');
          const quote = getAdvisorBookQuote({ contract: advice.contract, book, now: observedAt });
          const forecast = createAdvisorForecast(
            {
              ...saved.input,
              now: observedAt,
              horizonMinutes: (advice.contract.expiresAt - observedAt) / 60_000,
              kalshiQuote: quote,
            },
            saved.models,
            saved.windowStartAt,
          );
          return {
            role,
            observedAt,
            bookRequestedAt: book?.requestedAt ?? null,
            bookReceivedAt: book?.receivedAt ?? null,
            elapsedSinceOriginalMs: observedAt - saved.capturedAt,
            bookAvailable: quote !== null,
            ...summarize(forecast),
          };
        }),
      };
    } else {
      const configuration = database
        .prepare('SELECT payload, content_hash FROM advisor_configuration WHERE id = 1')
        .get();
      const policyId =
        values.policy ?? (configuration ? decode(configuration).policy.id : 'kalshi-advisor-v1');
      const events = database
        .prepare(
          `SELECT payload, content_hash FROM advisor_events
        WHERE policy_id = ? AND sequence <= ? AND recorded_at <= ? ORDER BY sequence`,
        )
        .all(policyId, maxSequence, asOf)
        .map(decode);
      report = {
        snapshot: { policyId, asOf: new Date(asOf).toISOString(), maxSequence },
        ...getAdvisorForecastEvaluation(events),
      };
    }
    console.log(JSON.stringify(report, null, 2));
    database.exec('ROLLBACK');
  } finally {
    database.close();
  }
}
