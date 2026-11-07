// Keep the real fetch clients/RTK Query; route only the HTTP boundary to an
// isolated archive and the real server learning service.
const names = [
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
const originals = Object.fromEntries(
  names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
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
let service;
let responses = new Map();
let gates = new Map();
let unexpected = [];
export const learningRequests = [];
const jsonResponse = ({ body = {}, status = 200 } = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
      const path = url.pathname.replace('/api/research/', '');
      const method = init.method ?? request.method ?? 'GET';
      const signal = init.signal ?? request.signal;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const entry = { path, method, completed: false };
      learningRequests.push(entry);
      if (
        !['models', 'analysis', 'analyze', 'collector-health'].includes(path) ||
        method !== (path === 'analyze' ? 'POST' : 'GET')
      ) {
        unexpected.push(`${method} ${url.pathname}`);
        throw new Error(`Unexpected learning request: ${method} ${url.pathname}`);
      }
      if (path === 'analyze') {
        const headers = new Headers(init.headers ?? request.headers);
        const serialized =
          init.body ?? (typeof request === 'string' ? undefined : await request.text());
        try {
          entry.body = JSON.parse(serialized);
        } catch {
          entry.body = null;
        }
        if (
          !/^application\/json(?:;|$)/i.test(headers.get('content-type') ?? '') ||
          !entry.body ||
          Array.isArray(entry.body) ||
          typeof entry.body !== 'object' ||
          Object.keys(entry.body).length
        ) {
          unexpected.push('Analysis requires an empty JSON object with its content type.');
          return jsonResponse({
            status: 400,
            body: { error: 'Analysis uses saved evidence. Send an empty JSON object.' },
          });
        }
      }
      if (gates.has(path)) await gates.get(path).promise;
      let response;
      if (responses.has(path)) {
        const configured = responses.get(path);
        response = typeof configured === 'function' ? await configured(entry) : configured;
        if (response instanceof Error) throw response;
      } else {
        try {
          const body =
            path === 'models'
              ? await service.getResearchModels()
              : path === 'analyze'
                ? await service.runLearningCycle({ now: Date.now() })
                : path === 'analysis'
                  ? await service.getLearningStatus({ now: Date.now() })
                  : { collectors: [], lastHeartbeatAt: null };
          response = { body };
        } catch (error) {
          response = { status: 503, body: { error: error.message } };
        }
      }
      entry.completed = true;
      entry.response = response;
      return jsonResponse(response);
    }),
  }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
installFetch();
export const setLearningResponse = (path, response) => {
  if (response === undefined) responses.delete(path);
  else responses.set(path, response);
};
export const pauseLearningRequest = (path) => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  gates.set(path, { promise, release });
};
export const releaseLearningRequest = (path) => {
  const gate = gates.get(path);
  gates.delete(path);
  gate?.release();
};
export const configureLearningService = (repository) => {
  // Loaded after browser primitives are installed. No default archive is opened.
  const { createLearningService } = require('@/services/research/learning.service');
  service = createLearningService(repository);
  return service;
};
export const resetLearningServer = () => {
  responses = new Map();
  gates = new Map();
  unexpected = [];
  service = null;
  learningRequests.length = 0;
  installFetch();
};
export const stopLearningServer = async () => {
  // Incomplete controlled requests fail after the component unmounts, so no
  // delayed analysis can mutate the archive of the next test.
  for (const path of gates.keys()) {
    responses.set(path, { status: 503, body: { error: 'Test browser closed.' } });
    releaseLearningRequest(path);
  }
  await Promise.resolve();
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  expect(unexpected).toEqual([]);
};
