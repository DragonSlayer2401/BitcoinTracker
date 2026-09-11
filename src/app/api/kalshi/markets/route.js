import { fetchKalshiMarkets } from '../../../../services/kalshi/kalshi.service';
import { kalshiErrorResponse, kalshiResponse } from '../../../../services/kalshi/kalshi.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    return kalshiResponse(await fetchKalshiMarkets());
  } catch (error) {
    return kalshiErrorResponse(error);
  }
}
