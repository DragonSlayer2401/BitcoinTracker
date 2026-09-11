import { KalshiDataError } from './kalshi.validation';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function kalshiResponse(value, options = {}) {
  return Response.json(value, { ...options, headers: { ...headers, ...options.headers } });
}

export function kalshiErrorResponse(error) {
  return kalshiResponse(
    {
      error:
        error instanceof KalshiDataError
          ? error.message
          : 'Kalshi data is temporarily unavailable.',
    },
    {
      status: error instanceof KalshiDataError ? error.status : 502,
      ...(Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0
        ? { headers: { 'Retry-After': String(Math.ceil(error.retryAfterMs / 1000)) } }
        : {}),
    },
  );
}
