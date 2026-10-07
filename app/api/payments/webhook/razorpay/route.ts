import { ingestRazorpayWebhook } from '@/lib/payments';
import { jsonOk, jsonError } from '@/lib/http';
import { AppError } from '@/lib/errors';

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get('X-Razorpay-Signature') ?? '';
  try {
    const rawBody = await request.text();
    const result = await ingestRazorpayWebhook(rawBody, signature);
    return jsonOk(result);
  } catch (error) {
    // Rejected deliveries are never stored, so log them (no body, no signature value): a
    // dashboard secret that does not match RAZORPAY_WEBHOOK_SECRET otherwise looks exactly
    // like "Razorpay never called".
    if (error instanceof AppError && (error.status === 400 || error.status === 503)) {
      console.warn('[webhook] rejected', error.status, error.message, signature ? '(signature present)' : '(no signature header)');
    }
    return jsonError(error);
  }
}
