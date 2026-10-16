'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SheetRow, SheetSummary } from '@/lib/booking-sheet';

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

export default function BookingSheetPage() {
  const [rows, setRows] = useState<SheetRow[] | null>(null);
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
          <h1 className="h2">Booking sheet</h1>
          <p className="muted">Confirmed bookings for the counter. Print this page, or download the CSV and open it in Google Sheets.</p>
        </div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <a className="btn btn--primary" href="/api/admin/booking-sheet?format=csv">Download for Google Sheets</a>
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
              <th>When</th><th>Name</th><th>Email</th><th>Mobile</th><th>Category</th><th>Type</th><th>Show</th><th>Qty</th><th>Paid</th><th>Booking</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10}>No confirmed bookings yet.</td></tr>}
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
