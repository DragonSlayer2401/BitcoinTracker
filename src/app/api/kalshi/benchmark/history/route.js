import { hasKalshiCredentials } from '../../../../../services/kalshi/kalshi.auth';
import { kalshiErrorResponse, kalshiResponse } from '../../../../../services/kalshi/kalshi.http';
import { fetchBenchmarkHistory } from '../../../../../services/kalshi/benchmarkHistory/benchmarkHistory.service';
import { readBenchmarkHistoryQuery } from '../../../../../services/kalshi/benchmarkHistory/benchmarkHistory.validation';
import {
  assertResearchRequest,
  researchErrorResponse,
} from '../../../../../services/research/research.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  if (hasKalshiCredentials()) {
    try {
      assertResearchRequest(request);
    } catch (error) {
      return researchErrorResponse(error);
    }
  }
  try {
    return kalshiResponse(await fetchBenchmarkHistory(readBenchmarkHistoryQuery(request)));
  } catch (error) {
    return kalshiErrorResponse(error);
  }
}
