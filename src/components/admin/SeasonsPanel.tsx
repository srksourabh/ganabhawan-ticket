'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Performance = { id: string; title: string; startsAt: string; status: string };
type Season = {
  id: string; name: string; nameBn: string; zone: string; price: number; enabled: boolean; version: number;
  available: number; state: string; open: boolean; closedReasons: string[];
  confirmedBookings: number; purchasesInProgress: number; performances: Performance[];
  performancesLocked: boolean; deletable: boolean; deleteBlockedReason: string | null;
};
type Overview = {
  sales: { configured: boolean; publicSales: boolean; seasonSwitch: boolean; open: boolean; setting: string };
  zonesWithoutSeason: string[];
  upcomingPerformances: { id: string; title: string; startsAt: string }[];
  seasons: Season[];
};
type FieldErrors = Partial<Record<'zone' | 'name' | 'nameBn' | 'price', string>>;

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || 'Request failed. Nothing was changed.');
  return json;
}

/** Client-side checks mirror the server's (seasons.ts / inventory-admin.ts); the server decides. */
function validate(form: FormData, creating: boolean): { errors: FieldErrors; values: Record<string, unknown> } {
  const errors: FieldErrors = {};
  const name = String(form.get('name') ?? '').trim();
  const nameBn = String(form.get('nameBn') ?? '').trim();
  const priceText = String(form.get('price') ?? '').trim();
  const priceRupees = Number(priceText);
  if (creating && !form.get('zone')) errors.zone = 'Choose a zone.';
  if (!name || name.length > 120) errors.name = 'Name is required (at most 120 characters).';
  if (!nameBn || nameBn.length > 120) errors.nameBn = 'Bengali name is required (at most 120 characters).';
  if (!/^\d+(\.\d{1,2})?$/.test(priceText) || priceRupees <= 0) errors.price = 'Enter a price above ₹0, with at most two decimals.';
  return { errors, values: { name, nameBn, price: Math.round(priceRupees * 100) } };
}

/**
 * Season tickets: one per zone, each covering an explicit list of performances. List,
 * create, edit (name, price, On sale, performances before any sale) and delete (only if
 * never booked). Whether new season sales are open is a server setting shown read-only.
 */
export default function SeasonsPanel({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [createErrors, setCreateErrors] = useState<FieldErrors>({});
  const [editErrors, setEditErrors] = useState<FieldErrors>({});
  /** One request at a time: state updates are not visible to a second click in the same tick. */
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/seasons', { cache: 'no-store' }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) setError((body as { error?: string }).error || 'Could not load season tickets.');
    else setData(body as Overview);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      await action();
      setEditing(null);
      setDeleting(null);
      await load(); // show the stored result, then say so
      setMessage(done);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed. Nothing was changed.');
      await load(); // the current state, never an assumed one
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  if (loading) return <div className="stack admin__panel"><h2 className="h3">Seasons</h2><p className="muted" role="status">Loading season tickets…</p></div>;

  return (
    <div className="stack admin__panel">
      <h2 className="h3">Seasons</h2>
      <p className="muted">
        A season ticket is sold per zone and admits to every performance it covers. Cancelled performances are not part of new sales.
        Seats come from each performance&apos;s season allocation (Inventory).
      </p>
      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      {data && (
        <section className="card stack stack--sm" aria-labelledby="season-switch-heading">
          <h3 id="season-switch-heading" className="h3">Season-ticket sales: {data.sales.seasonSwitch ? 'Open' : 'Closed'}</h3>
          <p style={{ margin: 0 }}>
            Customers can buy season tickets only when <strong>all</strong> of these are on: public sales
            ({data.sales.publicSales ? 'on' : 'off'}), season-ticket sales ({data.sales.seasonSwitch ? 'on' : 'off'}), the customer-sales
            configuration ({data.sales.configured ? 'complete' : 'incomplete'}), and the season ticket&apos;s own &quot;On sale&quot;.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            The season-ticket switch is the server setting <code>{data.sales.setting}</code> (<code>true</code> = open), and public sales are{' '}
            <code>ALLOW_PUBLIC_SALES</code>. Both are changed by the operator in the Cloudflare Worker configuration, not on this page.
          </p>
        </section>
      )}

      {data && data.seasons.length === 0 && <p className="muted" role="status">No season tickets yet. Create one below.</p>}

      {data?.seasons.map((season) => {
        const active = season.performances.filter((p) => p.status !== 'CANCELLED');
        const addable = data.upcomingPerformances.filter((p) => !season.performances.some((c) => c.id === p.id));
        return (
          <article key={season.id} className="card stack stack--sm">
            <p className="eyebrow">{season.zone} · {season.enabled ? 'On sale' : 'Not on sale'}</p>
            <h3 className="h3">{season.name} <span className="muted">· {season.nameBn}</span></h3>
            <p style={{ margin: 0 }}>
              {rupees(season.price)} · {active.length} performance{active.length === 1 ? '' : 's'}
              {season.performances.length > active.length ? ` (${season.performances.length - active.length} cancelled, not included in new sales)` : ''}
              {' '}· {season.confirmedBookings} confirmed booking{season.confirmedBookings === 1 ? '' : 's'}
              {season.purchasesInProgress ? ` · ${season.purchasesInProgress} in progress` : ''}
            </p>
            <p role="status" style={{ margin: 0 }}>
              <strong>{season.open ? `Customers can buy it (${season.available} left)` : 'Customers cannot buy it now'}</strong>
            </p>
            {!season.open && (
              <ul className="muted" style={{ margin: 0 }}>
                {season.closedReasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            )}
            <div className="admin__row">
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => { setEditing(editing === season.id ? null : season.id); setEditErrors({}); setDeleting(null); }}>
                {editing === season.id ? 'Close' : 'Edit'}
              </button>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => { setDeleting(season.id); setEditing(null); }}>Delete</button>
            </div>

            {deleting === season.id && (
              <div className="card stack stack--sm admin__confirm" role="alertdialog" aria-labelledby={`delete-season-${season.id}`}>
                <h4 id={`delete-season-${season.id}`} className="h3">Delete this season ticket?</h4>
                <p>Season ticket: <strong>{season.name}</strong> ({season.zone})</p>
                {season.deletable ? (
                  <p className="muted">It has never been booked, so it is removed permanently with its list of performances. Performances and their seats are not affected.</p>
                ) : (
                  <p className="muted">{season.deleteBlockedReason}</p>
                )}
                <div className="admin__row">
                  <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
                  {season.deletable && (
                    <button type="button" className="btn btn--danger" disabled={busy}
                      onClick={() => { void run(() => send(`/api/admin/seasons/${season.id}`, 'DELETE'), `Season ticket "${season.name}" deleted.`); }}>
                      {busy ? 'Deleting…' : 'Delete season ticket'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {editing === season.id && (
              <div className="stack stack--sm">
                <form
                  className="stack stack--sm"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    const { errors, values } = validate(form, false);
                    setEditErrors(errors);
                    if (Object.keys(errors).length) return;
                    void run(() => send(`/api/admin/seasons/${season.id}`, 'PATCH', { ...values, enabled: form.get('enabled') === 'on', version: season.version }),
                      `Season ticket "${String(values.name)}" updated.`);
                  }}
                >
                  <div className="grid">
                    <label className="field"><span>Name</span>
                      <input name="name" defaultValue={season.name} aria-invalid={Boolean(editErrors.name)} aria-describedby={`e-name-${season.id}`} />
                      {editErrors.name && <small id={`e-name-${season.id}`} role="alert">{editErrors.name}</small>}
                    </label>
                    <label className="field"><span>Name (Bengali)</span>
                      <input name="nameBn" defaultValue={season.nameBn} aria-invalid={Boolean(editErrors.nameBn)} aria-describedby={`e-namebn-${season.id}`} />
                      {editErrors.nameBn && <small id={`e-namebn-${season.id}`} role="alert">{editErrors.nameBn}</small>}
                    </label>
                    <label className="field"><span>Price (₹)</span>
                      <input name="price" type="number" min={1} step="0.01" defaultValue={season.price / 100} aria-invalid={Boolean(editErrors.price)} aria-describedby={`e-price-${season.id}`} />
                      {editErrors.price && <small id={`e-price-${season.id}`} role="alert">{editErrors.price}</small>}
                    </label>
                    <label className="field field--check">
                      <input name="enabled" type="checkbox" defaultChecked={season.enabled} />
                      <span>On sale</span>
                    </label>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>The zone cannot be changed. A new price applies to new purchases only.</p>
                  <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
                </form>

                <h4 className="h3">Performances</h4>
                {season.performancesLocked && (
                  <p className="muted" style={{ margin: 0 }}>This season ticket has been booked, so its performances can no longer change.</p>
                )}
                <ul className="stack stack--sm" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {season.performances.map((p) => (
                    <li key={p.id}>
                      {p.title} · {when(p.startsAt)}{p.status !== 'PUBLISHED' ? ` · ${p.status}` : ''}
                      {!season.performancesLocked && season.performances.length > 1 && (
                        <>
                          {' '}
                          <button type="button" className="btn btn--ghost" disabled={busy}
                            onClick={() => { void run(() => send(`/api/admin/seasons/${season.id}/coverage/${p.id}`, 'DELETE'), `Removed "${p.title}" from ${season.name}.`); }}>
                            Remove
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {!season.performancesLocked && addable.length > 0 && (
                  <form
                    className="admin__row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const showId = String(new FormData(event.currentTarget).get('showId') ?? '');
                      void run(() => send(`/api/admin/seasons/${season.id}/coverage`, 'POST', { showId }), 'Performance added to the season ticket.');
                    }}
                  >
                    <label className="field"><span>Add a performance</span>
                      <select name="showId" required>{addable.map((p) => <option key={p.id} value={p.id}>{p.title} · {when(p.startsAt)}</option>)}</select>
                    </label>
                    <button className="btn btn--primary" type="submit" disabled={busy}>Add</button>
                  </form>
                )}
              </div>
            )}
          </article>
        );
      })}

      {data && data.zonesWithoutSeason.length > 0 && (
        <form
          className="card stack stack--sm"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const formEl = event.currentTarget;
            const form = new FormData(formEl);
            const { errors, values } = validate(form, true);
            setCreateErrors(errors);
            if (Object.keys(errors).length) return;
            void run(() => send('/api/admin/seasons', 'POST', { zone: form.get('zone'), ...values }), `Season ticket "${String(values.name)}" created.`)
              .then(() => formEl.reset());
          }}
        >
          <h3 className="h3">Create a season ticket</h3>
          <p className="muted" style={{ margin: 0 }}>One per zone. It covers every published performance that has not started; adjust the list afterwards (before any sale).</p>
          <div className="grid">
            <label className="field"><span>Zone</span>
              <select name="zone" aria-invalid={Boolean(createErrors.zone)}>{data.zonesWithoutSeason.map((z) => <option key={z}>{z}</option>)}</select>
              {createErrors.zone && <small role="alert">{createErrors.zone}</small>}
            </label>
            <label className="field"><span>Name</span>
              <input name="name" aria-invalid={Boolean(createErrors.name)} />
              {createErrors.name && <small role="alert">{createErrors.name}</small>}
            </label>
            <label className="field"><span>Name (Bengali)</span>
              <input name="nameBn" aria-invalid={Boolean(createErrors.nameBn)} />
              {createErrors.nameBn && <small role="alert">{createErrors.nameBn}</small>}
            </label>
            <label className="field"><span>Price (₹)</span>
              <input name="price" type="number" min={1} step="0.01" aria-invalid={Boolean(createErrors.price)} />
              {createErrors.price && <small role="alert">{createErrors.price}</small>}
            </label>
          </div>
          <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create season ticket'}</button>
        </form>
      )}
    </div>
  );
}
