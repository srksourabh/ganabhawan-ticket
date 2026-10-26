import { query } from './db';

export interface SheetRow {
  bookedAt: string;
  name: string;
  email: string;
  phone: string;
  category: string;
  kind: 'Season' | 'Daily';
  show: string;
  quantity: number;
  amount: number;
  order: string;
  reference: string;
  venue: string;
}

export interface SheetSummary {
  bookings: number;
  people: number;
  tickets: number;
  byKind: { Season: number; Daily: number };
  byCategory: Record<string, number>;
}

/** Counts for the counter printout: people, tickets, and how many of each kind and zone. */
export function summariseSheet(rows: SheetRow[]): SheetSummary {
  const people = new Set(rows.map((row) => row.email.toLowerCase()).filter(Boolean));
  const byKind = { Season: 0, Daily: 0 };
  const byCategory: Record<string, number> = {};
  let tickets = 0;
  for (const row of rows) {
    tickets += row.quantity;
    byKind[row.kind] += row.quantity;
    byCategory[row.category] = (byCategory[row.category] ?? 0) + row.quantity;
  }
  return { bookings: rows.length, people: people.size, tickets, byKind, byCategory };
}

type Raw = {
  created_at: string;
  reference: string;
  quantity: number;
  total: number;
  holder_name: string | null;
  holder_email: string | null;
  holder_phone: string | null;
  user_name: string;
  contact: string;
  verified_mobile: string | null;
  category: string;
  kind: string;
  order_ref: string | null;
  venue: string | null;
  snapshot: { coverage?: { title?: string; startsAt?: string }[] } | null;
};

/** Confirmed bookings for the internal sheet. One row per booking, newest last so a printout reads in order. */
export async function bookingSheet(): Promise<{ rows: SheetRow[]; summary: SheetSummary }> {
  const raw = await query<Raw>(
    `SELECT b.created_at, b.reference, b.quantity, b.total, b.holder_name, b.holder_email, b.holder_phone, b.snapshot,
            u.name AS user_name, u.contact, u.verified_mobile, p.category, p.kind, co.reference AS order_ref, f.venue
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN products p ON p.id = b.product_id
     JOIN festivals f ON f.id = p.festival_id
     LEFT JOIN checkouts co ON co.id = b.checkout_id
     WHERE b.status = 'CONFIRMED'
     ORDER BY b.created_at, b.reference`,
  );
  const rows: SheetRow[] = raw.map((row) => {
    const email = row.holder_email || (row.contact.includes('@') ? row.contact : '');
    const phone = row.holder_phone || row.verified_mobile || (row.contact.includes('@') ? '' : row.contact);
    const shows = (row.snapshot?.coverage ?? []).map((item) => item.title).filter(Boolean);
    return {
      bookedAt: new Date(row.created_at).toISOString(),
      name: row.holder_name || row.user_name || '',
      email,
      phone,
      category: row.category,
      kind: row.kind === 'SEASON' ? 'Season' : 'Daily',
      show: shows.join('; '),
      quantity: Number(row.quantity),
      amount: Number(row.total),
      order: row.order_ref ?? '',
      reference: row.reference,
      venue: row.venue ?? '',
    };
  });
  return { rows, summary: summariseSheet(rows) };
}

const CSV_COLUMNS: (keyof SheetRow)[] = ['bookedAt', 'name', 'email', 'phone', 'category', 'kind', 'show', 'quantity', 'amount', 'order', 'reference', 'venue'];

function csvCell(value: string | number) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function bookingSheetCsv(rows: SheetRow[]) {
  const header = ['Booked at (UTC)', 'Name', 'Email', 'Mobile', 'Category', 'Season or daily', 'Show', 'Quantity', 'Amount (paise)', 'Order', 'Booking', 'Theatre'];
  const lines = [header.join(','), ...rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(','))];
  return lines.join('\n');
}

export interface PhysicalTicketRow {
  ticket: string;
  name: string;
  email: string;
  phone: string;
  category: string;
  kind: 'Season' | 'Daily';
  show: string;
  handover: string;
  booking: string;
  venue: string;
}

type Coverage = { title?: string; startsAt?: string };

/** When the counter hands over the physical card. Season: every performance, on the first day. */
export function handoverNote(kind: string): string {
  return kind === 'SEASON' || kind === 'Season'
    ? 'All season tickets together on the first day, before the first show'
    : 'Before this performance';
}

function firstShow(coverage: Coverage[]): string {
  const dated = coverage.filter((item) => item.title);
  dated.sort((a, b) => String(a.startsAt ?? '').localeCompare(String(b.startsAt ?? '')));
  return dated.map((item) => item.title).filter(Boolean).join('; ');
}

type TicketRaw = Raw & { ticket: string; ticket_status: string };

/** One row per sold ticket, for printing physical cards. Name, email and phone are the purchaser. */
export async function physicalTickets(): Promise<PhysicalTicketRow[]> {
  const raw = await query<TicketRaw>(
    `SELECT t.reference AS ticket, t.status AS ticket_status,
            b.created_at, b.reference, b.quantity, b.total, b.holder_name, b.holder_email, b.holder_phone, b.snapshot,
            u.name AS user_name, u.contact, u.verified_mobile, p.category, p.kind, co.reference AS order_ref, f.venue
     FROM tickets t
     JOIN bookings b ON b.id = t.booking_id
     JOIN users u ON u.id = b.user_id
     JOIN products p ON p.id = b.product_id
     JOIN festivals f ON f.id = p.festival_id
     LEFT JOIN checkouts co ON co.id = b.checkout_id
     WHERE b.status = 'CONFIRMED' AND t.status = 'ACTIVE'
     ORDER BY b.created_at, b.reference, t.ordinal`,
  );
  return raw.map((row) => {
    const email = row.holder_email || (row.contact.includes('@') ? row.contact : '');
    const phone = row.holder_phone || row.verified_mobile || (row.contact.includes('@') ? '' : row.contact);
    const kind = row.kind === 'SEASON' ? 'Season' : 'Daily';
    return {
      ticket: row.ticket,
      name: row.holder_name || row.user_name || '',
      email,
      phone,
      category: row.category,
      kind,
      show: firstShow(row.snapshot?.coverage ?? []),
      handover: handoverNote(kind),
      booking: row.reference,
      venue: row.venue ?? '',
    };
  });
}

/** One purchaser's tickets, one ticket, or the whole list. */
export function selectPhysicalTickets(rows: PhysicalTicketRow[], filter: { booking?: string | null; ticket?: string | null }) {
  return rows.filter((row) => {
    if (filter.booking && row.booking !== filter.booking) return false;
    if (filter.ticket && row.ticket !== filter.ticket) return false;
    return true;
  });
}

const TICKET_COLUMNS: (keyof PhysicalTicketRow)[] = ['ticket', 'name', 'email', 'phone', 'category', 'kind', 'show', 'handover', 'booking', 'venue'];

export function physicalTicketCsv(rows: PhysicalTicketRow[]) {
  const header = ['Ticket', 'Name', 'Email', 'Phone', 'Zone', 'Season or daily', 'Show', 'When to hand over', 'Booking', 'Theatre'];
  const lines = [header.join(','), ...rows.map((row) => TICKET_COLUMNS.map((key) => csvCell(row[key])).join(','))];
  return lines.join('\n');
}
