'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The one staff sign-in form: email (or username) + password, nothing else.
 * `portal` tells the server which door this is; the server admits only that
 * door's roles (auth.ts loginStaff) and creates the usual secure session.
 */
export default function StaffLoginForm({ portal, eyebrow, title, intro, next, otherLabel, otherHref }: {
  portal: 'admin' | 'gate';
  eyebrow: string;
  title: string;
  intro: string;
  next: string;
  otherLabel: string;
  otherHref: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [wrongDoor, setWrongDoor] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setWrongDoor(false);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, portal }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(body.error || 'Sign-in failed.');
        setWrongDoor(body.code === 'WRONG_PORTAL');
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-login">
      <form className="admin-login__card" onSubmit={onSubmit}>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{intro}</p>

        <label className="field">
          <span>Email</span>
          <input type="text" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>

        {error && (
          <p className="banner banner--err" role="alert">
            {error} {wrongDoor && <Link href={otherHref}>{otherLabel}</Link>}
          </p>
        )}

        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Login'}
        </button>

        <p className="muted" style={{ marginTop: '1rem', textAlign: 'center' }}>
          <Link href={otherHref}>{otherLabel}</Link>
        </p>
      </form>
    </main>
  );
}
