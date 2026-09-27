'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AUDITORIUM_PHOTO } from '@/lib/brand';

type Festival = {
  id: string;
  name: string;
  name_bn: string;
  venue: string;
  address: string;
  status: string;
  contact_email: string;
  terms: string;
  hold_minutes: number;
  max_quantity: number;
  theater_photo?: string;
};

type Show = {
  id: string;
  title: string;
  title_bn: string;
  troupe: string;
  synopsis: string;
  synopsis_bn: string;
  starts_at: string;
  runtime: number;
  genre: string;
  status: string;
  language: string;
  artwork: string;
};

type Product = {
  id: string;
  name: string;
  name_bn: string;
  category: string;
  kind: string;
  price: number;
  version: number;
  enabled: boolean;
  show_id: string | null;
  available: number;
};

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/** Format a timestamptz for datetime-local using Asia/Kolkata wall clock. */
function toLocalInput(iso: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** Interpret datetime-local as IST and store UTC ISO. */
function fromLocalInput(value: string) {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return new Date(value).toISOString();
  const [, y, mo, d, h, mi] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:00+05:30`).toISOString();
}

function isPosterUrl(artwork: string) {
  return artwork.startsWith('/') || artwork.startsWith('http');
}

export default function AdminPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [profile, setProfile] = useState<{ contact: string; name: string; role: string } | null>(null);
  const [festival, setFestival] = useState<Festival | null>(null);
  const [shows, setShows] = useState<Show[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tab, setTab] = useState<'festival' | 'shows' | 'prices' | 'zones'>('festival');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingShow, setEditingShow] = useState<Show | null>(null);
  const [creating, setCreating] = useState(false);
  const [posterPreview, setPosterPreview] = useState('');

  const load = useCallback(async () => {
    setError('');
    const me = await fetch('/api/admin/me');
    if (me.status === 401) {
      setAllowed(false);
      return;
    }
    if (!me.ok) {
      setAllowed(false);
      setError('Admin access denied.');
      return;
    }
    const body = await me.json();
    if (body.role === 'customer') {
      setAllowed(false);
      setError('Staff sign-in required for the admin panel.');
      return;
    }
    setProfile({ contact: body.contact, name: body.name, role: body.role });
    setAllowed(true);
    const [fRes, sRes, pRes] = await Promise.all([
      fetch('/api/admin/festival'),
      fetch('/api/admin/shows'),
      fetch('/api/admin/products'),
    ]);
    if (!fRes.ok || !sRes.ok || !pRes.ok) {
      setError('Could not load admin catalogue.');
      return;
    }
    setFestival((await fRes.json()).festival);
    setShows((await sRes.json()).shows || []);
    setProducts((await pRes.json()).products || []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => setAllowed(false));
  }, [load]);

  async function uploadPoster(file: File): Promise<string | null> {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/admin/upload', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error || 'Poster upload failed.');
      return null;
    }
    return data.url as string;
  }

  async function saveFestival(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!festival) return;
    setBusy(true);
    setMessage('');
    setError('');
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name') || ''),
      nameBn: String(form.get('nameBn') || ''),
      venue: String(form.get('venue') || ''),
      address: String(form.get('address') || ''),
      contactEmail: String(form.get('contactEmail') || ''),
      terms: String(form.get('terms') || ''),
      status: String(form.get('status') || festival.status),
      holdMinutes: Number(form.get('holdMinutes') || festival.hold_minutes),
      maxQuantity: Number(form.get('maxQuantity') || festival.max_quantity),
      theaterPhoto: String(form.get('theaterPhoto') || festival.theater_photo || AUDITORIUM_PHOTO),
    };
    const res = await fetch('/api/admin/festival', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || 'Save failed.');
      return;
    }
    setMessage('Festival & theatre settings saved.');
    await load();
  }

  async function saveShow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    const form = new FormData(event.currentTarget);
    let artwork = String(form.get('artwork') || posterPreview || editingShow?.artwork || '');
    const file = form.get('posterFile');
    if (file instanceof File && file.size > 0) {
      const url = await uploadPoster(file);
      if (!url) {
        setBusy(false);
        return;
      }
      artwork = url;
    }
    const payload = {
      title: String(form.get('title') || ''),
      titleBn: String(form.get('titleBn') || form.get('title') || ''),
      troupe: String(form.get('troupe') || ''),
      synopsis: String(form.get('synopsis') || 'Programme details to follow.'),
      synopsisBn: String(form.get('synopsisBn') || form.get('synopsis') || 'বিস্তারিত শীঘ্রই।'),
      startsAt: fromLocalInput(String(form.get('startsAt') || '')),
      runtime: Number(form.get('runtime') || 90),
      genre: String(form.get('genre') || 'Drama'),
      language: String(form.get('language') || 'Bengali'),
      status: String(form.get('status') || 'DRAFT'),
      artwork: artwork || 'red',
    };
    const res = await fetch(creating ? '/api/admin/shows' : `/api/admin/shows/${editingShow?.id}`, {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || 'Could not save performance.');
      return;
    }
    setMessage(creating ? 'Drama created with Daily ticket products.' : 'Drama updated.');
    setCreating(false);
    setEditingShow(null);
    setPosterPreview('');
    await load();
  }

  async function saveProduct(product: Product, priceRupees: number, enabled: boolean, name: string) {
    setBusy(true);
    setError('');
    setMessage('');
    const res = await fetch(`/api/admin/products/${product.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price: Math.round(priceRupees * 100),
        enabled,
        version: product.version,
        name,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error || 'Price update failed — refresh and retry.');
      return;
    }
    setMessage(`Updated ${name}.`);
    await load();
  }

  if (allowed === null) {
    return <main className="page-pad"><p className="muted">Loading admin dashboard…</p></main>;
  }

  if (!allowed) {
    return (
      <main className="page-pad">
        <div className="card stack" style={{ maxWidth: 480, margin: '2rem auto' }}>
          <h1 className="h2">Admin dashboard</h1>
          <p>{error || 'Staff access required.'}</p>
          <p className="muted">Sign in with your email and password to manage festival, theatre, posters, and shows.</p>
          <Link className="btn btn--primary" href="/admin/login">Admin sign-in</Link>
        </div>
      </main>
    );
  }

  const seasonProducts = products.filter((p) => p.kind === 'SEASON');
  const theaterPhoto = festival?.theater_photo || AUDITORIUM_PHOTO;

  return (
    <main className="page-pad admin">
      <div className="admin__head">
        <div>
          <p className="eyebrow">Staff · {profile?.role}</p>
          <h1 className="h2">Admin dashboard</h1>
          <p className="muted">{profile?.name || profile?.contact}</p>
        </div>
        <div className="admin__tabs" role="tablist">
          <Link className="btn btn--primary" href="/admin/accounts">Accounts</Link>
          <Link className="btn btn--ghost" href="/gate">Check tickets</Link>
          {([
            ['festival', 'Festival & theatre'],
            ['shows', 'Dramas'],
            ['prices', 'Ticket prices'],
            ['zones', 'Auditorium zones'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'btn btn--primary' : 'btn btn--ghost'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      {tab === 'festival' && festival && (
        <form className="card stack admin__panel" onSubmit={saveFestival}>
          <h2 className="h3">Festival & theatre</h2>
          <div className="admin__grid-2">
            <label className="field">
              <span>Festival name</span>
              <input name="name" defaultValue={festival.name} required />
            </label>
            <label className="field">
              <span>Festival name (Bengali)</span>
              <input name="nameBn" defaultValue={festival.name_bn} lang="bn" />
            </label>
            <label className="field">
              <span>Theatre / venue name</span>
              <input name="venue" defaultValue={festival.venue} required />
            </label>
            <label className="field">
              <span>Address</span>
              <input name="address" defaultValue={festival.address} />
            </label>
            <label className="field">
              <span>Contact email</span>
              <input name="contactEmail" type="email" defaultValue={festival.contact_email} required />
            </label>
            <label className="field">
              <span>Publication status</span>
              <select name="status" defaultValue={festival.status}>
                {['DRAFT', 'PUBLISHED', 'PAUSED', 'CLOSED'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Hold minutes</span>
              <input name="holdMinutes" type="number" min={1} max={30} defaultValue={festival.hold_minutes} />
            </label>
            <label className="field">
              <span>Max tickets per checkout</span>
              <input name="maxQuantity" type="number" min={1} max={20} defaultValue={festival.max_quantity} />
            </label>
          </div>
          <label className="field">
            <span>Auditorium photo URL</span>
            <input name="theaterPhoto" defaultValue={theaterPhoto} />
          </label>
          <div className="admin__photo-preview">
            { }
            <img src={theaterPhoto} alt={`${festival.venue} auditorium`} />
          </div>
          <label className="field">
            <span>Terms</span>
            <textarea name="terms" rows={4} defaultValue={festival.terms} />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save festival'}</button>
        </form>
      )}

      {tab === 'shows' && (
        <div className="stack admin__panel">
          <div className="admin__row">
            <h2 className="h3">Dramas & schedule</h2>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setCreating(true);
                setEditingShow(null);
                setPosterPreview('');
              }}
            >
              New drama
            </button>
          </div>

          {(creating || editingShow) && (
            <form className="card stack" onSubmit={saveShow}>
              <h3 className="h3">{creating ? 'New drama' : `Edit · ${editingShow?.title}`}</h3>
              <div className="admin__grid-2">
                <label className="field">
                  <span>Drama title</span>
                  <input name="title" defaultValue={editingShow?.title || ''} required />
                </label>
                <label className="field">
                  <span>Title (Bengali)</span>
                  <input name="titleBn" defaultValue={editingShow?.title_bn || ''} lang="bn" />
                </label>
                <label className="field">
                  <span>Troupe / company</span>
                  <input name="troupe" defaultValue={editingShow?.troupe || ''} required />
                </label>
                <label className="field">
                  <span>Date & time (IST)</span>
                  <input name="startsAt" type="datetime-local" defaultValue={editingShow ? toLocalInput(editingShow.starts_at) : ''} required />
                </label>
                <label className="field">
                  <span>Runtime (minutes)</span>
                  <input name="runtime" type="number" min={1} defaultValue={editingShow?.runtime || 90} required />
                </label>
                <label className="field">
                  <span>Genre</span>
                  <input name="genre" defaultValue={editingShow?.genre || 'Drama'} />
                </label>
                <label className="field">
                  <span>Language</span>
                  <input name="language" defaultValue={editingShow?.language || 'Bengali'} />
                </label>
                <label className="field">
                  <span>Status</span>
                  <select name="status" defaultValue={editingShow?.status || 'PUBLISHED'}>
                    {['DRAFT', 'PUBLISHED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Synopsis</span>
                <textarea name="synopsis" rows={3} defaultValue={editingShow?.synopsis || ''} />
              </label>
              <label className="field">
                <span>Synopsis (Bengali)</span>
                <textarea name="synopsisBn" rows={3} defaultValue={editingShow?.synopsis_bn || ''} lang="bn" />
              </label>
              <div className="admin__grid-2">
                <label className="field">
                  <span>Poster image</span>
                  <input
                    name="posterFile"
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setBusy(true);
                      const url = await uploadPoster(file);
                      setBusy(false);
                      if (url) setPosterPreview(url);
                    }}
                  />
                </label>
                <label className="field">
                  <span>Or poster URL</span>
                  <input
                    name="artwork"
                    defaultValue={isPosterUrl(editingShow?.artwork || '') ? editingShow?.artwork : ''}
                    placeholder="/uploads/posters/… or https://…"
                    onChange={(e) => setPosterPreview(e.target.value)}
                  />
                </label>
              </div>
              {(posterPreview || (editingShow && isPosterUrl(editingShow.artwork))) && (
                <div className="admin__poster-preview">
                  { }
                  <img src={posterPreview || editingShow!.artwork} alt="Drama poster preview" />
                </div>
              )}
              <div className="admin__row">
                <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save drama'}</button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setCreating(false);
                    setEditingShow(null);
                    setPosterPreview('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          <div className="admin__show-list">
            {shows.map((show) => (
              <article key={show.id} className="card admin__show-card">
                <div className="admin__show-art">
                  {isPosterUrl(show.artwork) ? (
                     
                    <img src={show.artwork} alt="" />
                  ) : (
                    <div className={`admin__show-swatch admin__show-swatch--${show.artwork}`} />
                  )}
                </div>
                <div>
                  <p className="eyebrow">{show.status} · {show.genre}</p>
                  <h3>{show.title}</h3>
                  <p className="muted" lang="bn">{show.title_bn}</p>
                  <p className="muted">
                    {new Date(show.starts_at).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                    {' · '}{show.runtime} min · {show.troupe}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setEditingShow(show);
                    setCreating(false);
                    setPosterPreview(isPosterUrl(show.artwork) ? show.artwork : '');
                  }}
                >
                  Edit
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {tab === 'prices' && (
        <div className="stack admin__panel">
          <h2 className="h3">Ticket prices by zone</h2>
          <p className="muted">View from the stage. Ground floor: Premier in front, Superior at the back under the balcony. First floor: Balcony. Season passes cover the festival; Daily covers one show.</p>
          <div className="grid">
            {products.map((product) => (
              <form
                key={product.id}
                className="card stack stack--sm"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  saveProduct(
                    product,
                    Number(form.get('price')),
                    form.get('enabled') === 'on',
                    String(form.get('name') || product.name),
                  );
                }}
              >
                <p className="eyebrow">{product.kind} · {product.category}</p>
                <label className="field">
                  <span>Display name</span>
                  <input name="name" defaultValue={product.name} />
                </label>
                <label className="field">
                  <span>Price (₹)</span>
                  <input name="price" type="number" min={0} step={1} defaultValue={product.price / 100} />
                </label>
                <label className="field field--check">
                  <input name="enabled" type="checkbox" defaultChecked={product.enabled} />
                  <span>On sale ({product.available} available)</span>
                </label>
                <p className="muted" style={{ margin: 0 }}>{money(product.price)}</p>
                <button className="btn btn--primary" type="submit" disabled={busy}>Update</button>
              </form>
            ))}
          </div>
        </div>
      )}

      {tab === 'zones' && (
        <div className="card stack admin__panel">
          <h2 className="h3">Auditorium zones (guest map)</h2>
          <p className="muted">
            Guests see a photo taken from the stage. Hovering a band reveals Premier, Superior, or Balcony —
            with Daily and Season pricing for that zone.
          </p>
          <div className="admin__zone-legend">
            <div><strong>Stage</strong> — bottom of the picture (not for sale)</div>
            <div><strong>Premier</strong> — ground floor, front, nearest the stage</div>
            <div><strong>Superior</strong> — ground floor, back, under the balcony</div>
            <div><strong>Balcony</strong> — first floor</div>
            <div><strong>Season</strong> — festival pass for the chosen zone</div>
          </div>
          <div className="admin__photo-preview">
            { }
            <img src={theaterPhoto} alt="Auditorium seating reference" />
          </div>
          <ul className="admin__zone-prices">
            {seasonProducts.map((p) => (
              <li key={p.id}>{p.category} Season · {money(p.price)}</li>
            ))}
          </ul>
          <Link className="btn btn--primary" href="/catalogue">Preview guest catalogue</Link>
        </div>
      )}
    </main>
  );
}
