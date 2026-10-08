import { query } from './db';
import { AppError } from './errors';

/**
 * Operational metrics for the admin dashboard. Every figure comes from database
 * rows written by the server (bookings, payments, refunds, scan_requests,
 * admissions); nothing is taken from a client. Amounts are in paise.
 */
export interface MetricsFilter {
  showId?: string;
  zone?: string;
  from?: string;
  to?: string;
  scannerId?: string;
  paymentStatus?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_STATES = ['CAPTURED', 'AUTHORIZED', 'FAILED'];

function parseFilter(input: Record<string, string | undefined>): MetricsFilter {
  const f: MetricsFilter = {};
  if (input.showId) { if (!UUID.test(input.showId)) throw new AppError(400, 'Invalid show.'); f.showId = input.showId; }
  if (input.scannerId) { if (!UUID.test(input.scannerId)) throw new AppError(400, 'Invalid scanner.'); f.scannerId = input.scannerId; }
  if (input.zone) { if (!['Premier', 'Superior', 'Balcony'].includes(input.zone)) throw new AppError(400, 'Invalid zone.'); f.zone = input.zone; }
  for (const key of ['from', 'to'] as const) {
    if (input[key]) { if (Number.isNaN(new Date(input[key]!).getTime())) throw new AppError(400, `Invalid ${key} date.`); f[key] = new Date(input[key]!).toISOString(); }
  }
  if (input.paymentStatus) { if (!PAYMENT_STATES.includes(input.paymentStatus)) throw new AppError(400, 'Invalid payment status.'); f.paymentStatus = input.paymentStatus; }
  return f;
}

/** Builds "AND …" clauses with numbered parameters. */
class Where {
  values: unknown[] = [];
  private parts: string[] = [];
  add(sql: (n: string) => string, value: unknown) { this.values.push(value); this.parts.push(sql('$' + this.values.length)); return this; }
  /** Embeds another clause set (its $1… renumbered after ours) inside `wrap`. */
  nest(inner: Where, wrap: (innerSql: string) => string) {
    const offset = this.values.length;
    this.values.push(...inner.values);
    this.parts.push(wrap(inner.sql.replace(/\$(\d+)/g, (_, d) => '$' + (Number(d) + offset))));
    return this;
  }
  get sql() { return this.parts.length ? ' AND ' + this.parts.join(' AND ') : ''; }
}

function bookingWhere(f: MetricsFilter) {
  const w = new Where();
  if (f.showId) w.add((n) => `EXISTS (SELECT 1 FROM product_coverage pc WHERE pc.product_id=b.product_id AND pc.show_id=${n})`, f.showId);
  if (f.zone) w.add((n) => `p.category=${n}`, f.zone);
  if (f.from) w.add((n) => `b.created_at>=${n}`, f.from);
  if (f.to) w.add((n) => `b.created_at<${n}`, f.to);
  return w;
}

function scanWhere(f: MetricsFilter) {
  const w = new Where();
  if (f.showId) w.add((n) => `sr.show_id=${n}`, f.showId);
  if (f.scannerId) w.add((n) => `sr.actor_id=${n}`, f.scannerId);
  if (f.zone) w.add((n) => `EXISTS (SELECT 1 FROM tickets t JOIN bookings b ON b.id=t.booking_id JOIN products p ON p.id=b.product_id WHERE t.id=sr.ticket_id AND p.category=${n})`, f.zone);
  if (f.from) w.add((n) => `sr.created_at>=${n}`, f.from);
  if (f.to) w.add((n) => `sr.created_at<${n}`, f.to);
  return w;
}

function paymentWhere(f: MetricsFilter) {
  const w = new Where();
  if (f.paymentStatus) w.add((n) => `pay.state=${n}`, f.paymentStatus);
  if (f.from) w.add((n) => `pay.created_at>=${n}`, f.from);
  if (f.to) w.add((n) => `pay.created_at<${n}`, f.to);
  if (f.showId || f.zone) {
    // A payment belongs to one booking or to a checkout of bookings.
    w.nest(bookingWhere({ showId: f.showId, zone: f.zone }), (sql) => `EXISTS (SELECT 1 FROM bookings b JOIN products p ON p.id=b.product_id
      WHERE (b.id=pay.booking_id OR (pay.checkout_id IS NOT NULL AND b.checkout_id=pay.checkout_id))${sql})`);
  }
  return w;
}

const n = (value: unknown) => Number(value ?? 0);

export async function adminMetrics(input: Record<string, string | undefined>) {
  const f = parseFilter(input);
  const bw = bookingWhere(f);
  const bookingFrom = `FROM bookings b JOIN products p ON p.id=b.product_id WHERE true${bw.sql}`;

  const [sales] = await query(`SELECT count(*)::int bookings,
      count(*) FILTER (WHERE b.status='CONFIRMED')::int paid_bookings,
      count(*) FILTER (WHERE b.status IN ('EXPIRED','CANCELLED') AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.booking_id=b.id OR (b.checkout_id IS NOT NULL AND x.checkout_id=b.checkout_id)))::int unpaid_closed_bookings,
      count(*) FILTER (WHERE b.status IN ('REFUND_REQUIRED','REFUNDED'))::int refund_bookings,
      COALESCE(sum(b.quantity) FILTER (WHERE b.status='CONFIRMED'),0)::int tickets_sold,
      COALESCE(sum(b.total) FILTER (WHERE b.status='CONFIRMED'),0)::bigint confirmed_revenue
    ${bookingFrom}`, bw.values);
  const byKind = await query(`SELECT p.kind, COALESCE(sum(b.quantity),0)::int tickets, COALESCE(sum(b.total),0)::bigint revenue
    ${bookingFrom} AND b.status='CONFIRMED' GROUP BY p.kind ORDER BY p.kind`, bw.values);
  const byZone = await query(`SELECT p.category zone, COALESCE(sum(b.quantity),0)::int tickets, COALESCE(sum(b.total),0)::bigint revenue
    ${bookingFrom} AND b.status='CONFIRMED' GROUP BY p.category ORDER BY p.category`, bw.values);
  // Tickets per show: one entitlement per ticket per covered show (season tickets count in every show).
  const byShow = await query(`SELECT s.id show_id, s.title, s.starts_at, count(e.ticket_id)::int tickets
    FROM entitlements e JOIN shows s ON s.id=e.show_id JOIN tickets t ON t.id=e.ticket_id JOIN bookings b ON b.id=t.booking_id JOIN products p ON p.id=b.product_id
    WHERE e.status='ACTIVE' AND b.status='CONFIRMED'${bw.sql} GROUP BY s.id ORDER BY s.starts_at`, bw.values);

  const sw = scanWhere(f);
  const scanFrom = `FROM scan_requests sr WHERE sr.outcome IS NOT NULL${sw.sql}`;
  const [scans] = await query(`SELECT count(*)::int total,
      count(*) FILTER (WHERE sr.outcome='ADMITTED')::int admitted,
      count(*) FILTER (WHERE sr.outcome<>'ADMITTED')::int rejected,
      count(*) FILTER (WHERE sr.code='DUPLICATE')::int duplicates,
      min(sr.created_at) first_scan, max(sr.created_at) last_scan
    ${scanFrom}`, sw.values);
  const scansByShow = await query(`SELECT sr.show_id, s.title, count(*)::int total, count(*) FILTER (WHERE sr.outcome='ADMITTED')::int admitted
    ${scanFrom.replace('FROM scan_requests sr', 'FROM scan_requests sr LEFT JOIN shows s ON s.id=sr.show_id')} GROUP BY sr.show_id, s.title, s.starts_at ORDER BY s.starts_at NULLS LAST`, sw.values);
  const scansByGate = await query(`SELECT COALESCE(sr.gate,'unknown') gate, count(*)::int total, count(*) FILTER (WHERE sr.outcome='ADMITTED')::int admitted
    ${scanFrom} GROUP BY 1 ORDER BY 1`, sw.values);
  const scansByScanner = await query(`SELECT sr.actor_id, u.name, u.contact, count(*)::int total, count(*) FILTER (WHERE sr.outcome='ADMITTED')::int admitted
    ${scanFrom.replace('FROM scan_requests sr', 'FROM scan_requests sr JOIN users u ON u.id=sr.actor_id')} GROUP BY sr.actor_id, u.name, u.contact ORDER BY total DESC`, sw.values);
  const scansByCode = await query(`SELECT sr.code, count(*)::int total ${scanFrom} GROUP BY sr.code ORDER BY total DESC`, sw.values);

  const pw = paymentWhere(f);
  const payments = await query(`SELECT pay.state, count(*)::int count, COALESCE(sum(pay.amount),0)::bigint amount
    FROM payments pay WHERE true${pw.sql} GROUP BY pay.state ORDER BY pay.state`, pw.values);
  const [pending] = await query(`SELECT
      (SELECT count(*) FROM bookings WHERE status='PAYMENT_PENDING' AND expires_at>now())::int awaiting_payment,
      (SELECT count(*) FROM payment_attempts WHERE state='READY' AND next_reconcile_at IS NOT NULL)::int under_reconciliation,
      (SELECT count(*) FROM reconciliation_cases WHERE state='OPEN')::int open_cases`);
  const refunds = await query(`SELECT r.state, count(*)::int count, COALESCE(sum(r.amount),0)::bigint amount
    FROM refunds r WHERE true${f.from ? ` AND r.created_at>=$1` : ''}${f.to ? ` AND r.created_at<$${f.from ? 2 : 1}` : ''} GROUP BY r.state ORDER BY r.state`,
    [f.from, f.to].filter(Boolean));

  return {
    filter: f,
    sales: {
      bookings: n(sales?.bookings), paidBookings: n(sales?.paid_bookings), unpaidClosedBookings: n(sales?.unpaid_closed_bookings),
      refundBookings: n(sales?.refund_bookings), ticketsSold: n(sales?.tickets_sold), confirmedRevenue: n(sales?.confirmed_revenue),
      byKind: byKind.map((r) => ({ kind: r.kind, tickets: n(r.tickets), revenue: n(r.revenue) })),
      byZone: byZone.map((r) => ({ zone: r.zone, tickets: n(r.tickets), revenue: n(r.revenue) })),
      byShow: byShow.map((r) => ({ showId: r.show_id, title: r.title, startsAt: r.starts_at, tickets: n(r.tickets) })),
    },
    admission: {
      total: n(scans?.total), admitted: n(scans?.admitted), rejected: n(scans?.rejected), duplicates: n(scans?.duplicates),
      firstScan: scans?.first_scan ?? null, lastScan: scans?.last_scan ?? null,
      byShow: scansByShow.map((r) => ({ showId: r.show_id, title: r.title, total: n(r.total), admitted: n(r.admitted) })),
      byGate: scansByGate.map((r) => ({ gate: r.gate, total: n(r.total), admitted: n(r.admitted) })),
      byScanner: scansByScanner.map((r) => ({ scannerId: r.actor_id, name: r.name, contact: r.contact, total: n(r.total), admitted: n(r.admitted) })),
      byCode: scansByCode.map((r) => ({ code: r.code, total: n(r.total) })),
    },
    payments: {
      byState: payments.map((r) => ({ state: r.state, count: n(r.count), amount: n(r.amount) })),
      awaitingPayment: n(pending?.awaiting_payment), underReconciliation: n(pending?.under_reconciliation), openCases: n(pending?.open_cases),
      refunds: refunds.map((r) => ({ state: r.state, count: n(r.count), amount: n(r.amount) })),
    },
  };
}
