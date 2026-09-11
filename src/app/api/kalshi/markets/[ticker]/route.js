import { fetchKalshiMarket } from '../../../../../services/kalshi/kalshi.service';
import { kalshiErrorResponse, kalshiResponse } from '../../../../../services/kalshi/kalshi.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const { ticker } = await params;
    return kalshiResponse(await fetchKalshiMarket(ticker));
  } catch (error) {
    return kalshiErrorResponse(error);
  }
}
