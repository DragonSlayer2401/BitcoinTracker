import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const help = `Read-only exploratory directional comparison (requires Node.js with node:sqlite).

pnpm research:compare-directions [--database PATH] [--as-of ISO_TIMESTAMP] [--max-sequence INTEGER] [--json]

Defaults: data/bitcoin-research.db, command start time, latest evidence sequence.
Reproduce the original snapshot:
pnpm research:compare-directions --as-of 2026-09-18T20:27:17.505Z --max-sequence 9031

No network requests, database writes, model fitting, or activation. Historical results are exploratory.
`;

async function run() {
  const { values } = parseArgs({
    options: {
      database: { type: 'string' },
      'as-of': { type: 'string' },
      'max-sequence': { type: 'string' },
      json: { type: 'boolean' },
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
  const requestedSequence = values['max-sequence'];
  if (
    requestedSequence !== undefined &&
    (!/^\d+$/.test(requestedSequence) || !Number.isSafeInteger(Number(requestedSequence)))
  )
    throw new Error('--max-sequence must be a nonnegative safe integer.');

  const databasePath = path.resolve(projectRoot, values.database ?? 'data/bitcoin-research.db');
  process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
  await import('tsx');
  const { compareExploratoryDirections, EXPLORATORY_RESEARCH_VERSIONS } =
    await import('../../src/features/BitcoinTracker/utils/exploratoryDirections.utils.js');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let report;
  try {
    // Hold one read snapshot while freezing the sequence and selecting its immutable evidence.
    database.exec('BEGIN');
    const latestSequence =
      database.prepare('SELECT MAX(sequence) AS value FROM evidence_events').get().value ?? 0;
    const maxEvidenceSequence =
      requestedSequence === undefined ? latestSequence : Number(requestedSequence);
    if (maxEvidenceSequence > latestSequence)
      throw new Error('--max-sequence exceeds the database snapshot.');
    const records = database
      .prepare(
        `SELECT payload FROM evidence_events
         WHERE sequence <= ? AND (
           json_extract(payload, '$.event') = 'outcome'
           OR json_extract(payload, '$.researchExperiment.version') IN (${EXPLORATORY_RESEARCH_VERSIONS.map(() => '?').join(', ')})
         ) ORDER BY sequence`,
      )
      .all(maxEvidenceSequence, ...EXPLORATORY_RESEARCH_VERSIONS);
    report = {
      snapshot: { databasePath, asOf: new Date(asOf).toISOString(), maxEvidenceSequence },
      ...compareExploratoryDirections(
        records.map((record) => JSON.parse(record.payload)),
        { asOf },
      ),
    };
    database.exec('ROLLBACK');
  } finally {
    database.close();
  }

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.analysisVersion}: ${report.warning}`);
  console.log(
    `Snapshot: ${report.snapshot.asOf}; evidence sequence <= ${report.snapshot.maxEvidenceSequence}`,
  );
  console.log(`Database: ${report.snapshot.databasePath}`);
  console.log(`Supported research versions: ${JSON.stringify(report.supportedResearchVersions)}`);
  console.log(`Required baseline: ${report.baselineVersion}; native BRTI features only.`);
  console.log(report.splitPolicy);
  console.log(report.weighting);
  console.log(JSON.stringify(report.counts, null, 2));
  for (const rule of report.rules) console.log(`${rule.id}: ${rule.description}`);
  const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`);
  for (const partition of ['development', 'holdout']) {
    const result = report[partition];
    console.log(
      `\n${partition}: ${result.contracts} contracts, ${result.independentGroups} independent groups, ${result.rows} captures`,
    );
    console.log(
      `Near target: ${result.nearTargetRows}; pressure agreement usable: ${result.pressureAgreementRows}; market usable: ${result.usableMarketRows}`,
    );
    console.table(
      result.comparisons.flatMap(({ checkpointMinutes, rules }) =>
        rules.map((rule) => ({
          minutes: checkpointMinutes ?? 'all',
          rule: rule.rule,
          captures: rule.rows,
          groups: rule.independentGroups,
          correct: rule.correct,
          accuracy: percent(rule.accuracy),
          weightedAccuracy: percent(rule.groupWeightedAccuracy),
          actualReversals: rule.actualReversals,
          beneficial: rule.beneficialChanges,
          harmful: rule.harmfulChanges,
          netCorrect: rule.netCorrectChange,
        })),
      ),
    );
  }
}

try {
  await run();
} catch (error) {
  console.error(`Comparison failed: ${error.message}`);
  process.exitCode = 1;
}
