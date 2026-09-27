import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import { api, mediaUrl, type Catalogue, type Product, type Show, type User } from './src/api';

const TOKEN_KEY = 'samatat-session';
const ZONES = ['Balcony', 'Superior', 'Premier'] as const;

type Tab = 'plays' | 'hall' | 'tickets' | 'door';

const rupee = (paise: number) => `Rs ${(paise / 100).toLocaleString('en-IN')}`;

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('plays');
  const [show, setShow] = useState<Show | null>(null);

  useEffect(() => {
    SecureStore.getItemAsync(TOKEN_KEY)
      .then(async (saved) => {
        if (!saved) return;
        const me = await api<User>('/api/auth/me', saved);
        setToken(saved);
        setUser(me);
      })
      .catch(() => SecureStore.deleteItemAsync(TOKEN_KEY))
      .finally(() => setReady(true));
  }, []);

  async function signIn(next: string, nextUser: User) {
    await SecureStore.setItemAsync(TOKEN_KEY, next);
    setToken(next);
    setUser(nextUser);
  }

  async function signOut() {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setShow(null);
    setTab('plays');
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#722f37" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.brand}>Samatat Natyomela</Text>
        <Text style={styles.venue}>Ganabhawan</Text>
      </View>
      {!token || !user ? (
        <SignIn onSuccess={signIn} />
      ) : (
        <>
          <View style={styles.tabs}>
            <TabButton label="Plays" on={tab === 'plays' || tab === 'hall'} onPress={() => setTab('plays')} />
            <TabButton label="Tickets" on={tab === 'tickets'} onPress={() => setTab('tickets')} />
            {user.role !== 'customer' && <TabButton label="Door" on={tab === 'door'} onPress={() => setTab('door')} />}
            <TabButton label="Out" on={false} onPress={signOut} />
          </View>
          {tab === 'plays' && (
            <Plays
              onOpen={(item) => {
                setShow(item);
                setTab('hall');
              }}
            />
          )}
          {tab === 'hall' && show && <Hall show={show} token={token} onBack={() => setTab('plays')} />}
          {tab === 'tickets' && <Tickets token={token} />}
          {tab === 'door' && <Door token={token} />}
        </>
      )}
    </View>
  );
}

function SignIn({ onSuccess }: { onSuccess: (token: string, user: User) => Promise<void> }) {
  const [contact, setContact] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    setMessage('');
    try {
      const body = await api<{ challengeId: string; message: string }>('/api/auth/otp/request', null, {
        method: 'POST',
        body: JSON.stringify({ contact }),
      });
      setChallengeId(body.challengeId);
      setMessage(body.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setMessage('');
    try {
      const body = await api<{ sessionToken: string; user: User }>('/api/auth/otp/verify', null, {
        method: 'POST',
        body: JSON.stringify({ challengeId, code }),
      });
      await onSuccess(body.sessionToken, body.user);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.pad}>
      <Text style={styles.h1}>Sign in</Text>
      <Text style={styles.muted}>Use the same mobile number or email as the website. One account, one database.</Text>
      <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address" placeholder="Mobile or email" value={contact} onChangeText={setContact} />
      {!challengeId ? (
        <Pressable style={styles.primary} disabled={busy || contact.trim().length < 3} onPress={requestCode}>
          <Text style={styles.primaryText}>{busy ? 'Sending…' : 'Send code'}</Text>
        </Pressable>
      ) : (
        <>
          <TextInput style={styles.input} keyboardType="number-pad" placeholder="6-digit code" value={code} onChangeText={setCode} />
          <Pressable style={styles.primary} disabled={busy || code.trim().length < 4} onPress={verify}>
            <Text style={styles.primaryText}>{busy ? 'Checking…' : 'Sign in'}</Text>
          </Pressable>
        </>
      )}
      {!!message && <Text style={styles.note}>{message}</Text>}
    </View>
  );
}

function Plays({ onOpen }: { onOpen: (show: Show) => void }) {
  const [data, setData] = useState<Catalogue | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Catalogue>('/api/catalogue', null)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <Text style={styles.note}>{error}</Text>;
  if (!data) return <ActivityIndicator color="#722f37" style={{ marginTop: 24 }} />;

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Text style={styles.h1}>Choose a play</Text>
      {data.shows.map((show) => {
        const art = show.artwork && (show.artwork.startsWith('/') || show.artwork.startsWith('http')) ? mediaUrl(show.artwork) : '';
        return (
          <Pressable key={show.id} style={styles.play} onPress={() => onOpen(show)}>
            {art ? <Image source={{ uri: art }} style={styles.poster} /> : <View style={[styles.poster, styles.posterEmpty]} />}
            <View style={{ flex: 1 }}>
              <Text style={styles.playTitle}>{show.title}</Text>
              <Text style={styles.muted}>{new Date(show.starts_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</Text>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Hall({ show, token, onBack }: { show: Show; token: string; onBack: () => void }) {
  const [data, setData] = useState<Catalogue | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Catalogue>('/api/catalogue', null).then(setData).catch((err: Error) => setMessage(err.message));
  }, []);

  const products = data?.products.filter((product) => product.kind === 'DAILY' && product.coverage.some((item) => item.id === show.id)) ?? [];

  async function add(product: Product) {
    setBusy(true);
    setMessage('');
    try {
      await api('/api/holds', token, {
        method: 'POST',
        headers: { 'Idempotency-Key': `${Date.now()}-${product.id}` },
        body: JSON.stringify({ productId: product.id, quantity: 1, version: product.version }),
      });
      setMessage(`${product.category} is held. Finish payment on My tickets, on this phone or the website.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not hold the seat.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Pressable onPress={onBack}><Text style={styles.link}>Back to plays</Text></Pressable>
      <Text style={styles.h1}>{show.title}</Text>
      <Text style={styles.muted}>Three sections. The stage is marked at the front.</Text>
      <View style={styles.hall}>
        {ZONES.map((category) => {
          const product = products.find((item) => item.category === category);
          return (
            <View key={category} style={styles.zone}>
              <Text style={styles.zoneName}>{category}</Text>
              <Text style={styles.muted}>{product ? `${rupee(product.price)} · ${product.available} left` : 'Unavailable'}</Text>
              <Pressable style={styles.primary} disabled={!product || product.available <= 0 || busy} onPress={() => product && add(product)}>
                <Text style={styles.primaryText}>{product && product.available > 0 ? 'Add ticket' : 'Sold out'}</Text>
              </Pressable>
            </View>
          );
        })}
        <View style={styles.stage}><Text style={styles.stageText}>This is the stage</Text></View>
      </View>
      {!!message && <Text style={styles.note}>{message}</Text>}
    </ScrollView>
  );
}

function Tickets({ token }: { token: string }) {
  const [rows, setRows] = useState<{ id: string; reference: string; status: string; tickets: { id: string; reference: string }[] }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<typeof rows>('/api/bookings', token).then(setRows).catch((err: Error) => setError(err.message));
  }, [token]);

  if (error) return <Text style={styles.note}>{error}</Text>;
  return (
    <ScrollView contentContainerStyle={styles.pad}>
      <Text style={styles.h1}>Your tickets</Text>
      <Text style={styles.muted}>Show the code at the door. Staff scan it once.</Text>
      {rows.map((booking) => (
        <View key={booking.id} style={styles.card}>
          <Text style={styles.playTitle}>{booking.reference}</Text>
          <Text style={styles.muted}>{booking.status}</Text>
          {booking.status === 'CONFIRMED' && (Array.isArray(booking.tickets) ? booking.tickets : []).map((ticket) => (
            <TicketCode key={ticket.id} id={ticket.id} token={token} />
          ))}
        </View>
      ))}
      {rows.length === 0 && <Text style={styles.muted}>No bookings yet.</Text>}
    </ScrollView>
  );
}

function TicketCode({ id, token }: { id: string; token: string }) {
  const [uri, setUri] = useState('');
  useEffect(() => {
    api<{ qr: string }>(`/api/tickets/${id}/pass`, token)
      .then((body) => setUri(body.qr))
      .catch(() => setUri(''));
  }, [id, token]);
  if (!uri) return null;
  return <Image source={{ uri }} style={styles.qr} />;
}

function Door({ token }: { token: string }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [shows, setShows] = useState<Show[]>([]);
  const [showId, setShowId] = useState('');
  const [locked, setLocked] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api<Catalogue>('/api/catalogue', null).then((body) => {
      setShows(body.shows);
      if (body.shows[0]) setShowId(body.shows[0].id);
    }).catch(() => undefined);
  }, []);

  async function onScan(value: string) {
    if (locked || !showId) return;
    setLocked(true);
    try {
      const body = await api<{ result?: string; reason?: string; error?: string }>('/api/admission/scan', token, {
        method: 'POST',
        body: JSON.stringify({
          ticketToken: value,
          showId,
          requestId: `${Date.now()}`,
          gateId: 'main',
          deviceId: 'gate-one',
        }),
      });
      const admitted = body.result === 'ADMITTED';
      setResult({ ok: admitted, text: admitted ? 'ADMITTED' : (body.reason || body.result || 'DENIED') });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : 'DENIED' });
    }
  }

  if (!permission?.granted) {
    return (
      <View style={styles.pad}>
        <Text style={styles.h1}>Door check</Text>
        <Pressable style={styles.primary} onPress={requestPermission}><Text style={styles.primaryText}>Allow camera</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {result ? (
        <View style={[styles.result, result.ok ? styles.admit : styles.deny]}>
          <Text style={styles.resultText}>{result.text}</Text>
          <Pressable style={styles.primary} onPress={() => { setResult(null); setLocked(false); }}>
            <Text style={styles.primaryText}>Next guest</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <ScrollView horizontal contentContainerStyle={styles.showRow}>
            {shows.map((item) => (
              <Pressable key={item.id} style={[styles.chip, showId === item.id && styles.chipOn]} onPress={() => setShowId(item.id)}>
                <Text style={showId === item.id ? styles.chipTextOn : styles.chipText}>{item.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={locked ? undefined : ({ data }) => { void onScan(data); }}
          />
        </>
      )}
    </View>
  );
}

function TabButton({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, on && styles.tabOn]}>
      <Text style={on ? styles.tabTextOn : styles.tabText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f4ef', paddingTop: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f7f4ef' },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  brand: { fontSize: 22, color: '#1c1714', fontWeight: '700' },
  venue: { color: '#8a6a12', fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' },
  pad: { padding: 16, gap: 10 },
  h1: { fontSize: 26, color: '#1c1714', fontWeight: '700' },
  muted: { color: '#5e564c', fontSize: 14 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e4ddd2', borderRadius: 10, padding: 12, fontSize: 16 },
  primary: { backgroundColor: '#722f37', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700' },
  note: { color: '#1c1714', marginTop: 8 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  tab: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 },
  tabOn: { backgroundColor: '#722f37' },
  tabText: { color: '#1c1714' },
  tabTextOn: { color: '#fff', fontWeight: '700' },
  play: { flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: 12, padding: 8, marginBottom: 10 },
  poster: { width: 72, height: 96, borderRadius: 8, backgroundColor: '#eee' },
  posterEmpty: { backgroundColor: '#e7d7c3' },
  playTitle: { fontSize: 16, fontWeight: '700', color: '#1c1714' },
  link: { color: '#722f37', fontWeight: '700' },
  hall: { backgroundColor: '#fff', borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#e4ddd2' },
  zone: { padding: 12, gap: 6, borderBottomWidth: 1, borderBottomColor: '#f0ebe3' },
  zoneName: { fontSize: 18, fontWeight: '700', color: '#1c1714' },
  stage: { backgroundColor: '#1c1714', padding: 14, alignItems: 'center' },
  stageText: { color: '#f7e7c6', fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, marginBottom: 10 },
  qr: { width: 220, height: 220, alignSelf: 'center', marginTop: 8, backgroundColor: '#fff' },
  showRow: { padding: 8, gap: 8 },
  chip: { borderWidth: 1, borderColor: '#e4ddd2', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  chipOn: { backgroundColor: '#722f37', borderColor: '#722f37' },
  chipText: { color: '#1c1714' },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  result: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, margin: 16, borderRadius: 16 },
  admit: { backgroundColor: '#e7f6ec' },
  deny: { backgroundColor: '#fdecee' },
  resultText: { fontSize: 36, fontWeight: '800', textAlign: 'center' },
});
