import { fetchKalshiPurchaseValue } from '../../../../../../services/kalshi/purchaseValue/purchaseValue.service';
import { kalshiErrorResponse, kalshiResponse } from '../../../../../../services/kalshi/kalshi.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const { ticker } = await params;
    return kalshiResponse(await fetchKalshiPurchaseValue(ticker));
  } catch (error) {
    return kalshiErrorResponse(error);
  }
}
