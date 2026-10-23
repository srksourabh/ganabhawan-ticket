import { notFound, redirect } from 'next/navigation';
import { assertBuyerScope, currentBuyer } from '@/lib/auth';
import { checkoutReceipt, type Receipt } from '@/lib/checkout';
import ReceiptView from '@/components/ReceiptView';

/** Consolidated receipt for one cart payment (owner only; a guest session only for the checkout it made). */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentBuyer();
  if (!user) redirect(`/login?next=/receipts/${id}`);

  let receipt: Receipt | null = null;
  try {
    await assertBuyerScope(user, id);
    receipt = await checkoutReceipt(user.id, id);
  } catch {
    // not found or not owned: same response
  }
  if (!receipt) notFound();

  return <ReceiptView receipt={receipt} guest={Boolean(user.guestSince)} />;
}
