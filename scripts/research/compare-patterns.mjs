import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const help = `Read-only comparison of frozen pattern predictions and observed executable books.

node --conditions=react-server scripts/research/compare-patterns.mjs
  [--database PATH] [--as-of ISO_TIMESTAMP] [--max-sequence INTEGER]

Defaults: data/bitcoin-research.db, command start time, latest evidence sequence.
Outputs JSON. Requires Node.js with node:sqlite. No network, database writes,
historical backfill, fitting, orders or model activation. Saved model holdouts are
reported separately as exploratory; only issued frozen predictions are prospective.
Paper books prefer the independent pattern archive. Legacy paper books are explicitly
marked as production-selected coverage. Missing books never become synthetic fills.
`;

async function run() {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      'as-of': { type: 'string' },
      'max-sequence': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const asOf = values['as-of'] ? Date.parse(values['as-of']) : Date.now();
  if (
    !Number.isSafeInteger(asOf) ||
    asOf <= 0 ||
    (values['as-of'] && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(values['as-of']))
  )
    throw new Error('--as-of must be an ISO timestamp with an explicit timezone.');
  const requested = values['max-sequence'];
  if (
    requested !== undefined &&
    (!/^\d+$/.test(requested) || !Number.isSafeInteger(Number(requested)))
  )
    throw new Error('--max-sequence must be a nonnegative safe integer.');
  process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
  await import('tsx');
  const { evaluatePatternChallengers, getPatternPaperObservations } =
    await import('../../src/features/BitcoinTracker/utils/patternEvaluation.utils.js');
  const { combinePatternPaperObservations } =
    await import('../../src/services/research/patterns/patternResearch.repository.js');
  const { isPatternModelArtifact } =
    await import('../../src/features/BitcoinTracker/utils/learning/patternModel.utils.js');
  const { getPatternSuiteRegistrations } =
    await import('../../src/features/BitcoinTracker/utils/learning/patternCohorts.utils.js');
  const { DatabaseSync } = await import('node:sqlite');
  const databasePath = path.resolve(projectRoot, values.database ?? 'data/bitcoin-research.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const decode = (row) => {
    if (createHash('sha256').update(row.payload).digest('hex') !== row.content_hash)
      throw new Error('Archived evidence failed its content-hash integrity check.');
    return JSON.parse(row.payload);
  };
  let report;
  try {
    database.exec('BEGIN');
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const latest =
      database.prepare('SELECT MAX(sequence) AS value FROM evidence_events').get().value ?? 0;
    const maxEvidenceSequence = requested === undefined ? latest : Number(requested);
    if (maxEvidenceSequence > latest)
      throw new Error('--max-sequence exceeds the database snapshot.');
    const events = database
      .prepare(
        'SELECT payload, content_hash FROM evidence_events WHERE sequence <= ? AND recorded_at <= ? ORDER BY sequence',
      )
      .all(maxEvidenceSequence, asOf)
      .map(decode);
    let paperObservations = [];
    if (tables.has('pattern_paper_observations')) {
      const stages = database
        .prepare(
          'SELECT payload, content_hash FROM pattern_paper_observations ORDER BY ticker, stage',
        )
        .all()
        .map(decode)
        .filter((row) => row.recordedAt <= asOf);
      paperObservations = combinePatternPaperObservations(stages);
    }
    const independentTickers = new Set(paperObservations.map((entry) => entry.contract.ticker));
    if (tables.has('paper_decisions') && tables.has('paper_events')) {
      const legacy = getPatternPaperObservations({
        decisions: database
          .prepare(
            'SELECT payload, content_hash FROM paper_decisions WHERE decided_at <= ? ORDER BY decided_at, id',
          )
          .all(asOf)
          .map(decode),
        events: database
          .prepare(
            'SELECT payload, content_hash FROM paper_events WHERE recorded_at <= ? ORDER BY recorded_at, id',
          )
          .all(asOf)
          .map(decode),
        now: asOf,
      });
      paperObservations.push(
        ...legacy.filter((entry) => !independentTickers.has(entry.contract.ticker)),
      );
    }
    const artifacts = tables.has('model_artifacts')
      ? database
          .prepare(
            'SELECT payload, content_hash, saved_at FROM model_artifacts WHERE saved_at <= ? ORDER BY sequence',
          )
          .all(asOf)
          .map((row) => ({ ...decode(row), registeredAt: row.saved_at }))
          .filter(isPatternModelArtifact)
      : [];
    report = {
      snapshot: {
        databasePath,
        asOf: new Date(asOf).toISOString(),
        maxEvidenceSequence,
        bookSnapshot:
          'Book stages and model artifacts are additionally bounded by as-of; max-sequence bounds forecast/outcome evidence only.',
      },
      ...evaluatePatternChallengers(events, {
        now: asOf,
        paperObservations,
        patternSuites: getPatternSuiteRegistrations(artifacts),
      }),
      exploratoryHoldouts: artifacts.map((artifact) => ({
        id: artifact.id,
        suiteId: artifact.suiteId,
        kind: artifact.kind,
        trainedAt: artifact.trainedAt,
        evaluation: artifact.evaluation,
      })),
    };
    database.exec('ROLLBACK');
  } finally {
    database.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(`Pattern comparison failed: ${error.message}`);
  process.exitCode = 1;
}
