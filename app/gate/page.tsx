'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/components/LocaleProvider';

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
  const [token, setToken] = useState('');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraNote, setCameraNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

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
          gateId: 'main',
          deviceId: 'gate-one',
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
      </div>

      {result ? (
        <section className={`gate-result gate-result--${result.outcome}`} role="status">
          <strong>{outcomeLabel}</strong>
          <p>{result.message}</p>
          {result.ticketRef && <p>{result.ticketRef}</p>}
          <button type="button" className="btn btn--primary" onClick={nextGuest}>{t('gate.next')}</button>
        </section>
      ) : (
        <>
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
              {t('gate.camera')}
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
              <input value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>
            <button type="submit" className="btn btn--ghost btn--block" disabled={loading || !token.trim() || !showId}>
              {loading ? t('gate.scanning') : t('gate.scan')}
            </button>
          </form>
          <Link href="/admin/login" className="muted">{t('gate.staff')}</Link>
        </>
      )}
    </main>
  );
}
