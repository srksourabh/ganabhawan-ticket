'use client';

import { useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';

type ScanOutcome = 'ADMITTED' | 'DENIED' | 'UNKNOWN';
type ScanResult = {
  outcome: ScanOutcome;
  message: string;
  ticketRef?: string;
  showTitle?: string;
  holderName?: string;
};

const OUTCOME_STYLES: Record<ScanOutcome, { bg: string; color: string; border: string; icon: string }> = {
  ADMITTED: { bg: '#f0fff4', color: '#1a5c2f', border: '2px solid #2a6b3b', icon: '✓' },
  DENIED:   { bg: '#fff0f0', color: '#8b2f2f', border: '2px solid #c0392b', icon: '✗' },
  UNKNOWN:  { bg: '#fffbf0', color: '#7a5c00', border: '2px solid #c9a227', icon: '?' },
};

const s = {
  page: { minHeight: '100vh', background: '#241b17', color: '#fffaf2', padding: '2rem 1.25rem', display: 'flex', flexDirection: 'column' as const, alignItems: 'center' },
  heading: { fontFamily: 'Georgia, serif', fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', color: '#e7b86a', margin: '0 0 .4rem', textAlign: 'center' as const },
  sub: { color: '#b9a99a', fontSize: '.9rem', marginBottom: '2rem', textAlign: 'center' as const },
  card: { background: '#2f2218', borderRadius: 12, padding: '1.75rem', width: '100%', maxWidth: 480, boxShadow: '0 8px 32px #00000040' },
  label: { display: 'block', fontSize: '.85rem', color: '#b9a99a', marginBottom: '.35rem', textTransform: 'uppercase' as const, letterSpacing: '.1em' },
  input: { width: '100%', padding: '.8rem 1rem', border: '1px solid #4a3728', borderRadius: 6, fontSize: '1rem', background: '#1c120c', color: '#fffaf2', outline: 'none', marginBottom: '1rem' },
  btn: { width: '100%', padding: '.9rem', background: '#8b2f2f', color: 'white', border: 0, borderRadius: 6, fontSize: '1rem', fontWeight: 700, cursor: 'pointer', letterSpacing: '.04em' },
  btnDisabled: { opacity: .45, cursor: 'not-allowed' as const },
  result: (o: ScanOutcome) => ({ ...OUTCOME_STYLES[o], borderRadius: 12, padding: '2rem', textAlign: 'center' as const, width: '100%', maxWidth: 480, marginTop: '1.5rem' }),
  icon: (o: ScanOutcome) => ({ fontSize: '4rem', lineHeight: 1, color: OUTCOME_STYLES[o].color }),
  outcomeText: (o: ScanOutcome) => ({ fontSize: '2rem', fontWeight: 800, color: OUTCOME_STYLES[o].color, margin: '.5rem 0' }),
};

export default function GatePage() {
  const { t } = useLocale();
  const [token, setToken] = useState('');
  const [showId, setShowId] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [networkError, setNetworkError] = useState(false);

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim() || !showId.trim()) return;
    setLoading(true);
    setResult(null);
    setNetworkError(false);

    const requestId = crypto.randomUUID();

    try {
      const res = await fetch('/api/admission/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketToken: token.trim(),
          showId: showId.trim(),
          requestId,
          gateId: 'main',
          deviceId: 'gate-one',
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setResult({ outcome: 'DENIED', message: body.error || `Server returned ${res.status}` });
        return;
      }

      const body = await res.json();
      const outcome: ScanOutcome = ['ADMITTED', 'DENIED', 'UNKNOWN'].includes(body.result) ? body.result : 'UNKNOWN';
      setResult({
        outcome,
        message: body.reason || outcome,
        ticketRef: body.receiptId,
      });
    } catch {
      setNetworkError(true);
      setResult({ outcome: 'UNKNOWN', message: t('gate.network') });
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setToken('');
    setResult(null);
    setNetworkError(false);
  }

  const outcomeLabel =
    result?.outcome === 'ADMITTED' ? t('gate.admitted')
      : result?.outcome === 'DENIED' ? t('gate.denied')
        : t('gate.unknown');

  return (
    <div style={s.page}>
      <h1 style={s.heading}>{t('gate.title')}</h1>
      <p style={s.sub}>{t('gate.sub')}</p>

      <div style={s.card}>
        <form onSubmit={handleScan} noValidate>
          <label htmlFor="showId" style={s.label}>{t('gate.showId')}</label>
          <input
            id="showId"
            type="text"
            value={showId}
            onChange={e => setShowId(e.target.value)}
            placeholder="UUID"
            style={s.input}
            disabled={loading}
            autoCapitalize="none"
          />

          <label htmlFor="token" style={s.label}>{t('gate.token')}</label>
          <input
            id="token"
            type="text"
            value={token}
            onChange={e => setToken(e.target.value)}
            style={{ ...s.input, fontFamily: 'monospace', marginBottom: '1.25rem' }}
            disabled={loading}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />

          <button
            type="submit"
            style={{ ...s.btn, ...(loading || !token.trim() || !showId.trim() ? s.btnDisabled : {}) }}
            disabled={loading || !token.trim() || !showId.trim()}
          >
            {loading ? t('gate.scanning') : t('gate.scan')}
          </button>
        </form>
      </div>

      {result && (
        <div style={s.result(result.outcome)}>
          <div style={s.icon(result.outcome)}>{OUTCOME_STYLES[result.outcome].icon}</div>
          <div style={s.outcomeText(result.outcome)}>{outcomeLabel}</div>
          <p style={{ margin: '.5rem 0 0', fontWeight: 600 }}>{result.message}</p>
          {result.ticketRef && <p style={{ margin: '.25rem 0 0', fontFamily: 'monospace', fontSize: '.9rem' }}>{result.ticketRef}</p>}
          {result.holderName && <p style={{ margin: '.25rem 0 0', fontSize: '.9rem' }}>{result.holderName}</p>}
          {result.showTitle && <p style={{ margin: '.25rem 0 0', fontSize: '.9rem' }}>{result.showTitle}</p>}
          {networkError && (
            <p style={{ marginTop: '.75rem', fontWeight: 700, fontSize: '.85rem', color: '#7a5c00' }}>
              {t('gate.network')}
            </p>
          )}
          <button onClick={reset} style={{ marginTop: '1.25rem', padding: '.6rem 1.5rem', background: 'transparent', border: '2px solid currentColor', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: '.95rem', color: 'inherit' }}>
            {t('gate.scan')}
          </button>
        </div>
      )}
    </div>
  );
}
