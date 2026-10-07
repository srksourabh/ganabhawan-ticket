'use client';

import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';
import { dateLocale, kindLabel, zoneLabel } from '@/lib/i18n';
import type { Receipt } from '@/lib/checkout';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

export default function ReceiptView({ receipt }: { receipt: Receipt }) {
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const when = (iso: string) => new Date(iso).toLocaleString(dl, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

  return (
    <main className="page-pad">
      <section className="container stack" style={{ maxWidth: 640 }}>
        <p>
          <Link href="/tickets" className="btn btn--ghost btn--sm" style={{ display: 'inline-flex' }}>{t('tickets.back')}</Link>
        </p>
        <p className="eyebrow">{t('receipt.title')}</p>
        <h1 className="h2">{t('receipt.order', { ref: receipt.reference })}</h1>

        <div className="card stack stack--sm">
          {receipt.payment ? (
            <p>{t('receipt.payment', { ref: receipt.payment.reference, date: when(receipt.payment.paidAt) })}</p>
          ) : (
            <p className="muted">{t('receipt.notPaid')}</p>
          )}
          <p>{t('tickets.status')}: {receipt.status.replace('_', ' ')}</p>
          {receipt.customer.name && <p>{t('receipt.customer')}: {receipt.customer.name}</p>}
        </div>

        <h2 className="h3">{t('receipt.items')}</h2>
        <ol className="stack" style={{ paddingLeft: '1.25rem' }}>
          {receipt.lines.map((line) => (
            <li key={line.bookingId} className="card stack stack--sm">
              <p className="eyebrow">{kindLabel(locale, line.kind)} · {zoneLabel(locale, line.category)}</p>
              <h3 className="h3" style={{ margin: 0 }}>{line.product}</h3>
              {line.performances.map((p) => (
                <p key={p.title + p.startsAt} className="muted" style={{ margin: 0 }}>{p.title} — {when(p.startsAt)}</p>
              ))}
              <p style={{ margin: 0 }}>{t('receipt.qty', { qty: line.quantity, unit: money(line.unitPrice, dl) })}</p>
              <p style={{ margin: 0, fontWeight: 700 }}>{t('receipt.lineTotal')}: {money(line.lineTotal, dl)}</p>
              <Link href={`/tickets/${line.bookingId}`}>{t('receipt.viewTickets')} · {line.bookingReference}</Link>
            </li>
          ))}
        </ol>

        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
          <span>{receipt.payment ? t('receipt.total') : t('receipt.totalDue')}</span>
          <span>{money(receipt.total, dl)}</span>
        </div>

        {receipt.refunds.length > 0 && (
          <div role="status" className="banner">
            {receipt.refunds.map((r, i) => (
              <p key={i} style={{ margin: 0 }}>{money(r.amount, dl)} · {r.state} · {r.reason}</p>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
