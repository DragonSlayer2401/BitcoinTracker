// Browser HTTP primitives keep the actual service clients and RTK Query running.
const globalNames = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'TextEncoder',
  'TextDecoder',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
];
const originalGlobals = Object.fromEntries(
  globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
const encoding = require('node:util');
const streams = require('node:stream/web');
const installEncoding = () => {
  for (const name of [
    'TextEncoder',
    'TextDecoder',
    'ReadableStream',
    'WritableStream',
    'TransformStream',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: encoding[name] ?? streams[name],
    });
};
installEncoding();
const { Request, Response, Headers } = require('next/dist/compiled/@edge-runtime/primitives/fetch');
let ingestResponse;
let heldRequests;
let settlements;
let unexpectedRequests;
export const ingestRequests = [];
export const httpRequests = [];
const successfulUpload = (batch) => ({
  evidence: { inserted: batch.evidence.length, duplicates: 0 },
  forecasts: { inserted: batch.forecasts.length, duplicates: 0 },
});
export const setIngestResponse = (
  response = ({ batch }) => ({ body: successfulUpload(batch) }),
) => {
  ingestResponse = response;
};
export const setSettlementResponse = (market, requestedTicker = market.ticker) =>
  settlements.set(requestedTicker, market);
const jsonResponse = ({ body = {}, status = 200 } = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const resolveIngest = async (batch) => {
  const response =
    typeof ingestResponse === 'function'
      ? await ingestResponse({ batch, attempt: ingestRequests.length })
      : ingestResponse;
  if (response instanceof Error) throw response;
  return jsonResponse(response);
};
const holdIngest = (batch, signal) =>
  new Promise((resolve, reject) => {
    const removeRequest = () => {
      heldRequests = heldRequests.filter((request) => request !== held);
      signal?.removeEventListener('abort', abortRequest);
    };
    const held = {
      batch,
      resolve: (response) => {
        removeRequest();
        resolve(response);
      },
      reject: (error) => {
        removeRequest();
        reject(error);
      },
    };
    const abortRequest = () => held.reject(new DOMException('Aborted', 'AbortError'));
    heldRequests.push(held);
    signal?.addEventListener('abort', abortRequest, { once: true });
  });
export const releaseIngestRequests = async () => {
  const requests = heldRequests.splice(0);
  await Promise.all(
    requests.map(async ({ batch, resolve, reject }) => {
      try {
        resolve(await resolveIngest(batch));
      } catch (error) {
        reject(error);
      }
    }),
  );
};
const installFetch = () => {
  installEncoding();
  for (const [name, value] of Object.entries({
    Request: new Proxy(Request, {
      construct: (target, [input, init]) =>
        new target(
          typeof input === 'string' ? new URL(input, window.location.href).href : input,
          init,
        ),
    }),
    Response,
    Headers,
    fetch: jest.fn(async (request, init = {}) => {
      const url = new URL(
        typeof request === 'string' ? request : request.url,
        window.location.href,
      );
      const method = init.method ?? request.method ?? 'GET';
      const signal = init.signal ?? request.signal;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      httpRequests.push({ path: url.pathname, method, signal });
      if (url.pathname === '/api/research/ingest' && method === 'POST') {
        const batch = JSON.parse(init.body ?? (await request.text()));
        ingestRequests.push(batch);
        if (ingestResponse === null) return await holdIngest(batch, signal);
        return await resolveIngest(batch);
      }
      if (url.pathname === '/api/research/models' && method === 'GET')
        return jsonResponse({ body: { active: null, candidate: null } });
      if (
        (url.pathname === '/api/research/analysis' && method === 'GET') ||
        (url.pathname === '/api/research/analyze' && method === 'POST')
      )
        return jsonResponse();
      if (url.pathname === '/api/research/collector-health' && method === 'GET')
        return jsonResponse({ body: { collectors: [], lastHeartbeatAt: null } });
      if (/^\/api\/kalshi\/markets\/[^/]+$/.test(url.pathname) && method === 'GET') {
        const response = settlements.get(decodeURIComponent(url.pathname.split('/').at(-1)));
        return response
          ? jsonResponse({ body: { market: response } })
          : jsonResponse({ status: 503 });
      }
      unexpectedRequests.push(`${method} ${url.pathname}`);
      throw new Error(`Unexpected test HTTP request: ${method} ${url.pathname}`);
    }),
  }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
// Install before importing API modules, which construct their fetch adapters at load time.
installFetch();
export const resetEvidenceServer = () => {
  ingestResponse = null;
  heldRequests = [];
  settlements = new Map();
  unexpectedRequests = [];
  ingestRequests.length = 0;
  httpRequests.length = 0;
  installFetch();
};
export const stopEvidenceServer = async () => {
  heldRequests
    .splice(0)
    .forEach(({ reject }) => reject(new DOMException('Test browser closed', 'AbortError')));
  await Promise.resolve();
  for (const [name, descriptor] of Object.entries(originalGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  expect(unexpectedRequests).toEqual([]);
};
