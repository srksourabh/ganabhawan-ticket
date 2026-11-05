import { transaction, one, query, type Client } from './db';
import { AppError, requireValue } from './errors';
import { audit, job } from './audit';
import { movement } from './commerce';
import { ADMIN_POLICY } from './admin-policy';
import type { User } from './types';

/**
 * Which programmes "All Together — Every Play" covers.
 *
 * Persisted as product_coverage rows of the SEASON products (one product per zone; each row
 * points at that programme's SEASON pool for the zone). A programme is INCLUDED when every
 * All Together product covers it. New programmes are excluded until an admin includes them.
 *
 * What changes and what never does:
 * - Including or excluding a programme changes only what NEW purchases cover (and the
 *   computed original price, pricing.ts). Every booking keeps its own snapshot.coverage, hold
 *   allocations and ticket entitlements, so an existing pass holder's tickets never change
 *   silently.
 * - An existing pass holder gains a programme only through amendExistingPasses: an explicit,
 *   audited entitlement amendment (no new payment, booking amount and snapshot untouched).
 */

export type InclusionState = 'INCLUDED' | 'EXCLUDED' | 'PARTIAL' | 'NO_PASS';

function assertCatalogueRole(user: User) {
  requireValue(user.role === 'owner' || (ADMIN_POLICY.catalogue as readonly string[]).includes(user.role), 'You do not have permission for this action.', 403);
}

/** INCLUDED / EXCLUDED / PARTIAL (some zones only) / NO_PASS, per show id. */
export async function inclusionStates(c?: Client): Promise<Map<string, InclusionState>> {
  const sql = `SELECT s.id, (SELECT count(*)::int FROM products p WHERE p.festival_id=s.festival_id AND p.kind='SEASON') passes,
      (SELECT count(*)::int FROM product_coverage pc JOIN products p ON p.id=pc.product_id WHERE pc.show_id=s.id AND p.kind='SEASON') covered
    FROM shows s`;
  const rows = c ? (await c.query<{ id: string; passes: number; covered: number }>(sql)).rows : await query<{ id: string; passes: number; covered: number }>(sql);
  return new Map(rows.map((r) => [r.id, stateOf(Number(r.passes), Number(r.covered))]));
}

function stateOf(passes: number, covered: number): InclusionState {
  if (passes === 0) return 'NO_PASS';
  if (covered === 0) return 'EXCLUDED';
  return covered >= passes ? 'INCLUDED' : 'PARTIAL';
}

/**
 * Includes or excludes one programme in every All Together product (caller holds the commerce
 * lock). Each changed product's version goes up, so a cart holding the old pass is asked to
 * refresh. Never touches bookings, tickets or entitlements.
 */
export async function applyProgrammeInclusion(c: Client, actorId: string | null, showId: string, include: boolean) {
  const show = await one<{ id: string; festival_id: string; status: string; title: string; ends_at: string }>(c, 'SELECT * FROM shows WHERE id=$1 FOR UPDATE', [showId]);
  requireValue(show, 'Programme not found.', 404);
  const passes = (await c.query<{ id: string; category: string }>(
    "SELECT id, category FROM products WHERE festival_id=$1 AND kind='SEASON' ORDER BY id FOR UPDATE", [show!.festival_id])).rows;
  requireValue(passes.length > 0, 'There is no All Together pass yet. Create one under Seasons first.', 409);
  if (include) {
    requireValue(show!.status !== 'CANCELLED', 'A cancelled programme cannot be added to All Together.', 409);
    requireValue(new Date(show!.ends_at).getTime() > Date.now(), 'A programme that has ended cannot be added to All Together.', 409);
  }
  const changed: string[] = [];
  for (const pass of passes) {
    const covered = await one(c, 'SELECT 1 FROM product_coverage WHERE product_id=$1 AND show_id=$2', [pass.id, showId]);
    if (include && !covered) {
      const pool = await one<{ id: string }>(c,
        `SELECT p.id FROM pools p JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1 AND cap.zone=$2 AND p.kind='SEASON'`, [showId, pass.category]);
      requireValue(pool, `This programme has no All Together seats for ${pass.category}. Set its inventory first.`, 409);
      await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [pass.id, showId, pool!.id]);
      changed.push(pass.id);
    } else if (!include && covered) {
      const left = await one<{ n: number }>(c, 'SELECT count(*)::int n FROM product_coverage WHERE product_id=$1', [pass.id]);
      requireValue(Number(left?.n ?? 0) > 1, 'All Together needs at least one programme. Include another programme first.', 409);
      await c.query('DELETE FROM product_coverage WHERE product_id=$1 AND show_id=$2', [pass.id, showId]);
      changed.push(pass.id);
    }
  }
  if (changed.length) await c.query('UPDATE products SET version=version+1 WHERE id=ANY($1::uuid[])', [changed]);
  await audit(c, actorId, include ? 'programme.all_together.include' : 'programme.all_together.exclude', showId, { title: show!.title, products: changed });
  return { showId, included: include, productsChanged: changed.length, unpublished: include && show!.status !== 'PUBLISHED' };
}

/** Admin action: include / exclude a programme in All Together (owner, inventory). */
export async function setProgrammeInclusion(user: User, showId: string, include: unknown) {
  assertCatalogueRole(user);
  requireValue(/^[0-9a-f-]{36}$/i.test(showId), 'Programme not found.', 404);
  requireValue(typeof include === 'boolean', 'Send include: true or false.', 400);
  return transaction((c) => applyProgrammeInclusion(c, user.id, showId, include as boolean), true);
}

export interface AmendmentResult {
  bookingId: string; reference: string; customerId: string; quantity: number;
  previousProgrammeCount: number; newProgrammeCount: number; notified: boolean;
}

/**
 * Gives every CONFIRMED All Together booking that does not yet have it an entitlement to one
 * included programme: one entitlement per active ticket, one committed seat per ticket in the
 * programme's All Together pool for the booking's zone (so the seats are never sold twice),
 * and an audit record. The booking row (amount, snapshot) and its payments are not changed and
 * no payment order is created. Idempotent: a booking that already has the programme is skipped
 * (and entitlements are unique per ticket and programme). With `notify`, each amended customer
 * gets one booking-update notice (NOTICE job; its unique key prevents duplicates on retries).
 */
export async function amendPassesIn(
  c: Client, actor: { id: string | null; label: string }, showId: string, opts: { reason: string; notify: boolean },
): Promise<AmendmentSummary> {
  requireValue(opts.reason.trim().length >= 10, 'Give the reason for the amendment (at least 10 characters).', 400);
  {
    const show = await one<{ id: string; title: string; status: string; starts_at: string }>(c, 'SELECT * FROM shows WHERE id=$1', [showId]);
    requireValue(show, 'Programme not found.', 404);
    requireValue(show!.status === 'PUBLISHED', 'Only a published programme can be added to existing passes.', 409);
    const bookings = (await c.query<{ id: string; reference: string; user_id: string; quantity: number; product_id: string; category: string }>(
      `SELECT b.id, b.reference, b.user_id, b.quantity, b.product_id, p.category FROM bookings b JOIN products p ON p.id=b.product_id
       WHERE p.kind='SEASON' AND b.status='CONFIRMED' ORDER BY b.created_at, b.id FOR UPDATE OF b`)).rows;
    const amended: AmendmentResult[] = [];
    let skipped = 0;
    let noticesQueued = 0;
    for (const b of bookings) {
      const tickets = (await c.query<{ id: string }>("SELECT id FROM tickets WHERE booking_id=$1 AND status='ACTIVE' ORDER BY ordinal", [b.id])).rows;
      const has = await one<{ n: number }>(c,
        'SELECT count(*)::int n FROM entitlements e JOIN tickets t ON t.id=e.ticket_id WHERE t.booking_id=$1 AND e.show_id=$2', [b.id, showId]);
      if (Number(has?.n ?? 0) > 0 || tickets.length === 0) {
        skipped += 1;
        // A notice can be queued on a later run (e.g. once email delivery works) — only for a booking
        // this programme was ADDED to by an amendment, never for a pass that included it at purchase.
        if (opts.notify && Number(has?.n ?? 0) > 0) {
          const amendedBefore = await one(c,
            "SELECT 1 FROM audit_events WHERE action='booking.entitlement.amend' AND entity=$1 AND detail->>'showId'=$2", [b.id, showId]);
          if (amendedBefore) noticesQueued += await queueNotice(c, show!, b);
        }
        continue;
      }
      const covered = await one(c, 'SELECT 1 FROM product_coverage WHERE product_id=$1 AND show_id=$2', [b.product_id, showId]);
      requireValue(covered, `Include "${show!.title}" in All Together before amending existing passes.`, 409);
      const pool = await one<{ id: string; allocation: number; held: number; committed: number }>(c,
        `SELECT p.* FROM pools p JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1 AND cap.zone=$2 AND p.kind='SEASON' FOR UPDATE OF p`,
        [showId, b.category]);
      requireValue(pool, `"${show!.title}" has no All Together seats for ${b.category}.`, 409);
      const seats = tickets.length;
      if (Number(pool!.allocation) - Number(pool!.held) - Number(pool!.committed) < seats) {
        throw new AppError(409, `Not enough All Together seats left for "${show!.title}" (${b.category}) to amend ${b.reference}.`, 'AMEND_NO_SEATS');
      }
      const previous = await one<{ n: number }>(c,
        "SELECT count(DISTINCT e.show_id)::int n FROM entitlements e JOIN tickets t ON t.id=e.ticket_id WHERE t.booking_id=$1 AND e.status='ACTIVE'", [b.id]);
      const previousProgrammeCount = Number(previous?.n ?? 0);
      for (const t of tickets) {
        await c.query("INSERT INTO entitlements(ticket_id,show_id,pool_id,weight) VALUES($1,$2,$3,1) ON CONFLICT (ticket_id,show_id) DO NOTHING", [t.id, showId, pool!.id]);
      }
      // The seats are committed like a purchase's, and released by the same code if the booking is ever cancelled.
      await c.query("INSERT INTO hold_allocations(booking_id,pool_id,quantity,state) VALUES($1,$2,$3,'COMMITTED')", [b.id, pool!.id, seats]);
      await c.query('UPDATE pools SET committed=committed+$1, version=version+1 WHERE id=$2', [seats, pool!.id]);
      await movement(c, pool!.id, 'amend:' + b.id, 0, seats, `All Together amendment: ${opts.reason}`);
      const result: AmendmentResult = {
        bookingId: b.id, reference: b.reference, customerId: b.user_id, quantity: seats,
        previousProgrammeCount, newProgrammeCount: previousProgrammeCount + 1, notified: opts.notify,
      };
      await audit(c, actor.id, 'booking.entitlement.amend', b.id, {
        ...result, showId, programme: show!.title, reason: opts.reason, actor: actor.label, amendedAt: new Date().toISOString(),
      });
      if (opts.notify) noticesQueued += await queueNotice(c, show!, b);
      amended.push(result);
    }
    return { showId, title: show!.title, amended, skipped, noticesQueued };
  }
}

/** One booking-update notice per amended pass (NOTICE job; the unique key makes a repeat a no-op). Returns 1 if newly queued. */
async function queueNotice(c: Client, show: { id: string; title: string; starts_at: string }, b: { id: string; reference: string }) {
  const when = new Date(show.starts_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const key = `amend:${show.id}:${b.id}`;
  const before = await one(c, 'SELECT 1 FROM jobs WHERE key=$1', [key]);
  if (before) return 0;
  await job(c, 'NOTICE', key, {
    bookingId: b.id,
    message: `Good news: "${show.title}" (${when}) is now included in your All Together — Every Play pass ${b.reference}, at no extra cost. `
      + 'Your existing ticket admits you to it, and the physical ticket for it is handed over with the others on the first day.',
  });
  return 1;
}

export type AmendmentSummary = { showId: string; title: string; amended: AmendmentResult[]; skipped: number; noticesQueued: number };

/**
 * One transaction (commerce lock): optionally include the programme in All Together, then amend
 * every existing pass. With dryRun everything is computed and rolled back.
 */
export async function amendExistingPasses(
  actor: { id: string | null; label: string }, showId: string,
  opts: { reason: string; notify: boolean; include?: boolean; dryRun?: boolean },
): Promise<AmendmentSummary & { included: boolean }> {
  return transaction(async (c) => {
    let included = false;
    if (opts.include) included = (await applyProgrammeInclusion(c, actor.id, showId, true)).productsChanged > 0;
    const result = { ...(await amendPassesIn(c, actor, showId, opts)), included };
    if (opts.dryRun) throw new DryRun(result);
    return result;
  }, true).catch((error) => {
    if (error instanceof DryRun) return error.result;
    throw error;
  });
}

/** Rolls the transaction back after computing what would change. */
class DryRun extends Error {
  constructor(public result: AmendmentSummary & { included: boolean }) { super('dry run'); }
}
