import { assertBuyerScope, authenticatedBuyer } from '@/lib/auth';
import { checkoutReceipt } from '@/lib/checkout';
import { jsonOk, jsonError } from '@/lib/http';

/** The consolidated receipt for one cart payment. Owner only. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await authenticatedBuyer();
    const { id } = await params;
    await assertBuyerScope(user, id);
    return jsonOk(await checkoutReceipt(user.id, id));
  } catch (error) {
    return jsonError(error);
  }
}
