'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Sign-in failed.');
        return;
      }
      router.push('/admin');
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
        <p className="eyebrow">সমতট নাট্যমেলা</p>
        <h1>Admin sign-in</h1>
        <p className="muted">Use your email (or username) and password to manage the festival.</p>

        <label className="field">
          <span>Email or username</span>
          <input
            type="text"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>

        {error && <p className="banner banner--err" role="alert">{error}</p>}

        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in to dashboard'}
        </button>

        <p className="muted" style={{ marginTop: '1rem', textAlign: 'center' }}>
          Staff OTP still works at <Link href="/login?next=/admin">/login</Link>
        </p>
      </form>
    </main>
  );
}
