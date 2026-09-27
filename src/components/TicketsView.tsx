'use client';

import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale } from '@/lib/i18n';
import PayBookingButton from '@/components/PayBookingButton';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

const statusColour: Record<string, string> = {
  HELD: '#e7b86a',
  PAYMENT_PENDING: '#e7b86a',
  CONFIRMED: '#2a6b3b',
  EXPIRED: '#999',
  CANCELLED: '#999',
  REFUND_REQUIRED: '#8b2f2f',
};

export type TicketRow = { id: string; reference: string; status: string; ordinal: number; credentialKind: string; admitted: number };
export type BookingRow = {
  id: string;
  reference: string;
  status: string;
  quantity: number;
  total: number;
  currency: string;
  created_at: string;
  snapshot: { name: string; coverage: { title: string; startsAt: string }[] };
  tickets: TicketRow[];
};

export default function TicketsView({
  contact,
  bookings,
  fetchError,
}: {
  contact: string;
  bookings: BookingRow[];
  fetchError: string;
}) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);

  return (
    <main style={{ minHeight: '100vh', padding: '2rem 1.25rem' }}>
      <section style={{ maxWidth: 760, margin: '0 auto' }}>
        <p className="eyebrow">
          {locale === 'bn' ? FESTIVAL_BN : FESTIVAL}
        </p>
        <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(2rem, 6vw, 3rem)', lineHeight: 1, margin: '0 0 .5rem' }}>{t('tickets.title')}</h1>
        <p style={{ color: 'var(--muted)', margin: '0 0 2rem' }}>{t('tickets.signedIn', { contact })}</p>

        {fetchError && (
          <p role="alert" className="alert alert--error">{t('tickets.loadError')}</p>
        )}

        {!fetchError && bookings.length === 0 && (
          <div className="card" style={{ textAlign: 'center' }}>
            <p style={{ margin: '0 0 1rem', fontFamily: 'Georgia, serif', fontSize: '1.25rem' }}>{t('tickets.empty')}</p>
            <Link href="/catalogue" className="btn btn--primary">{t('tickets.browse')}</Link>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {bookings.map((b) => (
            <article key={b.id} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '.5rem' }}>
                <div>
                  <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '1.2rem', margin: '0 0 .25rem' }}>{b.snapshot?.name}</h2>
                  <p style={{ margin: 0, fontFamily: 'monospace', fontSize: '.9rem', color: 'var(--muted)' }}>{b.reference}</p>
                </div>
                <span style={{ padding: '.25rem .7rem', borderRadius: 20, fontSize: '.8rem', fontWeight: 600, background: '#141414', color: statusColour[b.status] || 'var(--muted)' }}>
                  {b.status.replace('_', ' ')}
                </span>
              </div>

              <p style={{ margin: '.75rem 0 .25rem', fontSize: '.9rem', color: '#64564d' }}>
                {(b.quantity === 1
                  ? t('tickets.countOne', { amount: money(b.total, dl) })
                  : t('tickets.count', { count: b.quantity, amount: money(b.total, dl) }))}
                {' · '}
                {new Date(b.created_at).toLocaleDateString(dl, { dateStyle: 'medium' })}
              </p>

              {b.snapshot?.coverage?.map((c, i) => (
                <p key={i} style={{ margin: '.2rem 0', fontSize: '.85rem', color: '#64564d' }}>
                  {c.title} - {new Date(c.startsAt).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                </p>
              ))}

              <div style={{ marginTop: '1rem', display: 'flex', gap: '.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <Link href={`/tickets/${b.id}`} style={{ color: '#c9a227', textDecoration: 'none', fontWeight: 600, fontSize: '.9rem' }}>
                  {t('tickets.view')}
                </Link>
                {(b.status === 'HELD' || b.status === 'PAYMENT_PENDING') && (
                  <PayBookingButton
                    bookingId={b.id}
                    amount={b.total}
                    description={`${b.snapshot?.name ?? b.reference}`}
                    contact={contact}
                  />
                )}
                {b.status === 'CONFIRMED' && b.tickets?.map((ticket) => (
                  <a key={ticket.id} href={`/api/tickets/${ticket.id}/pdf`} target="_blank" rel="noopener noreferrer"
                    style={{ color: '#c9a227', textDecoration: 'none', fontWeight: 600, fontSize: '.9rem' }}>
                    {t('tickets.download', { ordinal: ticket.ordinal })}
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
