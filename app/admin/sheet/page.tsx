'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { PhysicalTicketRow, SheetRow, SheetSummary } from '@/lib/booking-sheet';

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export default function BookingSheetPage() {
  const [rows, setRows] = useState<SheetRow[] | null>(null);
  const [tickets, setTickets] = useState<PhysicalTicketRow[]>([]);
  const [summary, setSummary] = useState<SheetSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/booking-sheet')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body.error || 'Staff sign-in required.');
          return;
        }
        setRows(body.rows || []);
        setTickets(body.tickets || []);
        setSummary(body.summary);
      })
      .catch(() => setError('Could not load the booking sheet.'));
  }, []);

  if (error) {
    return (
      <main className="page-pad">
        <div className="card stack" style={{ maxWidth: 480, margin: '2rem auto' }}>
          <h1 className="h2">Booking sheet</h1>
          <p>{error}</p>
          <Link className="btn btn--primary" href="/admin/login">Admin sign-in</Link>
        </div>
      </main>
    );
  }

  if (!rows || !summary) return <main className="page-pad"><p className="muted">Loading the booking sheet…</p></main>;

  const categories = Object.entries(summary.byCategory);

  return (
    <main className="page-pad admin sheet-print">
      <div className="admin__head">
        <div>
          <p className="eyebrow">Internal</p>
          <h1 className="h2">Sold tickets</h1>
          <p className="muted">Sold tickets for physical cards. Each row has the purchaser name, email and phone. Download one booking, one ticket, or every sold ticket. Season tickets are handed over together on the first day, before that first show. A daily ticket is handed over before its own performance.</p>
        </div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <a className="btn btn--primary" href="/api/admin/booking-sheet?format=tickets">Download all sold tickets</a>
          <a className="btn btn--ghost" href="/api/admin/booking-sheet?format=csv">Download bookings</a>
          <button type="button" className="btn btn--ghost" onClick={() => window.print()}>Print</button>
          <Link className="btn btn--ghost" href="/admin/accounts">Accounts</Link>
        </div>
      </div>

      <div className="ledger-cards">
        <article className="card"><p className="eyebrow">People</p><strong>{summary.people}</strong><p className="muted">Distinct email addresses</p></article>
        <article className="card"><p className="eyebrow">Bookings</p><strong>{summary.bookings}</strong><p className="muted">Confirmed orders lines</p></article>
        <article className="card"><p className="eyebrow">Tickets</p><strong>{summary.tickets}</strong><p className="muted">Season {summary.byKind.Season} · Daily {summary.byKind.Daily}</p></article>
        <article className="card">
          <p className="eyebrow">Categories</p>
          <strong>{categories.length ? categories.map(([name, count]) => `${name} ${count}`).join(' · ') : '—'}</strong>
        </article>
      </div>

      <div className="ledger-table">
        <table>
          <thead>
            <tr>
              <th>When</th><th>Name</th><th>Email</th><th>Mobile</th><th>Category</th><th>Type</th><th>Show</th><th>Qty</th><th>Paid</th><th>Booking</th><th>Tickets</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={11}>No confirmed bookings yet.</td></tr>}
            {rows.map((row) => (
              <tr key={row.reference}>
                <td>{when(row.bookedAt)}</td>
                <td>{row.name}</td>
                <td>{row.email}</td>
                <td>{row.phone}</td>
                <td>{row.category}</td>
                <td>{row.kind}</td>
                <td>{row.show}</td>
                <td>{row.quantity}</td>
                <td>{money(row.amount)}</td>
                <td>{row.reference}</td>
                <td><a href={`/api/admin/booking-sheet?format=tickets&booking=${encodeURIComponent(row.reference)}`}>Download</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="h3">One ticket at a time</h2>
      <p className="muted">Each sold ticket, with the purchaser name, email and phone, for the physical card.</p>
      <div className="ledger-table">
        <table>
          <thead>
            <tr>
              <th>Ticket</th><th>Name</th><th>Email</th><th>Phone</th><th>Zone</th><th>Type</th><th>Show</th><th>Hand over</th><th></th>
            </tr>
          </thead>
          <tbody>
            {tickets.length === 0 && <tr><td colSpan={9}>No sold tickets yet.</td></tr>}
            {tickets.map((ticket) => (
              <tr key={ticket.ticket}>
                <td>{ticket.ticket}</td>
                <td>{ticket.name}</td>
                <td>{ticket.email}</td>
                <td>{ticket.phone}</td>
                <td>{ticket.category}</td>
                <td>{ticket.kind}</td>
                <td>{ticket.show}</td>
                <td>{ticket.handover}</td>
                <td><a href={`/api/admin/booking-sheet?format=tickets&ticket=${encodeURIComponent(ticket.ticket)}`}>Download</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
