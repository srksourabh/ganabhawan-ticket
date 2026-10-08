'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale } from '@/components/LocaleProvider';
import { GATE_DEVICES, gateScanTarget } from '@/lib/gates';

type ScanOutcome = 'ADMITTED' | 'DENIED' | 'UNKNOWN';
type ScanResult = { outcome: ScanOutcome; message: string; ticketRef?: string };
type ShowOption = { id: string; title: string; starts_at: string };

export default function GatePage() {
  const { t } = useLocale();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const busy = useRef(false);
  const [shows, setShows] = useState<ShowOption[]>([]);
  const [showId, setShowId] = useState('');
  const [gateId, setGateId] = useState<string>(GATE_DEVICES[0].id);
  const [token, setToken] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraNote, setCameraNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const router = useRouter();
  /** Who is signed in. The scan API enforces every rule itself; this only routes people to the right door. */
  const [staffNote, setStaffNote] = useState('');

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401) { router.replace('/gate/login'); return; }
        const me = (await res.json().catch(() => ({}))) as { role?: string };
        if (!['scanner', 'supervisor', 'owner'].includes(me.role ?? '')) setStaffNote(t('gate.notGateStaff'));
      })
      .catch(() => undefined);
  }, [router, t]);

  useEffect(() => {
    const saved = localStorage.getItem('gate-device');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setGateId(gateScanTarget(saved).gateId);
  }, []);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const previous = link?.getAttribute('href');
    if (link) link.setAttribute('href', '/gate.webmanifest');
    return () => {
      if (link && previous) link.setAttribute('href', previous);
    };
  }, []);

  useEffect(() => {
    fetch('/api/catalogue')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { shows?: ShowOption[] } | null) => {
        const list = body?.shows || [];
        setShows(list);
        if (list[0]) setShowId(list[0].id);
      })
      .catch(() => undefined);
    return () => stopRef.current?.();
  }, []);

  async function submit(raw: string) {
    const value = raw.trim();
    if (!value || !showId || busy.current) return;
    busy.current = true;
    setLoading(true);
    setResult(null);
    stopRef.current?.();
    setCameraOn(false);
    try {
      const res = await fetch('/api/admission/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketToken: value,
          showId,
          requestId: crypto.randomUUID(),
          ...gateScanTarget(gateId),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        setResult({ outcome: 'DENIED', message: body.error || 'Staff sign-in required for this gate.' });
        return;
      }
      const outcome: ScanOutcome = body.result === 'ADMITTED' || body.result === 'DENIED' ? body.result : 'UNKNOWN';
      setResult({
        outcome: res.ok ? outcome : 'DENIED',
        message: body.reason || body.error || outcome,
        ticketRef: body.receiptId,
      });
    } catch {
      setResult({ outcome: 'UNKNOWN', message: t('gate.network') });
    } finally {
      setLoading(false);
      busy.current = false;
      setToken('');
    }
  }

  async function startCamera() {
    setCameraNote('');
    setResult(null);
    const video = videoRef.current;
    if (!video) return;
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromVideoDevice(undefined, video, (found) => {
        const text = found?.getText();
        if (text) void submit(text);
      });
      stopRef.current = () => controls.stop();
      setCameraOn(true);
    } catch {
      setCameraNote(t('gate.cameraFail'));
      setCameraOn(false);
    }
  }

  function nextGuest() {
    setResult(null);
    void startCamera();
  }

  const outcomeLabel = result?.outcome === 'ADMITTED'
    ? t('gate.admitted')
    : result?.outcome === 'DENIED'
      ? t('gate.denied')
      : t('gate.unknown');

  return (
    <main className="gate">
      <div>
        <p className="eyebrow">{t('gate.title')}</p>
        <h1>{t('gate.title')}</h1>
        <p className="muted">{t('gate.sub')}</p>
        <p className="muted">{t('gate.install')}</p>
        {staffNote && <p role="alert" className="banner banner--err">{staffNote} <Link href="/gate/login">/gate/login</Link></p>}
      </div>

      {result ? (
        <section className={`gate-result gate-result--${result.outcome}`} role="status">
          <span style={{ fontSize: '3.5rem', lineHeight: 1 }} aria-hidden="true">
            {result.outcome === 'ADMITTED' ? '✅' : result.outcome === 'DENIED' ? '🚫' : '⚠️'}
          </span>
          <strong>{outcomeLabel}</strong>
          <p style={{ fontSize: '1.2rem', fontWeight: 600 }}>{result.message}</p>
          {result.ticketRef && (
            <p style={{ fontFamily: 'ui-monospace, monospace', opacity: 0.8, fontSize: '0.9rem' }}>
              {result.ticketRef}
            </p>
          )}
          <button type="button" className="btn btn--primary" style={{ minWidth: 180, marginTop: '1rem' }} onClick={nextGuest}>
            {t('gate.next')}
          </button>
        </section>
      ) : (
        <div className="card stack">
          <label className="field">
            <span>{t('gate.device')}</span>
            <select
              value={gateId}
              onChange={(e) => {
                const next = gateScanTarget(e.target.value).gateId;
                setGateId(next);
                localStorage.setItem('gate-device', next);
              }}
            >
              {GATE_DEVICES.map((gate) => (
                <option key={gate.id} value={gate.id}>{gate.name}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('gate.showId')}</span>
            {shows.length > 0 ? (
              <select value={showId} onChange={(e) => setShowId(e.target.value)}>
                {shows.map((show) => (
                  <option key={show.id} value={show.id}>
                    {show.title} · {new Date(show.starts_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                  </option>
                ))}
              </select>
            ) : (
              <input value={showId} onChange={(e) => setShowId(e.target.value)} autoCapitalize="none" placeholder="Show" />
            )}
          </label>

          <video ref={videoRef} className="gate__video" muted playsInline style={{ display: cameraOn ? 'block' : 'none' }} />

          {!cameraOn && (
            <button type="button" className="btn btn--primary btn--block" onClick={() => { void startCamera(); }}>
              <span aria-hidden="true">📷</span>
              <span>{t('gate.camera')}</span>
            </button>
          )}
          {cameraNote && <p className="banner banner--err" role="alert">{cameraNote}</p>}

          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(token);
            }}
          >
            <label className="field">
              <span>{t('gate.token')}</span>
              <input value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Paste or type token" />
            </label>
            <button type="submit" className="btn btn--ghost btn--block" disabled={loading || !token.trim() || !showId}>
              {loading ? t('gate.scanning') : t('gate.scan')}
            </button>
          </form>
          <div style={{ textAlign: 'center', paddingTop: '0.5rem' }}>
            <Link href="/gate/login" className="muted" style={{ fontSize: '0.88rem' }}>{t('gate.staff')}</Link>
          </div>
        </div>
      )}
    </main>
  );
}
