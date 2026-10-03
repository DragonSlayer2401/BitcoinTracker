import { getTradingAdvisorReportFromStore } from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import {
  assertResearchRequest,
  researchErrorResponse,
  researchResponse,
} from '@/services/research/research.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Read simulated recommendations only. This endpoint cannot submit orders or start collection. */
export async function GET(request) {
  try {
    assertResearchRequest(request);
    if (new URL(request.url).search)
      return researchResponse(
        { error: 'Trading advisor reporting takes no parameters.' },
        { status: 400 },
      );
    return researchResponse(await getTradingAdvisorReportFromStore());
  } catch (error) {
    return researchErrorResponse(error);
  }
}
