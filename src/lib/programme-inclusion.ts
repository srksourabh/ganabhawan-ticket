import { transaction, one, query, type Client } from './db';
import { requireValue } from './errors';
import { audit } from './audit';
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
