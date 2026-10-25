'use client';

import { useCallback, useEffect, useState } from 'react';
import { AUDITORIUM_HOUSE } from '@/lib/brand';

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
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/inventory', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load inventory.'); return; }
    setRows((body as { zones: ZoneRow[] }).zones);
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
      <img className="auditorium__plan" src={AUDITORIUM_HOUSE} alt="Auditorium plan: Premier in front, Superior behind, Balcony above, stage at the front" />
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

      <p className="muted" style={{ margin: 0 }}>Create, edit and delete season tickets, and choose their performances, under <strong>Seasons</strong>.</p>


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
