import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const runProcess = promisify(execFile);
const projectRoot = path.resolve(__dirname, '../../../../../../../..');
const command = path.join(projectRoot, 'scripts/research/compare-directions.mjs');

export const createDirectionalStudySession = async (events = []) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bitcoin-directional-study-'));
  const databasePath = path.join(directory, 'isolated-evidence.db');
  const appendEvents = (rows) => {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        'CREATE TABLE IF NOT EXISTS evidence_events (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL)',
      );
      const insert = database.prepare('INSERT INTO evidence_events(payload) VALUES (?)');
      for (const row of rows) insert.run(JSON.stringify(row));
    } finally {
      database.close();
    }
  };
  appendEvents(events);
  return {
    databasePath,
    appendEvents,
    run: async (...args) => {
      // Keep application/database credentials and NODE_OPTIONS out of the child.
      // Every command, including help/errors, names this isolated database explicitly.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LOCALAPPDATA|USERPROFILE|COMSPEC|PATHEXT)$/i.test(
            name,
          ),
        ),
      );
      const before = await readFile(databasePath);
      let result;
      try {
        result = {
          code: 0,
          ...(await runProcess(
            process.execPath,
            ['--conditions=react-server', command, '--database', databasePath, ...args],
            { cwd: directory, env, timeout: 20_000, windowsHide: true, maxBuffer: 2_000_000 },
          )),
        };
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
      expect(await readFile(databasePath)).toEqual(before);
      expect(await readdir(directory)).toEqual(['isolated-evidence.db']);
      return result;
    },
    dispose: async () => {
      // Verify the exact mkdtemp child before any recursive removal.
      const resolved = path.resolve(directory);
      expect(path.dirname(resolved)).toBe(path.resolve(tmpdir()));
      expect(path.basename(resolved)).toMatch(/^bitcoin-directional-study-/);
      await rm(resolved, { recursive: true, force: true });
    },
  };
};
