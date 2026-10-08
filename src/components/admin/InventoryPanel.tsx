'use client';

import { useCallback, useEffect, useState } from 'react';

type ZoneRow = {
  show_id: string;
  title: string;
  starts_at: string;
  show_status: string;
  capacity_id: string;
  zone: string;
  ceiling: number;
  season_allocation: number | null;
  version: number;
  daily_allocation: number;
  daily_used: number;
  daily_sold: number;
  online_season_allocation: number;
  season_used: number;
  season_sold: number;
  daily_price: number | null;
  daily_enabled: boolean | null;
};

const ZONES = ['Premier', 'Superior', 'Balcony'];
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || 'Request failed.');
  return json;
}

/**
 * Capacity and allocations per performance × zone. Every rule (daily + season ≤
 * capacity, online season ≤ season, never below what is sold or held) is enforced
 * by the server; this form only collects numbers.
 */
export default function InventoryPanel({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<ZoneRow[]>([]);
  const [seasons, setSeasons] = useState<{ id: string; name: string; category: string }[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/inventory', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load inventory.'); return; }
    setRows((body as { zones: ZoneRow[] }).zones);
    const products = await fetch('/api/admin/products', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { products: [] })).catch(() => ({ products: [] }));
    setSeasons(((products as { products?: { id: string; name: string; category: string; kind: string }[] }).products ?? []).filter((p) => p.kind === 'SEASON'));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      await action();
      setMessage(done);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  const shows = [...new Map(rows.map((r) => [r.show_id, r])).values()];

  return (
    <div className="stack admin__panel">
      <h2 className="h3">Inventory & allocations</h2>
      <p className="muted">
        Per performance and zone: total capacity, seats set aside for season tickets, daily tickets sold online, and
        how many season tickets the website may sell. Daily and season tickets use separate stock, so neither can
        oversell the other. A season ticket uses one seat in every performance it covers.
      </p>
      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      <form
        className="card stack stack--sm"
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          void run(() => send('/api/admin/inventory', 'POST', {
            zone: f.get('zone'), seasonAllocation: Number(f.get('seasonAllocation')), onlineSeasonAllocation: Number(f.get('onlineSeasonAllocation')),
          }), 'Season allocation applied to every upcoming performance of that zone.');
        }}
      >
        <h3 className="h3">Season allocation for a zone (all upcoming performances)</h3>
        <div className="grid">
          <label className="field"><span>Zone</span><select name="zone">{ZONES.map((z) => <option key={z}>{z}</option>)}</select></label>
          <label className="field"><span>Season allocation</span><input name="seasonAllocation" type="number" min={0} required /></label>
          <label className="field"><span>Online season allocation</span><input name="onlineSeasonAllocation" type="number" min={0} required /></label>
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy}>Apply to zone</button>
      </form>

      <form
        className="card stack stack--sm"
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          void run(() => send('/api/admin/products', 'POST', {
            category: f.get('category'), name: f.get('name'), nameBn: f.get('nameBn'), price: Math.round(Number(f.get('price')) * 100),
          }), 'Season ticket created. Enable or edit it under Ticket prices.');
        }}
      >
        <h3 className="h3">New season ticket</h3>
        <p className="muted" style={{ margin: 0 }}>Covers every published performance that has not started, for one zone.</p>
        <div className="grid">
          <label className="field"><span>Zone</span><select name="category">{ZONES.map((z) => <option key={z}>{z}</option>)}</select></label>
          <label className="field"><span>Name</span><input name="name" required /></label>
          <label className="field"><span>Name (Bengali)</span><input name="nameBn" required /></label>
          <label className="field"><span>Price (₹)</span><input name="price" type="number" min={1} required /></label>
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy}>Create season ticket</button>
      </form>

      <form
        className="card stack stack--sm"
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          void run(() => send(`/api/admin/products/${String(f.get('productId'))}/coverage`, 'POST', { showId: f.get('showId') }),
            'Performance added to the season ticket.');
        }}
      >
        <h3 className="h3">Add a performance to a season ticket</h3>
        <p className="muted" style={{ margin: 0 }}>
          New performances are not added to season tickets automatically. This is only possible before any season ticket of that zone is sold.
        </p>
        <div className="grid">
          <label className="field"><span>Season ticket</span>
            <select name="productId" required>{seasons.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.category}</option>)}</select>
          </label>
          <label className="field"><span>Performance</span>
            <select name="showId" required>{shows.map((s) => <option key={s.show_id} value={s.show_id}>{s.title} · {when(s.starts_at)}</option>)}</select>
          </label>
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy || seasons.length === 0}>Add to season</button>
      </form>

      {shows.map((show) => (
        <section key={show.show_id} className="card stack stack--sm">
          <h3 className="h3">{show.title} <span className="muted">· {when(show.starts_at)} · {show.show_status}</span></h3>
          <div className="grid">
            {rows.filter((r) => r.show_id === show.show_id).map((r) => (
              <form
                key={r.capacity_id}
                className="stack stack--sm"
                onSubmit={(event) => {
                  event.preventDefault();
                  const f = new FormData(event.currentTarget);
                  void run(() => send('/api/admin/inventory', 'PATCH', {
                    capacityId: r.capacity_id, version: r.version,
                    ceiling: Number(f.get('ceiling')), seasonAllocation: Number(f.get('seasonAllocation')),
                    dailyAllocation: Number(f.get('dailyAllocation')), onlineSeasonAllocation: Number(f.get('onlineSeasonAllocation')),
                  }), `${show.title} · ${r.zone} updated.`);
                }}
              >
                <p className="eyebrow">{r.zone}{r.daily_enabled === false ? ' · daily tickets off' : ''}</p>
                <label className="field"><span>Total capacity</span><input name="ceiling" type="number" min={0} defaultValue={r.ceiling} /></label>
                <label className="field"><span>Season allocation</span><input name="seasonAllocation" type="number" min={0} defaultValue={r.season_allocation ?? r.online_season_allocation} /></label>
                <label className="field"><span>Daily allocation (online) · {r.daily_used} sold/held</span><input name="dailyAllocation" type="number" min={0} defaultValue={r.daily_allocation} /></label>
                <label className="field"><span>Online season allocation · {r.season_used} sold/held</span><input name="onlineSeasonAllocation" type="number" min={0} defaultValue={r.online_season_allocation} /></label>
                <button className="btn btn--ghost btn--sm" type="submit" disabled={busy}>Save {r.zone}</button>
              </form>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
