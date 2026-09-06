import { ingestRazorpayWebhook } from '@/lib/payments';
import { jsonOk, jsonError } from '@/lib/http';

export async function POST(request: Request): Promise<Response> {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('X-Razorpay-Signature') ?? '';
    const result = await ingestRazorpayWebhook(rawBody, signature);
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
