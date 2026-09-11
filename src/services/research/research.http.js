import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { MAXIMUM_RESEARCH_BODY_BYTES, ResearchDataError } from './research.validation';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const isLoopback = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

function getRequestOrigin(request) {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (!host) return url;
  if (!/^(?:\[[a-f\d:]+\]|[a-z\d.-]+)(?::\d{1,5})?$/i.test(host)) {
    throw new ResearchDataError('Research requests must use the application origin.', 403);
  }
  let origin;
  try {
    origin = new URL(`${url.protocol}//${host}`);
  } catch {
    throw new ResearchDataError('Research requests must use the application origin.', 403);
  }
  const literalHostname = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0];
  if (isLoopback(origin.hostname) && !isLoopback(literalHostname.toLowerCase())) {
    throw new ResearchDataError('Research requests must use the application origin.', 403);
  }
  // Next can normalize 127.0.0.1 to localhost in request.url. Only those literal
  // loopback aliases may differ, and the browser's actual Host still owns writes.
  const isLoopbackAlias =
    isLoopback(origin.hostname) && isLoopback(url.hostname) && origin.port === url.port;
  if (origin.origin !== url.origin && !isLoopbackAlias) {
    throw new ResearchDataError('Research requests must use the application origin.', 403);
  }
  return origin;
}

function matchesSecret(actual, expected) {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

export function assertResearchRequest(request, { write = false, environment = process.env } = {}) {
  const url = getRequestOrigin(request);
  const configuredUsername = environment.RESEARCH_API_USERNAME;
  const configuredPassword = environment.RESEARCH_API_PASSWORD;
  const isHosted = Boolean(
    environment.VERCEL || environment.AWS_LAMBDA_FUNCTION_NAME || environment.NETLIFY,
  );
  const requiresAuthentication =
    isHosted || !isLoopback(url.hostname) || configuredUsername || configuredPassword;
  if (requiresAuthentication) {
    if (!configuredUsername || !configuredPassword) {
      throw new ResearchDataError(
        'Set RESEARCH_API_USERNAME and RESEARCH_API_PASSWORD before enabling research APIs outside localhost.',
        503,
      );
    }
    if (!isLoopback(url.hostname) && url.protocol !== 'https:') {
      throw new ResearchDataError('Remote research access requires HTTPS.', 403);
    }
    const authorization = request.headers.get('authorization') ?? '';
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization);
    const credentials = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
    if (!matchesSecret(credentials, `${configuredUsername}:${configuredPassword}`)) {
      throw new ResearchDataError('Sign in to access the private research store.', 401);
    }
  }
  if (write) {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    if (origin !== url.origin || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
      throw new ResearchDataError('Research writes require a same-origin request.', 403);
    }
  }
}

export async function readResearchRequestBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new ResearchDataError('Send research data as application/json.', 415);
  }
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAXIMUM_RESEARCH_BODY_BYTES)
  ) {
    throw new ResearchDataError('The research request is too large.', 413);
  }
  if (!request.body) throw new ResearchDataError('The research request body is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_RESEARCH_BODY_BYTES) {
        await reader.cancel();
        throw new ResearchDataError('The research request is too large.', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ResearchDataError) throw error;
    throw new ResearchDataError('The research request contains invalid JSON.');
  } finally {
    reader.releaseLock();
  }
}

export function researchResponse(value, options = {}) {
  return Response.json(value, { ...options, headers: { ...headers, ...options.headers } });
}

export function researchErrorResponse(error) {
  const status = error instanceof ResearchDataError ? error.status : 503;
  const locked = /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/.test(error?.code ?? '');
  return researchResponse(
    {
      available: false,
      error:
        error instanceof ResearchDataError
          ? error.message
          : locked
            ? 'The research database is locked. Finish or close the open transaction in your database viewer, then retry. Existing data is retained.'
            : 'Research storage is temporarily unavailable. Existing data is retained.',
    },
    {
      status,
      headers:
        status === 401
          ? { 'WWW-Authenticate': 'Basic realm="Bitcoin research", charset="UTF-8"' }
          : {},
    },
  );
}

export function getResearchRequestPage(request) {
  const parameters = new URL(request.url).searchParams;
  return { after: parameters.get('after') ?? 0, limit: parameters.get('limit') ?? 500 };
}
