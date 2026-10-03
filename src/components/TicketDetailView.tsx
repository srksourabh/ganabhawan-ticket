'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { dateLocale, kindLabel, zoneLabel } from '@/lib/i18n';
import PayBookingButton from '@/components/PayBookingButton';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

type Ticket = { id: string; reference: string; status: string; ordinal: number; credentialKind: string; admitted: number };
export type BookingDetail = {
  id: string;
  reference: string;
  status: string;
  quantity: number;
  total: number;
  unit_price: number;
  currency: string;
  created_at: string;
  snapshot: { name: string; category: string; kind: string; coverage: { title: string; startsAt: string }[] };
  tickets: Ticket[];
};

export default function TicketDetailView({ booking, contact }: { booking: BookingDetail; contact?: string }) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const isConfirmed = booking.status === 'CONFIRMED';

  return (
    <main style={{ minHeight: '100vh', padding: '2rem 1.25rem' }}>
      <section style={{ maxWidth: 640, margin: '0 auto' }}>
        <p style={{ marginBottom: '1.25rem' }}>
          <Link href="/tickets" className="btn btn--ghost btn--sm" style={{ display: 'inline-flex' }}>{t('tickets.back')}</Link>
        </p>

        <p className="eyebrow">
          {kindLabel(locale, booking.snapshot?.kind)} · {zoneLabel(locale, booking.snapshot?.category)}
        </p>
        <h1 style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(1.6rem, 5vw, 2.5rem)', lineHeight: 1.1, margin: '0 0 .5rem' }}>
          {booking.snapshot?.name}
        </h1>
        <p style={{ fontFamily: 'monospace', fontSize: '1rem', color: '#64564d', margin: '0 0 1.5rem' }}>{booking.reference}</p>

        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <Row label={t('tickets.status')} value={booking.status.replace('_', ' ')} />
          <Row label={t('tickets.quantity')} value={`${booking.quantity}`} />
          <Row label={t('tickets.unitPrice')} value={money(booking.unit_price, dl)} />
          <Row label={t('tickets.total')} value={money(booking.total, dl)} />
          <Row label={t('tickets.booked')} value={new Date(booking.created_at).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} />
        </div>

        {booking.snapshot?.coverage?.length > 0 && (
          <div className="card" style={{ marginBottom: '1.25rem' }}>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '1.1rem', margin: '0 0 .75rem' }}>{t('tickets.coverage')}</h2>
            {[...booking.snapshot.coverage].sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt)).map((c, i) => (
              <p key={i} style={{ margin: '.25rem 0', fontSize: '.9rem', color: '#3d2a1e' }}>
                <strong>{c.title}</strong> — {new Date(c.startsAt).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
              </p>
            ))}
          </div>
        )}

        {isConfirmed && booking.tickets?.length > 0 && (
          <div className="card">
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '1.1rem', margin: '0 0 .75rem' }}>{t('tickets.yours')}</h2>
            <p className="muted" style={{ marginTop: 0 }}>{t('tickets.saveHint')}</p>
            {booking.tickets.map((ticket) => (
              <TicketShowCodes
                key={ticket.id}
                ticketId={ticket.id}
                ticketRef={ticket.reference}
                admitted={ticket.admitted}
                coverage={booking.snapshot?.coverage ?? []}
              />
            ))}
          </div>
        )}

        {booking.status === 'REFUND_REQUIRED' && (
          <div style={{ padding: '1rem', background: '#fff0f0', border: '1px solid #e8c0c0', borderRadius: 8, marginTop: '1rem' }}>
            {t('tickets.refundNotice')}
          </div>
        )}

        {(booking.status === 'HELD' || booking.status === 'PAYMENT_PENDING') && (
          <div style={{ marginTop: '1rem' }}>
            <PayBookingButton
              bookingId={booking.id}
              amount={booking.total}
              description={booking.snapshot?.name ?? booking.reference}
              contact={contact}
            />
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * One QR card per covered performance, in chronological order.
 * Interim: every card for a ticket shares that ticket's single credential
 * (the gate already enforces one admission per show). Distinct per-show
 * codes need a credentials migration — tracked as follow-up.
 */
function TicketShowCodes({
  ticketId,
  ticketRef,
  admitted,
  coverage,
}: {
  ticketId: string;
  ticketRef: string;
  admitted: number;
  coverage: { title: string; startsAt: string }[];
}) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [qr, setQr] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tickets/${ticketId}/pass`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { qr?: string } | null) => {
        if (!cancelled) setQr(body?.qr || '');
      })
      .catch(() => {
        if (!cancelled) setQr('');
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const ordered = [...coverage].sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
  if (!qr) return null;
  return (
    <div>
      {ordered.map((c, i) => (
        <div key={`${ticketId}-${i}`} className="ticket-pass">
          <p className="eyebrow" style={{ marginBottom: '.25rem' }}>
            {ordered.length > 1 ? t('tickets.showCode', { ordinal: i + 1, total: ordered.length }) : t('tickets.yours')}
          </p>
          <p style={{ margin: '.2rem 0 .6rem', fontSize: '.9rem' }}>
            <strong>{c.title}</strong>
            {' — '}
            {new Date(c.startsAt).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
          </p>
          <img src={qr} alt="" width={240} height={240} />
          <p className="ticket-pass__ref">{ticketRef}</p>
          <p className="muted">{admitted > 0 ? t('tickets.admitted') : t('tickets.notScanned')}</p>
          <p className="muted">{t('tickets.showAtDoor')}</p>
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '.45rem 0', borderBottom: '1px solid #f0ebe3', fontSize: '.9rem' }}>
      <span style={{ color: '#64564d' }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}
