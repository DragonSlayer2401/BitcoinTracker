// Imperative archive commands stay separate from cached query definitions.
export async function requestResearch(path, { body, signal } = {}) {
  const response = await fetch(`/api/research/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'Research sign-in is required. Open the archive sign-in link, then retry.'
        : (result.error ??
            'The research archive is unavailable. Pending records remain on this device.'),
    );
  }
  return result;
}

export async function uploadResearchBatch(batch) {
  const result = await requestResearch('ingest', { body: batch });
  for (const key of ['evidence', 'forecasts']) {
    const acknowledgment = result?.[key];
    if (
      !acknowledgment ||
      !Number.isSafeInteger(acknowledgment.inserted) ||
      !Number.isSafeInteger(acknowledgment.duplicates) ||
      acknowledgment.inserted < 0 ||
      acknowledgment.duplicates < 0 ||
      acknowledgment.inserted + acknowledgment.duplicates !== (batch[key]?.length ?? 0)
    ) {
      throw new Error(
        'The archive did not confirm the complete upload. Pending records remain on this device.',
      );
    }
  }
  return result;
}
export const runResearchLearning = () => requestResearch('analyze', { body: {} });

export async function readResearchExport(type = 'evidence') {
  const rows = [];
  let after = null;
  do {
    const query = new URLSearchParams({ type, limit: '500' });
    if (after !== null) query.set('after', String(after));
    const page = await requestResearch(`export?${query}`);
    if (!Array.isArray(page.rows)) throw new Error('The archive returned an invalid export.');
    rows.push(...page.rows);
    const next = page.nextCursor ?? null;
    if (next !== null && String(next) === String(after))
      throw new Error('Archive export did not advance.');
    after = next;
  } while (after !== null);
  return rows;
}
