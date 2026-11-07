import { createHash } from 'node:crypto';
import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { getCanonicalResearchJson } from '../research.validation';

const maximumArtifactBytes = 256 * 1024 * 1024;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => getCanonicalResearchJson(value, maximumArtifactBytes);
const filenames = ['events.jsonl', 'snapshots.jsonl', 'labels.jsonl', 'quality.json'];
const jsonLines = (rows) => rows.map((row) => `${canonical(row)}\n`).join('');

export const serializeEventDataset = (dataset) => {
  if (dataset?.schemaVersion !== 'event-dataset-v1') throw new Error('Unsupported event dataset.');
  const artifacts = {
    'events.jsonl': jsonLines(dataset.events),
    'snapshots.jsonl': jsonLines(dataset.snapshots),
    'labels.jsonl': jsonLines(dataset.labels),
    'quality.json': `${canonical(dataset.quality)}\n`,
  };
  const files = {};
  for (const [name, text] of Object.entries(artifacts)) {
    const bytes = Buffer.byteLength(text);
    if (bytes > maximumArtifactBytes)
      throw new Error('Dataset artifact exceeds the local 256 MiB export limit.');
    files[name] = { bytes, sha256: hash(text) };
  }
  const identity = {
    schemaVersion: 'event-dataset-manifest-v1',
    configuration: dataset.configuration,
    files,
  };
  const manifest = {
    ...identity,
    datasetId: `sha256:${hash(canonical(identity))}`,
    counts: {
      events: dataset.events.length,
      snapshots: dataset.snapshots.length,
      labels: dataset.labels.length,
    },
  };
  return { artifacts, manifest, manifestText: `${canonical(manifest)}\n` };
};

const writeExclusive = async (filename, text) => {
  const handle = await open(filename, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** A new output directory only. Manifest is the completion marker and is written last. */
export const writeEventDataset = async (directory, dataset) => {
  const encoded = serializeEventDataset(dataset);
  const resolved = path.resolve(directory);
  await mkdir(path.dirname(resolved), { recursive: true });
  await mkdir(resolved);
  for (const [name, text] of Object.entries(encoded.artifacts))
    await writeExclusive(path.join(resolved, name), text);
  await writeExclusive(path.join(resolved, 'manifest.json'), encoded.manifestText);
  return { directory: resolved, manifest: encoded.manifest, quality: dataset.quality };
};

const readRegular = async (filename, maximumBytes = maximumArtifactBytes) => {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes)
    throw new Error('Dataset files must be bounded regular files, never links.');
  return readFile(filename, 'utf8');
};

export const inspectEventDataset = async (directory) => {
  const resolved = path.resolve(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Choose a regular dataset directory.');
  const manifest = JSON.parse(await readRegular(path.join(resolved, 'manifest.json'), 64_000));
  if (
    manifest.schemaVersion !== 'event-dataset-manifest-v1' ||
    Object.keys(manifest.files ?? {})
      .sort()
      .join(',') !== [...filenames].sort().join(',')
  )
    throw new Error('Unsupported or incomplete dataset manifest.');
  const artifacts = {};
  for (const name of filenames) {
    const text = await readRegular(path.join(resolved, name));
    if (
      hash(text) !== manifest.files[name].sha256 ||
      Buffer.byteLength(text) !== manifest.files[name].bytes
    )
      throw new Error(`Dataset checksum mismatch: ${name}.`);
    artifacts[name] = name.endsWith('.jsonl')
      ? text
          .trimEnd()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : JSON.parse(text);
  }
  const identity = {
    schemaVersion: manifest.schemaVersion,
    configuration: manifest.configuration,
    files: manifest.files,
  };
  if (
    manifest.datasetId !== `sha256:${hash(canonical(identity))}` ||
    manifest.counts.events !== artifacts['events.jsonl'].length ||
    manifest.counts.snapshots !== artifacts['snapshots.jsonl'].length ||
    manifest.counts.labels !== artifacts['labels.jsonl'].length
  )
    throw new Error('Dataset manifest identity or counts do not match.');
  return {
    directory: resolved,
    verified: true,
    manifest,
    quality: artifacts['quality.json'],
    events: artifacts['events.jsonl'],
  };
};
