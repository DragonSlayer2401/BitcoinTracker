import { getPaperTradingReportFromStore } from '@/services/research/paperTrading/paperTrading.service';
import {
  assertResearchRequest,
  researchErrorResponse,
  researchResponse,
} from '@/services/research/research.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Private archive reporting only; opening the panel cannot start collection or place orders. */
export async function GET(request) {
  try {
    assertResearchRequest(request);
    if (new URL(request.url).search)
      return researchResponse(
        { error: 'Paper trading reporting takes no parameters.' },
        { status: 400 },
      );
    return researchResponse(await getPaperTradingReportFromStore());
  } catch (error) {
    return researchErrorResponse(error);
  }
}
