/** Setup commands are imperative; never replay a cached start, stop or allocation change. */
async function requestSetup(path, body, signal) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(`/api/research/${path}`, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Setup could not be updated.');
  return value;
}

export const readAdvisorConfiguration = (signal) =>
  requestSetup('advisor-configuration', null, signal);
export const saveAdvisorConfiguration = (configuration, signal) =>
  requestSetup('advisor-configuration', configuration, signal);
export const readCollectorControl = (signal) => requestSetup('collector-control', null, signal);
export const changeCollectorControl = (action, signal) =>
  requestSetup('collector-control', { action }, signal);
