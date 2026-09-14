/**
 * Gate rehearsal: reserve → fulfill → admit once → deny second admit.
 * Development only. Requires DATABASE_URL and a published Daily product with future starts_at.
 *
 *   npx tsx scripts/gate-rehearsal.ts
 */
import { pool, query, transaction, one } from '../src/lib/db';
import { devMode } from '../src/lib/env';
import { reserve, fulfill } from '../src/lib/commerce';
import { admit } from '../src/lib/admission';
import { decrypt } from '../src/lib/security';
import type { User } from '../src/lib/types';

if (!devMode()) {
  console.error('Gate rehearsal is development-only.');
  process.exit(1);
}

const contact = `rehearsal-${Date.now()}@samatat.test`;

async function main() {
  const product = (
    await query<{ id: string; version: number; name: string }>(
      `SELECT p.id, p.version, p.name FROM products p
       JOIN festivals f ON f.id = p.festival_id
       WHERE p.kind = 'DAILY' AND p.enabled = true AND f.status = 'PUBLISHED'
       ORDER BY p.price
       LIMIT 1`,
    )
  )[0];
  if (!product) throw new Error('No Daily product found. Seed the programme first.');

  const customer = await transaction(async (c) => {
    const created = await one<User>(
      c,
      "INSERT INTO users(contact,name,role) VALUES($1,'Gate rehearsal','customer') RETURNING *",
      [contact],
    );
    return created!;
  });

  const booking = (await reserve(
    customer,
    { productId: product.id, quantity: 1, version: product.version },
    `rehearsal-${Date.now()}`,
  )) as {
    id: string;
    reference: string;
    total: number;
    currency: string;
  };
  console.log('Held', booking.reference);

  await transaction(async (c) => {
    await c.query("UPDATE bookings SET status='PAYMENT_PENDING' WHERE id=$1", [booking.id]);
    await c.query(
      "INSERT INTO payment_attempts(booking_id,provider_order_id,state) VALUES($1,$2,'READY') ON CONFLICT (provider_order_id) DO NOTHING",
      [booking.id, `dev-${booking.id}`],
    );
  });

  await fulfill(booking.id, {
    id: `dev-pay-${booking.id}`,
    orderId: `dev-${booking.id}`,
    amount: booking.total as number,
    currency: booking.currency as string,
    status: 'captured',
  });
  console.log('Fulfilled');

  const ticket = (
    await query<{ id: string; reference: string }>(
      'SELECT id, reference FROM tickets WHERE booking_id=$1 ORDER BY ordinal LIMIT 1',
      [booking.id],
    )
  )[0];
  if (!ticket) throw new Error('No ticket after fulfill.');

  const cred = (
    await query<{ encrypted_token: string }>(
      "SELECT encrypted_token FROM credentials WHERE ticket_id=$1 AND status='ACTIVE' LIMIT 1",
      [ticket.id],
    )
  )[0];
  if (!cred) throw new Error('No credential on ticket.');
  const ticketToken = decrypt(cred.encrypted_token);

  const show = (
    await query<{ id: string }>(
      'SELECT show_id AS id FROM entitlements WHERE ticket_id=$1 LIMIT 1',
      [ticket.id],
    )
  )[0];
  if (!show) throw new Error('No entitlement/show on ticket.');

  let staff = (
    await query<User>("SELECT * FROM users WHERE role='owner' LIMIT 1")
  )[0];
  if (!staff) {
    staff = await transaction(async (c) => {
      const created = await one<User>(
        c,
        "INSERT INTO users(contact,name,role) VALUES($1,'Rehearsal owner','owner') RETURNING *",
        [`owner-rehearsal-${Date.now()}@samatat.test`],
      );
      return created!;
    });
  }

  const first = await admit(staff, {
    requestId: crypto.randomUUID(),
    ticketToken,
    showId: show.id,
    gateId: 'gate-one',
    deviceId: 'gate-one',
  });
  if (first.result !== 'ADMITTED') throw new Error(`First admit failed: ${first.reason}`);
  console.log('First admit ADMITTED');

  const second = await admit(staff, {
    requestId: crypto.randomUUID(),
    ticketToken,
    showId: show.id,
    gateId: 'gate-one',
    deviceId: 'gate-one',
  });
  if (second.result !== 'DENIED') throw new Error(`Expected DENIED on second admit, got ${second.result}`);
  console.log('Second admit DENIED:', second.reason);
  console.log('Gate rehearsal OK');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
