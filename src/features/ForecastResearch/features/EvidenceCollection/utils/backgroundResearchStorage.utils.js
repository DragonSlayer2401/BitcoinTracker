import { appendEvidenceRows } from './evidenceStorage.utils';

export const BACKGROUND_RESEARCH_STORAGE_KEY = 'bitcoin-tracker:background-research:kalshi:v2';

const MAXIMUM_PENDING_ROWS = 100;
const INVALID_STATE_MESSAGE = 'Saved background research state is invalid; recording is paused.';

export function readBackgroundResearchRecord() {
  const serialized = globalThis.localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY);
  if (!serialized) {
    return { recorderId: globalThis.crypto.randomUUID(), state: null, pendingRows: [] };
  }

  let saved;
  try {
    saved = JSON.parse(serialized);
  } catch {
    throw new Error(INVALID_STATE_MESSAGE);
  }

  if (
    !saved ||
    !saved.state ||
    !Array.isArray(saved.pendingRows) ||
    saved.pendingRows.length > MAXIMUM_PENDING_ROWS
  ) {
    throw new Error(INVALID_STATE_MESSAGE);
  }
  return saved;
}

export function writeBackgroundResearchRecord(record) {
  globalThis.localStorage.setItem(BACKGROUND_RESEARCH_STORAGE_KEY, JSON.stringify(record));
}

/** Only clear the durable replay queue after its exact evidence rows have been inserted. */
export async function flushPendingResearchEvidence(record) {
  await appendEvidenceRows(record.pendingRows);
  writeBackgroundResearchRecord({ ...record, pendingRows: [] });
}
