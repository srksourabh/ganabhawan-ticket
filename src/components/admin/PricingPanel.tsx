'use client';

import { useCallback, useEffect, useState } from 'react';

type ZoneRow = { zone: string; label: string; price: number | null; configured: boolean; version: number | null; updatedAt: string | null };
type AllTogetherRow = {
  zone: string; label: string; productId: string | null; name?: string; enabled?: boolean; version?: number; updatedAt?: string | null;
  perProgrammePrice?: number | null; programmeCount?: number; originalTotal?: number | null; finalPrice?: number;
  discountAmount?: number; discountPercent?: number; blocked?: boolean; problem?: string | null;
  missingProgrammes?: { id: string; title: string; startsAt: string }[];
};
type Overview = { ready: boolean; zones: ZoneRow[]; allTogether: AllTogetherRow[] };

const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? '—' : `₹${(paise / 100).toLocaleString('en-IN')}`);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—');

/** "500" or "500.50" rupees → paise; null when not a positive amount with at most two decimals. */
export function rupeesToPaise(text: string): number | null {
  const value = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const paise = Math.round(Number(value) * 100);
  return paise > 0 ? paise : null;
}

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || 'Request failed. Nothing was changed.');
  return json;
}

/**
 * A. Price per programme (one per zone): daily tickets of every upcoming programme use it, and
 *    the All Together original total is computed from it.
 * B. All Together: the admin enters only the final price; original total, saving and percentage
 *    are computed by the server (pricing.ts) from A × the programmes the pass covers.
 */
export default function PricingPanel({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/pricing', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load prices.'); return; }
    setData(body as Overview);
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
      setError(e instanceof Error ? e.message : 'Request failed. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <p className="banner banner--err" role="alert">{error}</p> : <p className="muted" role="status">Loading prices…</p>;

  return (
    <div className="stack">
      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      <section className="card stack stack--sm" aria-labelledby="per-programme-heading">
        <h3 id="per-programme-heading" className="h3">Price per programme</h3>
        <p className="muted" style={{ margin: 0 }}>
          One price per zone, shared by daily tickets (every upcoming programme) and the All Together original total.
          Saving it updates both. Tickets already booked keep the price they were bought at.
        </p>
        {!data.ready && <p className="banner banner--err" role="alert">Shared prices need database migration 0012. Prices are shown from the daily tickets until it is applied.</p>}
        <table className="admin__table">
          <thead><tr><th>Zone</th><th>Price per programme</th><th>Last updated</th><th>New price (₹)</th></tr></thead>
          <tbody>
            {data.zones.map((z) => (
              <tr key={z.zone}>
                <td><strong>{z.label}</strong></td>
                <td>{rupees(z.price)}{!z.configured && z.price !== null ? <span className="muted"> (from daily tickets)</span> : null}</td>
                <td>{when(z.updatedAt)}</td>
                <td>
                  <form
                    key={`${z.version ?? 'derived'}-${z.price ?? ''}`}
                    className="admin__row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const paise = rupeesToPaise(String(new FormData(event.currentTarget).get('price') ?? ''));
                      if (paise === null) { setError(`${z.label}: enter a price above ₹0, with at most two decimals.`); return; }
                      void run(() => send('/api/admin/pricing', 'PUT', { zone: z.zone, price: paise, version: z.version }), `${z.label}: ${rupees(paise)} per programme saved. Daily tickets and All Together prices are updated.`);
                    }}
                  >
                    <label className="sr-only" htmlFor={`zone-price-${z.zone}`}>{z.label} price per programme in rupees</label>
                    <input id={`zone-price-${z.zone}`} name="price" inputMode="decimal" defaultValue={z.price === null ? '' : String(z.price / 100)} style={{ maxWidth: '8rem' }} />
                    <button className="btn btn--primary btn--sm" type="submit" disabled={busy || !data.ready}>Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card stack stack--sm" aria-labelledby="all-together-heading">
        <h3 id="all-together-heading" className="h3">All Together — final prices</h3>
        <p className="muted" style={{ margin: 0 }}>
          Enter only the final All Together price. The original total (price per programme × programmes in the pass), the saving and the
          percentage are calculated. A final price above the original total is not sold until it is lowered.
          Create passes and choose their programmes under <strong>Seasons</strong>.
        </p>
        <table className="admin__table">
          <thead>
            <tr><th>Zone</th><th>Original total</th><th>Final price</th><th>Discount</th><th>Discount %</th><th>Last updated</th><th>New final price (₹)</th></tr>
          </thead>
          <tbody>
            {data.allTogether.map((row) => row.productId === null ? (
              <tr key={row.zone}><td><strong>{row.label}</strong></td><td colSpan={6} className="muted">No All Together pass for this zone (create one under Seasons).</td></tr>
            ) : (
              <tr key={row.zone} aria-invalid={row.blocked || undefined}>
                <td><strong>{row.label}</strong></td>
                <td>
                  {rupees(row.originalTotal)}
                  {row.perProgrammePrice !== null && row.perProgrammePrice !== undefined && <><br /><span className="muted">{rupees(row.perProgrammePrice)} × {row.programmeCount} programmes</span></>}
                </td>
                <td>{rupees(row.finalPrice)}</td>
                <td>{row.blocked ? '—' : rupees(row.discountAmount)}</td>
                <td>{row.blocked ? '—' : `${row.discountPercent}%`}</td>
                <td>{when(row.updatedAt)}</td>
                <td>
                  <form
                    key={`${row.version}-${row.finalPrice}`}
                    className="admin__row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const paise = rupeesToPaise(String(new FormData(event.currentTarget).get('price') ?? ''));
                      if (paise === null) { setError(`${row.label}: enter a price above ₹0, with at most two decimals.`); return; }
                      if (row.originalTotal !== null && row.originalTotal !== undefined && paise > row.originalTotal) {
                        setError(`${row.label}: the final price cannot be more than the original total ${rupees(row.originalTotal)}.`); return;
                      }
                      void run(() => send(`/api/admin/seasons/${row.productId}`, 'PATCH', { price: paise, version: row.version }), `${row.label}: All Together price ${rupees(paise)} saved.`);
                    }}
                  >
                    <label className="sr-only" htmlFor={`final-price-${row.zone}`}>{row.label} final All Together price in rupees</label>
                    <input id={`final-price-${row.zone}`} name="price" inputMode="decimal" defaultValue={row.finalPrice === undefined ? '' : String(row.finalPrice / 100)} style={{ maxWidth: '8rem' }} />
                    <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>Save</button>
                  </form>
                  {row.blocked && <p className="banner banner--err" role="alert" style={{ whiteSpace: 'normal' }}>{row.problem} New All Together bookings are paused for this zone.</p>}
                  {row.missingProgrammes && row.missingProgrammes.length > 0 && (
                    <p className="banner banner--err" role="status" style={{ whiteSpace: 'normal' }}>
                      Not in this pass: {row.missingProgrammes.map((p) => `${p.title} (${when(p.startsAt)})`).join(', ')}.
                      The original total counts only the {row.programmeCount} programmes the pass covers. Add a programme under Seasons
                      (possible only before the pass has been sold).
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
