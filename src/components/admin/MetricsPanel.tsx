'use client';

import { useCallback, useEffect, useState } from 'react';

type Metrics = {
  sales: {
    bookings: number; paidBookings: number; unpaidClosedBookings: number; refundBookings: number; ticketsSold: number; confirmedRevenue: number;
    byKind: { kind: string; tickets: number; revenue: number }[];
    byZone: { zone: string; tickets: number; revenue: number }[];
    byShow: { showId: string; title: string; startsAt: string; tickets: number }[];
  };
  admission: {
    total: number; admitted: number; rejected: number; duplicates: number; firstScan: string | null; lastScan: string | null;
    byShow: { showId: string | null; title: string | null; total: number; admitted: number }[];
    byGate: { gate: string; total: number; admitted: number }[];
    byScanner: { scannerId: string; name: string; contact: string; total: number; admitted: number }[];
    byCode: { code: string; total: number }[];
  };
  payments: {
    byState: { state: string; count: number; amount: number }[];
    awaitingPayment: number; underReconciliation: number; openCases: number;
    refunds: { state: string; count: number; amount: number }[];
  };
};

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—');

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="admin__table">
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>) : <tr><td colSpan={head.length} className="muted">None</td></tr>}</tbody>
    </table>
  );
}

/** Read-only, server-computed figures (/api/admin/metrics). */
export default function MetricsPanel({ shows }: { shows: { id: string; title: string; starts_at: string }[] }) {
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (f: Record<string, string>) => {
    setError('');
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const res = await fetch(`/api/admin/metrics${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load metrics.'); return; }
    setData(body as Metrics);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(filter);
  }, [filter, load]);

  const scanners = data?.admission.byScanner ?? [];

  return (
    <div className="stack admin__panel">
      <h2 className="h3">Sales, admission & payments</h2>
      <form className="card grid" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const toIso = (v: FormDataEntryValue | null) => (v ? new Date(String(v)).toISOString() : '');
        setFilter({
          showId: String(f.get('showId') || ''), zone: String(f.get('zone') || ''), scannerId: String(f.get('scannerId') || ''),
          paymentStatus: String(f.get('paymentStatus') || ''), from: toIso(f.get('from')), to: toIso(f.get('to')),
        });
      }}>
        <label className="field"><span>Show</span><select name="showId"><option value="">All</option>{shows.map((s) => <option key={s.id} value={s.id}>{s.title} · {when(s.starts_at)}</option>)}</select></label>
        <label className="field"><span>Zone</span><select name="zone"><option value="">All</option><option>Premier</option><option>Superior</option><option>Balcony</option></select></label>
        <label className="field"><span>Scanner</span><select name="scannerId"><option value="">All</option>{scanners.map((s) => <option key={s.scannerId} value={s.scannerId}>{s.name || s.contact}</option>)}</select></label>
        <label className="field"><span>Payment status</span><select name="paymentStatus"><option value="">All</option><option>CAPTURED</option><option>AUTHORIZED</option><option>FAILED</option></select></label>
        <label className="field"><span>From</span><input name="from" type="datetime-local" /></label>
        <label className="field"><span>To</span><input name="to" type="datetime-local" /></label>
        <button className="btn btn--primary" type="submit">Apply filters</button>
      </form>
      {error && <p className="banner banner--err" role="alert">{error}</p>}
      {data && (
        <>
          <section className="card stack stack--sm">
            <h3 className="h3">Sales</h3>
            <p>Tickets sold <strong>{data.sales.ticketsSold}</strong> · Bookings {data.sales.bookings} · Paid {data.sales.paidBookings} · Unpaid/expired {data.sales.unpaidClosedBookings} · Refund {data.sales.refundBookings} · Revenue (confirmed) <strong>{money(data.sales.confirmedRevenue)}</strong></p>
            <Table head={['Type', 'Tickets', 'Revenue']} rows={data.sales.byKind.map((r) => [r.kind === 'SEASON' ? 'Season' : 'Daily', r.tickets, money(r.revenue)])} />
            <Table head={['Zone', 'Tickets', 'Revenue']} rows={data.sales.byZone.map((r) => [r.zone, r.tickets, money(r.revenue)])} />
            <Table head={['Show', 'Date', 'Tickets (incl. season)']} rows={data.sales.byShow.map((r) => [r.title, when(r.startsAt), r.tickets])} />
          </section>
          <section className="card stack stack--sm">
            <h3 className="h3">Admission</h3>
            <p>Scans {data.admission.total} · Admitted <strong>{data.admission.admitted}</strong> · Rejected {data.admission.rejected} · Duplicates {data.admission.duplicates} · First {when(data.admission.firstScan)} · Latest {when(data.admission.lastScan)}</p>
            <Table head={['Show', 'Scans', 'Admitted']} rows={data.admission.byShow.map((r) => [r.title ?? '—', r.total, r.admitted])} />
            <Table head={['Gate', 'Scans', 'Admitted']} rows={data.admission.byGate.map((r) => [r.gate, r.total, r.admitted])} />
            <Table head={['Scanner', 'Scans', 'Admitted']} rows={data.admission.byScanner.map((r) => [r.name || r.contact, r.total, r.admitted])} />
            <Table head={['Result', 'Scans']} rows={data.admission.byCode.map((r) => [r.code ?? '—', r.total])} />
          </section>
          <section className="card stack stack--sm">
            <h3 className="h3">Payments</h3>
            <p>Awaiting payment {data.payments.awaitingPayment} · Under reconciliation {data.payments.underReconciliation} · Open cases {data.payments.openCases}</p>
            <Table head={['Payment state', 'Count', 'Amount']} rows={data.payments.byState.map((r) => [r.state, r.count, money(r.amount)])} />
            <Table head={['Refund state', 'Count', 'Amount']} rows={data.payments.refunds.map((r) => [r.state, r.count, money(r.amount)])} />
          </section>
        </>
      )}
    </div>
  );
}
