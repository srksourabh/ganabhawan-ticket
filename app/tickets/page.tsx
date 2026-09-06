import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { ownedBookings } from '@/lib/commerce';
import TicketsView, { type BookingRow } from '@/components/TicketsView';

export default async function TicketsPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/tickets');

  let bookings: BookingRow[] = [];
  let fetchError = '';
  try {
    bookings = (await ownedBookings(user.id)) as BookingRow[];
  } catch {
    fetchError = 'error';
  }

  return <TicketsView contact={user.contact} bookings={bookings} fetchError={fetchError} />;
}
