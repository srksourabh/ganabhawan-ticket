'use client';

import { useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';

/**
 * A verified mobile is required to buy (email is optional). The customer proves the
 * number with a code sent to it; the server stores it only after that (account-contacts.ts).
 */
export default function MobileVerify({ onVerified }: { onVerified: (mobile: string) => void }) {
  const { t } = useLocale();
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function call(method: 'POST' | 'PUT', body: unknown) {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/account/mobile', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; challengeId?: string; mobile?: string };
      if (!res.ok) throw new Error(json.error || t('mobile.failed'));
      return json;
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mobile.failed'));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack stack--sm">
      <p style={{ margin: 0, fontWeight: 700 }}>{t('mobile.required')}</p>
      {!challengeId ? (
        <form className="stack stack--sm" onSubmit={async (e) => { e.preventDefault(); const r = await call('POST', { mobile }); if (r?.challengeId) setChallengeId(r.challengeId); }}>
          <label className="field" htmlFor="verify-mobile">
            <span>{t('mobile.number')}</span>
            <input id="verify-mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" autoComplete="tel" required disabled={busy} />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy}>{t('mobile.send')}</button>
        </form>
      ) : (
        <form className="stack stack--sm" onSubmit={async (e) => { e.preventDefault(); const r = await call('PUT', { challengeId, code }); if (r?.mobile) onVerified(r.mobile); }}>
          <label className="field" htmlFor="verify-code">
            <span>{t('mobile.code')}</span>
            <input id="verify-code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required disabled={busy} />
          </label>
          <button className="btn btn--primary" type="submit" disabled={busy}>{t('mobile.verify')}</button>
        </form>
      )}
      {error && <p role="alert" className="banner banner--err" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
