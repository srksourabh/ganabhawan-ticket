import { authenticated } from '@/lib/auth';
import { confirmDevelopmentPayment, syncRazorpayPayment, verifyRazorpayCallback } from '@/lib/payments';
import { jsonOk, jsonError, readJson } from '@/lib/http';
import { usingDevelopmentPayments } from '@/lib/env';

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

    if (usingDevelopmentPayments()) {
      const result = await confirmDevelopmentPayment(user, body.bookingId ?? '', body.orderId ?? '');
      return jsonOk(result);
    }

    if (body.razorpay_order_id && body.razorpay_payment_id && body.razorpay_signature) {
      const result = await verifyRazorpayCallback(
        {
          razorpay_order_id: body.razorpay_order_id,
          razorpay_payment_id: body.razorpay_payment_id,
          razorpay_signature: body.razorpay_signature,
        },
        user,
      );
      return jsonOk(result);
    }

    const result = await syncRazorpayPayment(user, body.bookingId ?? '');
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
