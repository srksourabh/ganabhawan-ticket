import { authenticated } from '@/lib/auth';
import { confirmDevelopmentPayment, verifyRazorpayCallback } from '@/lib/payments';
import { jsonOk, jsonError, readJson } from '@/lib/http';
import { devMode } from '@/lib/env';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await authenticated();
    const body = await readJson<{
      bookingId?: string;
      orderId?: string;
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    }>(request);

    if (devMode() || process.env.PAYMENT_PROVIDER === 'development') {
      const result = await confirmDevelopmentPayment(
        user,
        body.bookingId ?? '',
        body.orderId ?? '',
      );
      return jsonOk(result);
    }

    const result = await verifyRazorpayCallback({
      razorpay_order_id: body.razorpay_order_id ?? '',
      razorpay_payment_id: body.razorpay_payment_id ?? '',
      razorpay_signature: body.razorpay_signature ?? '',
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
