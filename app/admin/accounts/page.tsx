'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type Attempt = {
  id: string;
  created_at: string;
  name: string;
  contact: string;
  quantity: number;
  outcome: string;
  product_name: string;
  category: string;
  kind: string;
  reference: string | null;
  booking_status: string | null;
};

type PaymentRow = {
  amount: number;
  state: string;
  created_at: string;
  reference: string;
  name: string;
  contact: string;
  reason?: string;
};

type CaseRow = {
  id: string;
  key: string;
  kind: string;
  state: string;
  created_at: string;
  detail: unknown;
};

type Ledger = {
  income: number;
  refunded: number;
  balance: number;
  pending: number;
  attempts: Attempt[];
  payments: PaymentRow[];
  refunds: PaymentRow[];
  cases?: CaseRow[];
};

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export default function AccountsPage() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/ledger')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(body.error || 'Staff sign-in required.');
          return;
        }
        setLedger(body);
      })
      .catch(() => setError('Could not load accounts.'));
  }, []);

  if (error) {
    return (
      <main className="page-pad">
        <div className="card stack" style={{ maxWidth: 480, margin: '2rem auto' }}>
          <h1 className="h2">Accounts</h1>
          <p>{error}</p>
          <Link className="btn btn--primary" href="/admin/login">Admin sign-in</Link>
        </div>
      </main>
    );
  }

  if (!ledger) return <main className="page-pad"><p className="muted">Loading accounts…</p></main>;

  return (
    <main className="page-pad admin">
      <div className="admin__head">
        <div>
          <p className="eyebrow">Staff</p>
          <h1 className="h2">Accounts</h1>
          <p className="muted">Income, refunds, and everyone who tried to book.</p>
        </div>
        <Link className="btn btn--ghost" href="/admin">Festival settings</Link>
      </div>

      <div className="ledger-cards">
        <article className="card"><p className="eyebrow">Income</p><strong>{money(ledger.income)}</strong><p className="muted">Captured payments</p></article>
        <article className="card"><p className="eyebrow">Refunds</p><strong>{money(ledger.refunded)}</strong><p className="muted">Succeeded refunds</p></article>
        <article className="card"><p className="eyebrow">Balance</p><strong>{money(ledger.balance)}</strong><p className="muted">Income minus refunds</p></article>
        <article className="card"><p className="eyebrow">On hold</p><strong>{money(ledger.pending)}</strong><p className="muted">Reserved, not yet paid</p></article>
      </div>

      <section className="stack">
        <h2 className="h3">Open reconciliation cases</h2>
        <div className="ledger-table">
          <table>
            <thead>
              <tr><th>When</th><th>Kind</th><th>Key</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {(ledger.cases ?? []).length === 0 && (
                <tr><td colSpan={4}>No open cases.</td></tr>
              )}
              {(ledger.cases ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{when(row.created_at)}</td>
                  <td>{row.kind}</td>
                  <td>{row.key}</td>
                  <td>{typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack">
        <h2 className="h3">People who tried to book</h2>
        <div className="ledger-table">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Name</th>
                <th>Contact</th>
                <th>Ticket</th>
                <th>Qty</th>
                <th>Outcome</th>
                <th>Booking</th>
              </tr>
            </thead>
            <tbody>
              {ledger.attempts.length === 0 && (
                <tr><td colSpan={7}>No booking attempts yet.</td></tr>
              )}
              {ledger.attempts.map((row) => (
                <tr key={row.id}>
                  <td>{when(row.created_at)}</td>
                  <td>{row.name}</td>
                  <td>{row.contact}</td>
                  <td>{row.product_name}<br /><span className="muted">{row.kind} · {row.category}</span></td>
                  <td>{row.quantity}</td>
                  <td>{row.outcome}</td>
                  <td>{row.reference ? `${row.reference}${row.booking_status ? ` · ${row.booking_status}` : ''}` : 'Not held'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack">
        <h2 className="h3">Payments</h2>
        <MoneyTable rows={ledger.payments} empty="No payments yet." />
      </section>

      <section className="stack">
        <h2 className="h3">Refunds</h2>
        <MoneyTable rows={ledger.refunds} empty="No refunds yet." showReason />
      </section>
    </main>
  );
}

function MoneyTable({ rows, empty, showReason = false }: { rows: PaymentRow[]; empty: string; showReason?: boolean }) {
  return (
    <div className="ledger-table">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Name</th>
            <th>Contact</th>
            <th>Booking</th>
            <th>Amount</th>
            <th>State</th>
            {showReason && <th>Reason</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={showReason ? 7 : 6}>{empty}</td></tr>
          )}
          {rows.map((row) => (
            <tr key={`${row.reference}-${row.created_at}-${row.state}`}>
              <td>{when(row.created_at)}</td>
              <td>{row.name}</td>
              <td>{row.contact}</td>
              <td>{row.reference}</td>
              <td>{money(Number(row.amount))}</td>
              <td>{row.state}</td>
              {showReason && <td>{row.reason}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
