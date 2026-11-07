import { parseArgs } from 'node:util';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { loadEventDatasetSources } from '../src/services/research/eventDatasets/eventDatasetSources.service';
import { buildEventDataset } from '../src/features/ForecastResearch/features/EventDatasets/utils/eventDataset.utils';
import {
  inspectEventDataset,
  serializeEventDataset,
  writeEventDataset,
} from '../src/services/research/eventDatasets/eventDataset.repository';
import { fetchKalshiEventHistory } from '../src/services/kalshi/history/kalshiEventHistory.service';
import { getCanonicalResearchJson } from '../src/services/research/research.validation';

const help = `Contract datasets and deterministic as-of replay. No model training or orders.

pnpm research:dataset build --output NEW_DIRECTORY [sources] [--freshness-ms N] [--lookback-ms N]
pnpm research:dataset replay --dataset DIRECTORY [same sources]
pnpm research:dataset inspect --dataset DIRECTORY
pnpm research:dataset history --output NEW_FILE [--ticker KXBTC15M-...] [--reference-hour ISO_UTC]

Sources (repeatable): --kalshi-directory PATH --spot-file PATH --history-file PATH
Use --synthetic only for explicitly synthetic recording fixtures.
All commands accept --json. Build/replay/inspect are offline and never load credentials.
Build writes events.jsonl, snapshots.jsonl, separate labels.jsonl, quality.json and manifest.json.
Default lookback 900000 ms; freshness 5000 ms; fixed horizons 12/9/6/3/1 minutes.
Missing, unresolved and excluded evidence remains in the quality report.
Historical data uses actual fetch time and unknown original availability; no historical
order books are synthesized from candles or results. History requires applicable Kalshi/CF
entitlement and uses the existing shared rate limiter. Use an isolated limiter for checks.
`;
const integer = (value, fallback) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
    throw new Error('Dataset limits must be positive integers.');
  return Number(value);
};

export const runEventDatasetCommand = async (
  args,
  {
    write = (text) => process.stdout.write(text),
    loadSources = loadEventDatasetSources,
    fetchHistory = fetchKalshiEventHistory,
  } = {},
) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: 'string' },
      dataset: { type: 'string' },
      'kalshi-directory': { type: 'string', multiple: true },
      'spot-file': { type: 'string', multiple: true },
      'history-file': { type: 'string', multiple: true },
      ticker: { type: 'string', multiple: true },
      'reference-hour': { type: 'string', multiple: true },
      'freshness-ms': { type: 'string' },
      'lookback-ms': { type: 'string' },
      synthetic: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !positionals.length) {
    write(help);
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !['build', 'replay', 'inspect', 'history'].includes(command))
    throw new Error('Choose build, replay, inspect or history.');
  const sourceNames = ['kalshi-directory', 'spot-file', 'history-file', 'synthetic'];
  const allowed = {
    build: ['output', 'freshness-ms', 'lookback-ms', ...sourceNames],
    replay: ['dataset', ...sourceNames],
    inspect: ['dataset'],
    history: ['output', 'ticker', 'reference-hour'],
  };
  if (Object.keys(values).some((key) => ![...allowed[command], 'json'].includes(key)))
    throw new Error('Option does not belong to this command.');
  const report = (value) => write(`${JSON.stringify(value, null, values.json ? undefined : 2)}\n`);
  if (command === 'history') {
    if (!values.output) throw new Error('History needs a new output file.');
    const referenceHours = (values['reference-hour'] ?? []).map((value) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value))
        throw new Error('Use a UTC hour boundary.');
      return Date.parse(value);
    });
    const supplement = await fetchHistory({ tickers: values.ticker ?? [], referenceHours });
    const filename = path.resolve(values.output);
    await mkdir(path.dirname(filename), { recursive: true });
    const handle = await open(filename, 'wx', 0o600);
    try {
      await handle.writeFile(`${getCanonicalResearchJson(supplement, 64 * 1024 * 1024)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const result = { filename, coverage: supplement.coverage, requests: supplement.requests };
    report(result);
    return result;
  }
  if (command === 'inspect') {
    if (!values.dataset) throw new Error('Inspect needs --dataset.');
    const result = await inspectEventDataset(values.dataset);
    report(result);
    return result;
  }
  if (!sourceNames.slice(0, 3).some((key) => values[key]?.length))
    throw new Error('Choose at least one recorded or historical source.');
  const previous = command === 'replay' ? await inspectEventDataset(values.dataset) : null;
  const sourceData = await loadSources({
    kalshiDirectories: values['kalshi-directory'] ?? [],
    spotFiles: values['spot-file'] ?? [],
    historicalFiles: values['history-file'] ?? [],
    synthetic: values.synthetic === true,
  });
  const configuration = previous?.manifest.configuration ?? {
    freshnessMs: integer(values['freshness-ms'], 5000),
    lookbackMs: integer(values['lookback-ms'], 900_000),
  };
  const dataset = buildEventDataset({ ...sourceData, ...configuration });
  if (command === 'replay') {
    const encoded = serializeEventDataset(dataset);
    const result = {
      matches: encoded.manifest.datasetId === previous.manifest.datasetId,
      expectedDatasetId: previous.manifest.datasetId,
      actualDatasetId: encoded.manifest.datasetId,
      counts: encoded.manifest.counts,
    };
    report(result);
    if (!result.matches) throw new Error('Dataset replay differs from the saved artifacts.');
    return result;
  }
  if (!values.output) throw new Error('Build needs a new output directory.');
  const result = await writeEventDataset(values.output, dataset);
  report(result);
  return result;
};
