'use client';

import { useCallback, useEffect, useState } from 'react';
import { AUDITORIUM_HOUSE } from '@/lib/brand';

type ZoneSales = {
  zone: string;
  productId: string | null;
  price: number | null;
  enabled: boolean | null;
  ceiling: number;
  allocation: number | null;
  held: number;
  sold: number;
  remaining: number;
  state: 'AVAILABLE' | 'SOLD_OUT' | 'SALES_CLOSED' | 'UNAVAILABLE' | 'CANCELLED';
  reason: string;
};
type Performance = {
  id: string;
  title: string;
  startsAt: string;
  status: string;
  salesClosesAt: string | null;
  state: 'ON_SALE' | 'SOLD_OUT' | 'SALES_CLOSED' | 'SCHEDULED' | 'DRAFT' | 'ENDED' | 'CANCELLED';
  zones: ZoneSales[];
};

const ZONE_LABEL: Record<ZoneSales['state'], string> = {
  AVAILABLE: 'Available', SOLD_OUT: 'Sold out', SALES_CLOSED: 'Sales closed', UNAVAILABLE: 'Unavailable', CANCELLED: 'Cancelled',
};
const SHOW_LABEL: Record<Performance['state'], string> = {
  ON_SALE: 'On sale', SOLD_OUT: 'Sold out', SALES_CLOSED: 'Sales closed', SCHEDULED: 'Scheduled (booking not open yet)',
  DRAFT: 'Draft (not published)', ENDED: 'Ended', CANCELLED: 'Cancelled',
};
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/**
 * Daily-ticket sales for one performance at a time: each zone's capacity, remaining seats,
 * state and the reason, with open/close for the whole performance or one zone. The server
 * decides every state and re-checks every purchase; this panel only displays and asks.
 */
export default function AvailabilityPanel({ onChanged }: { onChanged?: () => void }) {
  const [performances, setPerformances] = useState<Performance[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/availability', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load availability.'); return; }
    setPerformances((body as { performances: Performance[] }).performances);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const show = performances.find((p) => p.id === selected) ?? performances.find((p) => p.state !== 'ENDED') ?? performances[0];

  async function setSales(open: boolean, zone?: string) {
    if (!show) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const res = await fetch(`/api/admin/shows/${show.id}/sales`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open, zone }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error || 'Request failed.');
      setMessage(`${show.title}${zone ? ` · ${zone}` : ''}: sales ${open ? 'opened' : 'closed'}.`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack admin__panel">
      <h2 className="h3">Ticket availability by performance</h2>
      <p className="muted">
        Open or close daily-ticket sales for one performance, or one zone of it. Other performances and season
        tickets (Seasons tab) are not changed. Closing never cancels bookings: tickets already bought stay valid.
        Capacity is set under <strong>Inventory</strong>; cancelling a performance is done under <strong>Dramas</strong>.
      </p>
      <img className="auditorium__plan" src={AUDITORIUM_HOUSE} alt="Auditorium plan showing Premier, Superior, and Balcony" />
      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      <label className="field">
        <span>Performance</span>
        <select value={show?.id ?? ''} onChange={(e) => { setSelected(e.target.value); setMessage(''); setError(''); }}>
          {performances.map((p) => (
            <option key={p.id} value={p.id}>{p.title} · {when(p.startsAt)} · {SHOW_LABEL[p.state]}</option>
          ))}
        </select>
      </label>

      {show && (
        <section className="card stack stack--sm" aria-labelledby="availability-heading">
          <h3 id="availability-heading" className="h3">
            {show.title} <span className="muted">· {when(show.startsAt)}</span>
          </h3>
          <p role="status" style={{ margin: 0 }}>
            <strong>{SHOW_LABEL[show.state]}</strong>
            {show.salesClosesAt && <span className="muted"> · online sales close {when(show.salesClosesAt)}</span>}
          </p>
          {show.status !== 'CANCELLED' && (
            <div className="admin__row">
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => { void setSales(true); }}>Open sales for this performance</button>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { void setSales(false); }}>Close sales for this performance</button>
            </div>
          )}
          <div className="grid">
            {show.zones.map((z) => (
              <article key={z.zone} className="stack stack--sm">
                <p className="eyebrow">{z.zone} · {ZONE_LABEL[z.state]}</p>
                <p style={{ margin: 0 }}>{z.reason}</p>
                <p className="muted" style={{ margin: 0 }}>
                  Capacity {z.ceiling} · daily seats {z.allocation ?? 0} · sold {z.sold} · held {z.held} · remaining {z.remaining}
                </p>
                {z.productId && show.status !== 'CANCELLED' && (
                  z.enabled
                    ? <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { void setSales(false, z.zone); }}>Close {z.zone}</button>
                    : <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { void setSales(true, z.zone); }}>Open {z.zone}</button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
