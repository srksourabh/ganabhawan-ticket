import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { ownedBookings } from '@/lib/commerce';
import TicketDetailView, { type BookingDetail } from '@/components/TicketDetailView';

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect(`/login?next=/tickets/${id}`);

  let booking: BookingDetail | null = null;
  try {
    const results = (await ownedBookings(user.id, id)) as BookingDetail[];
    booking = results[0] ?? null;
  } catch {
    // fall through to notFound
  }
  if (!booking) notFound();

  return <TicketDetailView booking={booking} contact={user.contact} />;
}
