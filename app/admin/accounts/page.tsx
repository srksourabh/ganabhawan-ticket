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

type Ops = {
  critical: string[];
  warnings?: string[];
  jobs: { failed7d: number; stuckRunning: number; overduePending: number };
  refunds: { failed: number; processingOver7d: number };
  gate: { denied24h: number; unknown24h: number };
  auth: { staffPasswordFailures24h: number };
};

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});

export default function AccountsPage() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [ops, setOps] = useState<Ops | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

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
    // 503 still carries the status body: it means a critical item is open.
    fetch('/api/ops/status')
      .then(async (res) => {
        if (res.status !== 200 && res.status !== 503) return;
        const body = await res.json().catch(() => null);
        // A 503 from the proxy (CONFIG_INVALID) has no ops shape; only render real status.
        if (body && Array.isArray(body.critical)) setOps(body);
      })
      .catch(() => undefined);
  }, [reload]);

  async function resolveCase(id: string) {
    const note = window.prompt('How was this case resolved? (recorded in the audit log)');
    if (!note) return;
    const res = await fetch(`/api/admin/cases/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) window.alert(body.error || 'Could not resolve the case.');
    setReload((n) => n + 1);
  }

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

      {ops && (
        <section className="stack">
          <h2 className="h3">Operations</h2>
          {ops.critical.length > 0 ? (
            <ul className="banner banner--err" role="alert">
              {ops.critical.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className="banner">No critical issues.</p>
          )}
          {(ops.warnings ?? []).length > 0 && (
            <ul className="banner">{(ops.warnings ?? []).map((item) => <li key={item}>{item}</li>)}</ul>
          )}
          <p className="muted">
            Jobs failed (7 days): {ops.jobs.failed7d} · stuck: {ops.jobs.stuckRunning} · overdue: {ops.jobs.overduePending} ·
            Refunds failed: {ops.refunds.failed} · processing &gt; 7 days: {ops.refunds.processingOver7d} ·
            Gate denied (24 h): {ops.gate.denied24h} · unknown codes (24 h): {ops.gate.unknown24h} ·
            Staff password failures (24 h): {ops.auth.staffPasswordFailures24h}
          </p>
        </section>
      )}

      <section className="stack">
        <h2 className="h3">Open reconciliation cases</h2>
        <div className="ledger-table">
          <table>
            <thead>
              <tr><th>When</th><th>Kind</th><th>Key</th><th>Detail</th><th></th></tr>
            </thead>
            <tbody>
              {(ledger.cases ?? []).length === 0 && (
                <tr><td colSpan={5}>No open cases.</td></tr>
              )}
              {(ledger.cases ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{when(row.created_at)}</td>
                  <td>{row.kind}</td>
                  <td>{row.key}</td>
                  <td>{typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail)}</td>
                  <td><button type="button" className="btn btn--ghost btn--sm" onClick={() => { void resolveCase(row.id); }}>Mark resolved</button></td>
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
