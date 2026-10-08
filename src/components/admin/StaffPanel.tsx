'use client';

import { useCallback, useEffect, useState } from 'react';

type StaffRow = { id: string; contact: string; name: string; role: string; password: boolean; upcoming_scopes: number };

/** Roles the owner manages here (owners themselves: operator CLI only). Gate roles sign in at /gate/login, the others at /admin/login. */
const ROLES: { value: string; label: string; login: string }[] = [
  { value: 'scanner', label: 'Scanner (gate)', login: '/gate/login' },
  { value: 'supervisor', label: 'Supervisor (gate)', login: '/gate/login' },
  { value: 'inventory', label: 'Inventory (shows, prices, stock)', login: '/admin/login' },
  { value: 'finance', label: 'Finance (accounts, metrics)', login: '/admin/login' },
  { value: 'desk', label: 'Desk', login: '/admin/login' },
];
const MANAGEABLE = ROLES.map((r) => r.value);

async function send(url: string, method: string, body: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error || 'Request failed.');
  return json as Record<string, unknown>;
}

/**
 * Staff accounts (owner only; enforced by /api/admin/staff). Staff sign in with
 * email + password. New scanners and supervisors can scan every upcoming
 * performance at every gate.
 */
export default function StaffPanel() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/staff', { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError((body as { error?: string }).error || 'Could not load staff.'); return; }
    setStaff((body as { staff: StaffRow[] }).staff);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  const act = (id: string, body: Record<string, unknown>) => send(`/api/admin/staff/${id}`, 'PATCH', body);

  return (
    <div className="stack admin__panel">
      <h2 className="h3">Staff</h2>
      {message && <p className="banner banner--ok" role="status">{message}</p>}
      {error && <p className="banner banner--err" role="alert">{error}</p>}

      <form
        className="card stack stack--sm"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const f = new FormData(form);
          void run(async () => {
            await send('/api/admin/staff', 'POST', { email: f.get('email'), name: f.get('name'), role: f.get('role'), password: f.get('password') });
            form.reset();
          }, 'Staff account saved. Give the person their email, password and login page.');
        }}
      >
        <h3 className="h3">Add staff</h3>
        <div className="grid">
          <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="off" /></label>
          <label className="field"><span>Name</span><input name="name" /></label>
          <label className="field"><span>Role</span>
            <select name="role">{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
          </label>
          <label className="field"><span>Initial password (12+ characters)</span><input name="password" type="password" minLength={12} required autoComplete="new-password" /></label>
        </div>
        <button className="btn btn--primary" type="submit" disabled={busy}>Save staff</button>
      </form>

      <div className="grid">
        {staff.map((s) => (
          <article key={s.id} className="card stack stack--sm">
            <p className="eyebrow">{s.role}</p>
            <h3 className="h3">{s.name || s.contact}</h3>
            <p className="muted" style={{ margin: 0 }}>{s.contact}</p>
            <p style={{ margin: 0 }}>
              Active · Password {s.password ? 'set' : 'missing'}
              {['scanner', 'supervisor'].includes(s.role) ? ` · can scan ${s.upcoming_scopes} upcoming shows` : ''}
              {' · '}signs in at {ROLES.find((r) => r.value === s.role)?.login ?? '/admin/login'}
            </p>
            {MANAGEABLE.includes(s.role) && (
              <>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => {
                  const password = window.prompt('New password (12+ characters). The staff member is signed out everywhere.');
                  if (password) void run(() => act(s.id, { action: 'password', password }), 'Password changed.');
                }}>Reset password</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => {
                  const reason = window.prompt(`Deactivate ${s.contact}? Reason (recorded):`);
                  if (reason) void run(() => act(s.id, { action: 'deactivate', reason }), 'Access removed.');
                }}>Deactivate</button>
              </>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
