import { TextDecoder, TextEncoder } from 'node:util';
import { ReadableStream } from 'node:stream/web';

Object.assign(globalThis, { TextDecoder, TextEncoder, ReadableStream });

const { Headers, Request, Response } = require('next/dist/compiled/@edge-runtime/primitives/fetch');

Object.assign(globalThis, {
  Headers,
  Response,
  fetch: async () => {
    throw new Error('Unexpected network request in adviser report test.');
  },
  Request: class extends Request {
    constructor(input, options) {
      super(typeof input === 'string' ? new URL(input, 'http://localhost').href : input, options);
    }
  },
});
