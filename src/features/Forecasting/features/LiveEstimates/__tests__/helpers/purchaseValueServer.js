// Use Next's bundled browser primitives so the real RTK Query fetch adapter runs
// in JSDOM. Only the HTTP boundary is controlled; query caching and UI state run normally.
const originalGlobals = Object.fromEntries(
  [
    'fetch',
    'Request',
    'Response',
    'Headers',
    'TextEncoder',
    'TextDecoder',
    'ReadableStream',
    'WritableStream',
    'TransformStream',
  ].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
const textEncoding = require('node:util');
const streams = require('node:stream/web');
const installTextEncoding = () => {
  for (const name of ['TextEncoder', 'TextDecoder'])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: textEncoding[name],
    });
  for (const name of ['ReadableStream', 'WritableStream', 'TransformStream'])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: streams[name],
    });
};
installTextEncoding();
const { Request, Response, Headers } = require('next/dist/compiled/@edge-runtime/primitives/fetch');
let response;
let responseStatus;
let pendingResponse;
let releaseResponse;
export const purchaseRequests = [];
let unexpectedRequests = [];

const installBrowserFetch = () => {
  installTextEncoding();
  Object.defineProperty(globalThis, 'Request', {
    configurable: true,
    writable: true,
    value: new Proxy(Request, {
      construct: (target, [input, init]) =>
        new target(
          typeof input === 'string' ? new URL(input, window.location.href).href : input,
          init,
        ),
    }),
  });
  Object.defineProperty(globalThis, 'Response', {
    configurable: true,
    writable: true,
    value: Response,
  });
  Object.defineProperty(globalThis, 'Headers', {
    configurable: true,
    writable: true,
    value: Headers,
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: jest.fn(async (request, init = {}) => {
      const signal = init.signal ?? request.signal;
      if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      const url = new URL(
        typeof request === 'string' ? request : request.url,
        window.location.href,
      );
      const method = init.method ?? request.method ?? 'GET';
      if (method === 'GET' && /^\/api\/kalshi\/markets\/[^/]+$/.test(url.pathname))
        return new Response(
          JSON.stringify({
            market: {
              ticker: decodeURIComponent(url.pathname.split('/').at(-1)),
              seriesTicker: 'KXBTC15M',
              status: 'closed',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      purchaseRequests.push({ url: url.href, method });
      if (
        method !== 'GET' ||
        !/^\/api\/kalshi\/markets\/[^/]+\/purchase-value$/.test(url.pathname)
      ) {
        unexpectedRequests.push(`${method} ${url.pathname}`);
        throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
      }
      if (pendingResponse) await pendingResponse;
      return new Response(JSON.stringify(response ?? { error: 'No test order book configured.' }), {
        status: responseStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  });
};

// Install before kalshiApi is imported so fetchBaseQuery sees a browser fetch.
installBrowserFetch();

export const setPurchaseValueResponse = (book, { status = 200 } = {}) => {
  response = book;
  responseStatus = status;
};

export const pausePurchaseValueResponse = () => {
  pendingResponse = new Promise((resolve) => {
    releaseResponse = resolve;
  });
};

export const releasePurchaseValueResponse = () => {
  releaseResponse?.();
  pendingResponse = null;
  releaseResponse = null;
};

export const setupPurchaseValueServer = () => {
  beforeEach(() => {
    response = null;
    responseStatus = 503;
    pendingResponse = null;
    releaseResponse = null;
    purchaseRequests.length = 0;
    unexpectedRequests = [];
    installBrowserFetch();
  });
  afterEach(() => {
    releasePurchaseValueResponse();
    for (const [name, descriptor] of Object.entries(originalGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    expect(unexpectedRequests).toEqual([]);
  });
};
