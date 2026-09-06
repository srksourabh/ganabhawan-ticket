'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import GoogleSignInButton from '@/components/GoogleSignInButton';
import { useLocale } from '@/components/LocaleProvider';
import { ORGANISATION, ORGANISATION_BN } from '@/lib/brand';

const styles = {
  page: { minHeight: '100vh', background: '#f7f2ea', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1.25rem' },
  card: { width: '100%', maxWidth: 420, background: 'white', borderRadius: 12, padding: '2.5rem 2rem', boxShadow: '0 8px 32px #3d24120d' },
  eyebrow: { color: '#8b2f2f', letterSpacing: '.12em', textTransform: 'uppercase' as const, fontSize: '.78rem', margin: '0 0 .5rem' },
  heading: { fontFamily: 'Georgia, serif', fontSize: '2rem', margin: '0 0 1.5rem', lineHeight: 1.1 },
  label: { display: 'block', fontSize: '.9rem', fontWeight: 500, marginBottom: '.35rem', color: '#3d2a1e' },
  input: { width: '100%', padding: '.8rem 1rem', border: '1px solid #b9a99a', borderRadius: 6, fontSize: '1rem', background: '#fdfaf7', outline: 'none' },
  btn: { width: '100%', padding: '.85rem', background: '#8b2f2f', color: 'white', border: 0, borderRadius: 6, fontSize: '1rem', fontWeight: 600, cursor: 'pointer', marginTop: '.75rem' },
  btnDisabled: { opacity: .55, cursor: 'not-allowed' as const },
  error: { padding: '.8rem 1rem', background: '#fff0f0', border: '1px solid #e8c0c0', borderRadius: 6, color: '#8b2f2f', fontSize: '.9rem', marginTop: '.75rem' },
  info: { padding: '.8rem 1rem', background: '#fffbf0', border: '1px solid #e8d9a0', borderRadius: 6, fontSize: '.9rem', marginTop: '.75rem' },
  devCode: { display: 'inline-block', marginTop: '.5rem', padding: '.4rem .8rem', background: '#f7f2ea', borderRadius: 4, fontFamily: 'monospace', fontWeight: 700, fontSize: '1.2rem', letterSpacing: '.15em', color: '#241b17' },
  muted: { fontSize: '.85rem', color: '#64564d', marginTop: '1.25rem', textAlign: 'center' as const },
  divider: { display: 'flex', alignItems: 'center', gap: '.75rem', margin: '1.25rem 0', color: '#64564d', fontSize: '.8rem' },
  rule: { flex: 1, height: 1, background: '#e0d5c8' },
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/catalogue';
  const { locale, t } = useLocale();

  const [step, setStep] = useState<'contact' | 'code'>('contact');
  const [contact, setContact] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [devCode, setDevCode] = useState('');
  const [code, setCode] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || t('login.sendFail')); return; }
      setChallengeId(body.challengeId);
      setDevCode(body.developmentCode || '');
      setStep('code');
    } catch {
      setError(t('login.network'));
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, code, mfaCode }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error || t('login.verifyFail')); return; }
      router.push(next);
      router.refresh();
    } catch {
      setError(t('login.network'));
    } finally {
      setLoading(false);
    }
  }

  const brand = locale === 'bn' ? ORGANISATION_BN : ORGANISATION;

  if (step === 'contact') {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={styles.eyebrow} lang={locale === 'bn' ? 'bn' : undefined}>{brand}</p>
          <h1 style={styles.heading}>{t('login.title')}</h1>
          <GoogleSignInButton redirectUrl={next} />
          <p style={{ ...styles.muted, marginTop: '.75rem' }}>
            {t('login.orClerk')} <Link href={`/sign-in?redirect_url=${encodeURIComponent(next)}`}>/sign-in</Link>
          </p>
          <div style={styles.divider}><span style={styles.rule} /><span>{t('login.orOtp')}</span><span style={styles.rule} /></div>
          <form onSubmit={requestCode} noValidate>
            <label htmlFor="contact" style={styles.label}>{t('login.contact')}</label>
            <input id="contact" type="text" autoComplete="username" value={contact} onChange={e => setContact(e.target.value)} placeholder={t('login.contactPlaceholder')} style={styles.input} disabled={loading} />
            {error && <p role="alert" style={styles.error}>{error}</p>}
            <button type="submit" style={{ ...styles.btn, ...(loading || !contact.trim() ? styles.btnDisabled : {}) }} disabled={loading || !contact.trim()}>
              {loading ? t('login.sending') : t('login.send')}
            </button>
          </form>
          <p style={styles.muted}>{t('login.staffHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <p style={styles.eyebrow} lang={locale === 'bn' ? 'bn' : undefined}>{brand}</p>
        <h1 style={styles.heading}>{t('login.enterCode')}</h1>
        {devCode && (
          <div style={styles.info}>
            {t('login.devCode')}
            <span style={styles.devCode}>{devCode}</span>
          </div>
        )}
        <form onSubmit={verifyCode} noValidate>
          <label htmlFor="code" style={styles.label}>{t('login.otp')}</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} style={styles.input} disabled={loading} />
          <label htmlFor="mfa" style={{ ...styles.label, marginTop: '1rem' }}>{t('login.mfa')}</label>
          <input id="mfa" inputMode="numeric" value={mfaCode} onChange={e => setMfaCode(e.target.value)} style={styles.input} disabled={loading} />
          {error && <p role="alert" style={styles.error}>{error}</p>}
          <button type="submit" style={{ ...styles.btn, ...(loading || !code.trim() ? styles.btnDisabled : {}) }} disabled={loading || !code.trim()}>
            {loading ? t('login.checking') : t('login.verify')}
          </button>
        </form>
        <button onClick={() => { setStep('contact'); setError(''); setCode(''); setDevCode(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', ...styles.muted, display: 'block', width: '100%' }}>
          {t('login.different')}
        </button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  const { t } = useLocale();
  return <main className="page-pad"><p className="muted">{t('login.loading')}</p></main>;
}
