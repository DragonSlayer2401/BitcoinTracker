import {
  fetchKalshiBenchmark,
  hasKalshiCredentials,
} from '../../../../services/kalshi/kalshi.service';
import { kalshiErrorResponse, kalshiResponse } from '../../../../services/kalshi/kalshi.http';
import { KalshiDataError } from '../../../../services/kalshi/kalshi.validation';
import {
  assertResearchRequest,
  researchErrorResponse,
} from '../../../../services/research/research.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  if (hasKalshiCredentials()) {
    try {
      // Entitled benchmark data remains behind the internal app's existing access policy.
      assertResearchRequest(request);
    } catch (error) {
      return researchErrorResponse(error);
    }
  }
  try {
    const raw = new URL(request.url).searchParams.get('expiresAt');
    if (raw !== null && !/^\d{13}$/.test(raw))
      throw new KalshiDataError('Invalid benchmark deadline.', 400);
    return kalshiResponse(
      await fetchKalshiBenchmark({ expiresAt: raw === null ? undefined : Number(raw) }),
    );
  } catch (error) {
    return kalshiErrorResponse(error);
  }
}
