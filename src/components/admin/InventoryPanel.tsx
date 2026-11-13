'use client';

import { useCallback, useEffect, useState } from 'react';
import { AUDITORIUM_HOUSE } from '@/lib/brand';
import { zoneLabel } from '@/lib/i18n';

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

type PassSeats = { zone: string; label: string; productId: string; programmes: number; remaining: number; lowest: { showId: string; title: string; remaining: number } | null };

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
  const [passes, setPasses] = useState<PassSeats[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/inventory', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load inventory.'); return; }
    setRows((body as { zones: ZoneRow[] }).zones);
    setPasses((body as { allTogether?: PassSeats[] }).allTogether ?? []);
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
      <img className="auditorium__plan" src={AUDITORIUM_HOUSE} alt="Auditorium plan: Front block in front, Second block behind, First floor above, stage at the front" />
      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      {passes.length > 0 && (
        <section className="card stack stack--sm" aria-labelledby="add-all-together-seats">
          <h3 id="add-all-together-seats" className="h3">Add All Together seats</h3>
          <p className="muted" style={{ margin: 0 }}>
            An All Together pass needs a seat in every programme it covers, so the seats it can sell are the lowest number left
            in any of them. Adding seats here adds them to every programme of the pass at once (all or nothing).
          </p>
          <div className="grid">
            {passes.map((p) => (
              <form
                key={p.productId}
                className="stack stack--sm"
                onSubmit={(event) => {
                  event.preventDefault();
                  const seats = Number(new FormData(event.currentTarget).get('seats'));
                  void run(() => send('/api/admin/inventory/all-together-seats', 'POST', { zone: p.zone, seats, expectedAvailable: p.remaining }),
                    `${p.label}: ${seats} All Together seat${seats === 1 ? '' : 's'} added to each of its ${p.programmes} programmes.`);
                }}
              >
                <p className="eyebrow">{p.label}</p>
                <p style={{ margin: 0 }} data-testid={`pass-seats-${p.zone}`}><strong>{p.remaining}</strong> seats left · {p.programmes} programmes</p>
                {p.lowest && <p className="muted" style={{ margin: 0 }}>Lowest: {p.lowest.title} ({p.lowest.remaining} left)</p>}
                <label className="field"><span>Seats to add</span><input name="seats" type="number" min={1} max={1000} step={1} required /></label>
                <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>Add seats to {p.label}</button>
              </form>
            ))}
          </div>
        </section>
      )}

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
        <h3 className="h3">Set exact season allocation for a zone (all upcoming performances)</h3>
        <p className="muted" style={{ margin: 0 }}>Replaces the numbers (it does not add). To add seats to All Together, use Add All Together seats above.</p>
        <div className="grid">
          <label className="field"><span>Zone</span><select name="zone">{ZONES.map((z) => <option key={z} value={z}>{zoneLabel('en', z)}</option>)}</select></label>
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
                  }), `${show.title} · ${zoneLabel('en', r.zone)} updated.`);
                }}
              >
                <p className="eyebrow">{zoneLabel('en', r.zone)}{r.daily_enabled === false ? ' · daily tickets off' : ''}</p>
                <label className="field"><span>Total capacity</span><input name="ceiling" type="number" min={0} defaultValue={r.ceiling} /></label>
                <label className="field"><span>Season allocation</span><input name="seasonAllocation" type="number" min={0} defaultValue={r.season_allocation ?? r.online_season_allocation} /></label>
                <label className="field"><span>Daily allocation (online) · {r.daily_used} sold/held</span><input name="dailyAllocation" type="number" min={0} defaultValue={r.daily_allocation} /></label>
                <label className="field"><span>Online season allocation · {r.season_used} sold/held</span><input name="onlineSeasonAllocation" type="number" min={0} defaultValue={r.online_season_allocation} /></label>
                <button className="btn btn--ghost btn--sm" type="submit" disabled={busy}>Save {zoneLabel('en', r.zone)}</button>
              </form>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
