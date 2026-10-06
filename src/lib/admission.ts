import { transaction } from './db';
import { requireValue } from './errors';
import { hash } from './security';
import { audit } from './audit';
import type { User } from './types';

export interface AdmitInput {
  requestId: string;
  ticketToken: string;
  showId: string;
  gateId: string;
  deviceId: string;
}

export interface AdmitResult {
  result: 'ADMITTED' | 'DENIED' | 'UNKNOWN';
  receiptId?: string;
  reason?: string;
}

const SCANNER_ROLES = ['scanner', 'supervisor', 'owner'] as const;

export function entryAllowed(nowMs: number, startsAtIso: string, entryBefore: number, entryAfter: number) {
  const start = new Date(startsAtIso).getTime();
  if (Number.isNaN(start)) return false;
  const open = start - entryBefore * 60_000;
  const close = start + entryAfter * 60_000;
  return nowMs >= open && nowMs <= close;
}

export async function admit(staff: User, input: AdmitInput): Promise<AdmitResult> {
  requireValue(
    (SCANNER_ROLES as readonly string[]).includes(staff.role),
    'You do not have permission to scan tickets.',
    403,
  );

  return transaction(async (c) => {
    // Idempotency: if requestId already processed, return prior result
    const prior = await c.query<{ result: Record<string, unknown> }>(
      'SELECT result FROM scan_requests WHERE id=$1',
      [input.requestId],
    );
    if (prior.rows[0]) {
      const r = prior.rows[0].result as unknown as AdmitResult;
      return r;
    }

    // Validate staff scope for this show + gate + device (owner bypasses)
    if (staff.role !== 'owner') {
      const scope = await c.query(
        'SELECT 1 FROM staff_scopes WHERE user_id=$1 AND show_id=$2 AND gate=$3 AND device_id=$4',
        [staff.id, input.showId, input.gateId, input.deviceId],
      );
      if (scope.rows.length === 0) {
        const result: AdmitResult = {
          result: 'DENIED',
          reason: 'Staff not authorized for this show, gate, or device.',
        };
        await c.query(
          'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
          [input.requestId, staff.id, hash(input.ticketToken), JSON.stringify(result)],
        );
        return result;
      }

      // Check device is not revoked
      const device = await c.query<{ revoked: boolean }>(
        'SELECT revoked FROM devices WHERE id=$1',
        [input.deviceId],
      );
      if (!device.rows[0] || device.rows[0].revoked) {
        const result: AdmitResult = { result: 'DENIED', reason: 'Device is revoked or unknown.' };
        await c.query(
          'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
          [input.requestId, staff.id, hash(input.ticketToken), JSON.stringify(result)],
        );
        return result;
      }
    }

    const show = await c.query<{ status: string; starts_at: string; entry_before: number; entry_after: number }>(
      `SELECT s.status, s.starts_at, f.entry_before, f.entry_after
       FROM shows s JOIN festivals f ON f.id=s.festival_id WHERE s.id=$1`,
      [input.showId],
    );
    const performance = show.rows[0];
    if (!performance || performance.status !== 'PUBLISHED') {
      const result: AdmitResult = { result: 'DENIED', reason: 'This performance is not open for entry.' };
      await c.query(
        'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
        [input.requestId, staff.id, hash(input.ticketToken), JSON.stringify(result)],
      );
      return result;
    }
    if (!entryAllowed(Date.now(), performance.starts_at, Number(performance.entry_before), Number(performance.entry_after))) {
      const result: AdmitResult = { result: 'DENIED', reason: 'Entry is outside the allowed time window.' };
      await c.query(
        'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
        [input.requestId, staff.id, hash(input.ticketToken), JSON.stringify(result)],
      );
      return result;
    }

    // Hash the ticket token and find the credential
    const tokenDigest = hash(input.ticketToken);
    const credential = await c.query<{
      id: string;
      ticket_id: string;
      status: string;
    }>(
      "SELECT * FROM credentials WHERE digest=$1 AND status='ACTIVE' FOR UPDATE",
      [tokenDigest],
    );

    if (!credential.rows[0]) {
      const result: AdmitResult = { result: 'UNKNOWN', reason: 'Credential not found or inactive.' };
      await c.query(
        'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
        [input.requestId, staff.id, tokenDigest, JSON.stringify(result)],
      );
      return result;
    }

    const { ticket_id } = credential.rows[0];

    // Lock the ticket
    const ticket = await c.query<{ id: string; status: string }>(
      'SELECT * FROM tickets WHERE id=$1 FOR UPDATE',
      [ticket_id],
    );

    if (!ticket.rows[0] || ticket.rows[0].status !== 'ACTIVE') {
      const result: AdmitResult = {
        result: 'DENIED',
        reason: `Ticket status: ${ticket.rows[0]?.status ?? 'not found'}.`,
      };
      await c.query(
        'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
        [input.requestId, staff.id, tokenDigest, JSON.stringify(result)],
      );
      return result;
    }

    // Verify entitlement for show
    const entitlement = await c.query(
      "SELECT * FROM entitlements WHERE ticket_id=$1 AND show_id=$2 AND status='ACTIVE' FOR UPDATE",
      [ticket_id, input.showId],
    );

    if (!entitlement.rows[0]) {
      const result: AdmitResult = {
        result: 'DENIED',
        reason: 'No active entitlement for this show.',
      };
      await c.query(
        'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
        [input.requestId, staff.id, tokenDigest, JSON.stringify(result)],
      );
      return result;
    }

    // Insert admission — unique constraint (ticket_id, show_id) catches re-admission
    let admissionId: string;
    try {
      await c.query('SAVEPOINT admit_insert');
      const ins = await c.query<{ id: string }>(
        'INSERT INTO admissions(ticket_id,show_id,request_id,gate,device_id,actor_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [ticket_id, input.showId, input.requestId, input.gateId, input.deviceId, staff.id],
      );
      await c.query('RELEASE SAVEPOINT admit_insert');
      admissionId = ins.rows[0].id;
    } catch (err: unknown) {
      try {
        await c.query('ROLLBACK TO SAVEPOINT admit_insert');
      } catch {
        // Savepoint may already be rolled back.
      }
      // Unique violation = already admitted
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        const result: AdmitResult = {
          result: 'DENIED',
          reason: 'Ticket already admitted for this show.',
        };
        await c.query(
          'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
          [input.requestId, staff.id, tokenDigest, JSON.stringify(result)],
        );
        return result;
      }
      throw err;
    }

    await audit(c, staff.id, 'admission.scan', ticket_id, {
      showId: input.showId,
      gateId: input.gateId,
      deviceId: input.deviceId,
      admissionId,
    });

    const result: AdmitResult = { result: 'ADMITTED', receiptId: admissionId };
    await c.query(
      'INSERT INTO scan_requests(id,actor_id,input_digest,result) VALUES($1,$2,$3,$4)',
      [input.requestId, staff.id, tokenDigest, JSON.stringify(result)],
    );
    return result;
  });
}
