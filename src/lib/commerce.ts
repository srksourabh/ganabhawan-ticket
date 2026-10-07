import { randomBytes } from 'node:crypto';
import { transaction, one, query, type Client } from './db';
import { requireValue } from './errors';
import { token, hash, encrypt } from './security';
import { audit, job } from './audit';
import { markAttemptsConfirmed } from './attempts';
import { developmentAdaptersAllowed, assertLiveConfiguration } from './env';
import type { User } from './types';
export async function movement(c:Client,poolId:string,operation:string,held:number,committed:number,reason:string) {
 await c.query('INSERT INTO movements(pool_id,operation,delta_held,delta_committed,reason) VALUES($1,$2,$3,$4,$5)',[poolId,operation,held,committed,reason]);
}
export async function expireIn(c:Client,id?:string) {
 const expired=(await c.query("SELECT * FROM bookings WHERE status IN ('HELD','PAYMENT_PENDING') AND expires_at<=now() AND ($1::uuid IS NULL OR id=$1) ORDER BY id FOR UPDATE",[id??null])).rows;
 for(const b of expired) {
  const allocations=(await c.query("SELECT h.*,p.id FROM hold_allocations h JOIN pools p ON p.id=h.pool_id WHERE booking_id=$1 AND state='HELD' ORDER BY pool_id FOR UPDATE OF p",[b.id])).rows;
  for(const a of allocations) { await c.query('UPDATE pools SET held=held-$1,version=version+1 WHERE id=$2',[a.quantity,a.pool_id]); await movement(c,a.pool_id,'expiry:'+b.id,-a.quantity,0,'Hold expired'); }
  await c.query("UPDATE hold_allocations SET state='RELEASED' WHERE booking_id=$1 AND state='HELD'",[b.id]);
  await c.query("UPDATE bookings SET status='EXPIRED' WHERE id=$1",[b.id]);
 }
 return expired.length;
}
export async function expireHolds() { return transaction(c=>expireIn(c),true); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SQL rows are loosely typed in this module
type BookingRow = Record<string, any>;
export type HoldInput = {productId:string;quantity:number;version:number};
/** Loads and validates a product for a hold (locks the product row). */
export async function loadProductForHold(c:Client,input:HoldInput) {
  const product=await one(c,'SELECT p.*,f.status festival_status,f.hold_minutes,f.max_quantity,f.terms,f.physical_required FROM products p JOIN festivals f ON f.id=p.festival_id WHERE p.id=$1 FOR UPDATE OF p',[input.productId]);
  requireValue(product && product.enabled,'This ticket option is not available.',404);
  requireValue(product.festival_status==='PUBLISHED' && (developmentAdaptersAllowed() || process.env.ALLOW_PUBLIC_SALES==='true'),'Ticket sales are paused.');
  requireValue(product.version===input.version,'This price has changed. Please refresh your selection.');
  requireValue(Number.isInteger(input.quantity)&&input.quantity>=1&&input.quantity<=product.max_quantity,'Choose a valid ticket quantity.',400);
  return product;
}
/**
 * Locks the product's pools, checks sales window, capacity and product cap,
 * then creates a HELD booking with its allocations. Caller holds the commerce
 * lock; any failure throws and rolls the caller's transaction back.
 */
export async function placeHold(c:Client,user:User,input:HoldInput,product:BookingRow) {
  const coverage=(await c.query('SELECT pc.*,p.allocation,p.held,p.committed,s.title,s.starts_at,s.status FROM product_coverage pc JOIN pools p ON p.id=pc.pool_id JOIN shows s ON s.id=pc.show_id WHERE pc.product_id=$1 ORDER BY s.starts_at, p.id FOR UPDATE OF p',[product.id])).rows;
  requireValue(coverage.length>0 && coverage.every(s=>s.status==='PUBLISHED'&&new Date(s.starts_at).getTime()>Date.now()),'Sales for this performance have closed.');
  requireValue(coverage.every(p=>p.allocation-p.held-p.committed>=input.quantity),'Not enough tickets remain. Please choose fewer tickets.');
  if(product.cap!==null) { const used=await one(c,"SELECT COALESCE(sum(quantity),0)::int n FROM bookings WHERE product_id=$1 AND status IN ('HELD','PAYMENT_PENDING','CONFIRMED')",[product.id]); requireValue(used!.n+input.quantity<=product.cap,'The product limit has been reached.'); }
  const snapshot={name:product.name,category:product.category,kind:product.kind,terms:product.terms,physicalRequired:product.physical_required,coverage:coverage.map(s=>({showId:s.show_id,poolId:s.pool_id,title:s.title,startsAt:s.starts_at,weight:s.weight}))};
  const booking=(await one(c,`INSERT INTO bookings(reference,user_id,product_id,quantity,unit_price,total,product_version,snapshot,status,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'HELD',now()+$9*interval '1 minute') RETURNING *`,
   ['GF-'+randomBytes(4).toString('hex').toUpperCase(),user.id,product.id,input.quantity,product.price,product.price*input.quantity,product.version,JSON.stringify(snapshot),product.hold_minutes]))!;
  for(const p of coverage) {
   await c.query("INSERT INTO hold_allocations(booking_id,pool_id,quantity,state) VALUES($1,$2,$3,'HELD')",[booking.id,p.pool_id,input.quantity]);
   await c.query('UPDATE pools SET held=held+$1,version=version+1 WHERE id=$2',[input.quantity,p.pool_id]);
   await movement(c,p.pool_id,'reserve:'+booking.id,input.quantity,0,'Checkout reservation');
  }
  await audit(c,user.id,'booking.hold',booking.id,{quantity:input.quantity});
  return booking;
}
export async function reserve(user:User,input:HoldInput,key:string) {
 requireValue(key.length>=8 && key.length<=128,'A valid idempotency key is required.',400);
 assertLiveConfiguration();
 return transaction(async c=>{
  const scope='hold:'+user.id; const digest=hash(JSON.stringify(input));
  const previous=await one(c,'SELECT * FROM idempotency WHERE scope=$1 AND key=$2',[scope,key]);
  if(previous) {
   requireValue(previous.input_digest===digest,'This request key was already used for another selection.');
   // Same checkout retried: same booking, current state (never a stale snapshot).
   return (await one(c,'SELECT * FROM bookings WHERE id=$1 AND user_id=$2',[previous.result.id,user.id])) ?? previous.result;
  }
  await expireIn(c);
  const product=await loadProductForHold(c,input);
  let open=await one(c,"SELECT * FROM bookings WHERE user_id=$1 AND product_id=$2 AND status IN ('HELD','PAYMENT_PENDING') AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[user.id,product.id]);
  if(open && (Number(open.quantity)!==input.quantity || open.checkout_id)) {
   // The cart changed (or this ticket is part of a cart checkout): the old hold is
   // superseded. Its order may still be open in a dismissed Razorpay modal; if it
   // is paid anyway, fulfil() sees CANCELLED and refunds it automatically.
   if(open.checkout_id) await supersedeCheckout(c,open.checkout_id,user.id); else await supersedeBooking(c,open,user.id);
   open=undefined;
  }
  if(open) {
   await c.query('INSERT INTO idempotency(scope,key,input_digest,result) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[scope,key,digest,JSON.stringify(open)]);
   return open;
  }
  const booking=await placeHold(c,user,input,product);
  await c.query('INSERT INTO idempotency(scope,key,input_digest,result) VALUES($1,$2,$3,$4)',[scope,key,digest,JSON.stringify(booking)]);
  return booking;
 },true);
}
/**
 * Releases a live (HELD / PAYMENT_PENDING) booking that the customer replaced
 * with a different selection, and cancels it. Caller holds the commerce lock.
 * Its provider order, if any, stays READY so reconciliation and the webhook
 * still see a late payment, which fulfil() refunds because the booking is CANCELLED.
 */
export async function supersedeBooking(c:Client,b:Record<string,unknown>,actorId:string) {
  const held=(await c.query("SELECT h.pool_id,h.quantity FROM hold_allocations h JOIN pools p ON p.id=h.pool_id WHERE h.booking_id=$1 AND h.state='HELD' ORDER BY h.pool_id FOR UPDATE OF p",[b.id])).rows as {pool_id:string;quantity:number}[];
  for(const a of held) { await c.query('UPDATE pools SET held=held-$1,version=version+1 WHERE id=$2',[a.quantity,a.pool_id]); await movement(c,a.pool_id,'supersede:'+b.id,-a.quantity,0,'Checkout replaced by the customer'); }
  await c.query("UPDATE hold_allocations SET state='RELEASED' WHERE booking_id=$1 AND state='HELD'",[b.id]);
  await c.query("UPDATE bookings SET status='CANCELLED' WHERE id=$1 AND status IN ('HELD','PAYMENT_PENDING')",[b.id]);
  await audit(c,actorId,'booking.superseded',String(b.id),{});
}
/** Supersedes every still-live booking of a checkout (the whole cart was replaced). */
export async function supersedeCheckout(c:Client,checkoutId:string,actorId:string) {
  const live=(await c.query("SELECT * FROM bookings WHERE checkout_id=$1 AND status IN ('HELD','PAYMENT_PENDING') ORDER BY id FOR UPDATE",[checkoutId])).rows;
  for(const b of live) await supersedeBooking(c,b,actorId);
  return live.length;
}
type Allocation = {pool_id:string;quantity:number;state:string;allocation:number;held:number;committed:number};
export type BookingAssessment = { allocations:Allocation[]; live:boolean; covered:{showId:string;poolId:string;weight:number}[]; canFulfill:boolean };
/**
 * Can this booking be confirmed now? Locks its pools. Call after expireIn so an
 * expired hold is already released. A live hold always fits; an expired one
 * fits only if its pools still have room. Shows must be PUBLISHED and the
 * product cap respected.
 */
export async function assessBooking(c:Client,b:BookingRow):Promise<BookingAssessment> {
  const allocations=(await c.query('SELECT h.*,p.allocation,p.held,p.committed FROM hold_allocations h JOIN pools p ON p.id=h.pool_id WHERE h.booking_id=$1 ORDER BY p.id FOR UPDATE OF p',[b.id])).rows as Allocation[];
  const live=allocations.length>0&&allocations.every(a=>a.state==='HELD');
  const covered=b.snapshot.coverage as {showId:string;poolId:string;weight:number}[];
  const shows=(await c.query('SELECT status FROM shows WHERE id=ANY($1::uuid[])',[covered.map(s=>s.showId)])).rows;
  const productCap=await one<{cap:number|null}>(c,'SELECT cap FROM products WHERE id=$1',[b.product_id]);
  let withinCap=true;
  if(productCap && productCap.cap!==null) {
   const used=await one<{n:number}>(c,"SELECT COALESCE(sum(quantity),0)::int n FROM bookings WHERE product_id=$1 AND status='CONFIRMED' AND id<>$2",[b.product_id,b.id]);
   withinCap=(used?.n??0)+Number(b.quantity)<=Number(productCap.cap);
  }
  const canFulfill=b.status!=='CANCELLED' && shows.every(s=>s.status==='PUBLISHED') && allocations.length===covered.length && withinCap && (live||allocations.every(a=>a.allocation-a.held-a.committed>=a.quantity));
  return {allocations,live,covered,canFulfill};
}
export async function releaseLiveHold(c:Client,b:BookingRow,allocations:Allocation[],operation:string,reason:string) {
  for(const a of allocations) { await c.query('UPDATE pools SET held=held-$1,version=version+1 WHERE id=$2',[a.quantity,a.pool_id]); await movement(c,a.pool_id,operation+b.id,-a.quantity,0,reason); }
  await c.query("UPDATE hold_allocations SET state='RELEASED' WHERE booking_id=$1",[b.id]);
}
/** Commits inventory, issues tickets/credentials, confirms and queues delivery. */
export async function commitBooking(c:Client,b:BookingRow,a:BookingAssessment,paymentRecordId:string,queueDelivery=true) {
  for(const al of a.allocations) {
   await c.query('UPDATE pools SET held=held-$1,committed=committed+$2,version=version+1 WHERE id=$3',[a.live?al.quantity:0,al.quantity,al.pool_id]);
   await movement(c,al.pool_id,'fulfill:'+b.id,a.live?-al.quantity:0,al.quantity,'Verified captured payment');
  }
  await c.query("UPDATE hold_allocations SET state='COMMITTED' WHERE booking_id=$1",[b.id]);
  for(let i=1;i<=b.quantity;i++) {
   const ticket=(await one(c,'INSERT INTO tickets(booking_id,ordinal,reference) VALUES($1,$2,$3) RETURNING id',[b.id,i,b.reference+'-'+i]))!;
   for(const s of a.covered) await c.query('INSERT INTO entitlements(ticket_id,show_id,pool_id,weight) VALUES($1,$2,$3,$4)',[ticket.id,s.showId,s.poolId,s.weight]);
   const qr=token(); await c.query("INSERT INTO credentials(ticket_id,digest,encrypted_token,kind,status) VALUES($1,$2,$3,'DIGITAL','ACTIVE')",[ticket.id,hash(qr),encrypt(qr)]);
  }
  await c.query("UPDATE bookings SET status='CONFIRMED' WHERE id=$1",[b.id]);
  await c.query('UPDATE payment_attempts SET next_reconcile_at=NULL WHERE booking_id=$1',[b.id]);
  await markAttemptsConfirmed(c, b.id);
  if(queueDelivery) await job(c,'DELIVERY','confirmation:'+b.id,{bookingId:b.id});
  await audit(c,b.user_id,'booking.confirmed',b.id,{paymentId:paymentRecordId});
}
export interface CapturedPayment { id:string;orderId:string;amount:number;currency:string;status:string; }
export async function fulfill(bookingId:string,payment:CapturedPayment) {
 return transaction(async c=>{
  const b=await one(c,'SELECT * FROM bookings WHERE id=$1 FOR UPDATE',[bookingId]); requireValue(b,'Booking not found.',404);
  requireValue(payment.status==='captured' && Number(payment.amount)===Number(b.total) && payment.currency===b.currency,'Captured payment does not match this booking.',400);
  const attempt=await one(c,'SELECT * FROM payment_attempts WHERE booking_id=$1 AND provider_order_id=$2',[bookingId,payment.orderId]); requireValue(attempt,'Payment order mismatch.',400);
  const existing=await one(c,'SELECT * FROM payments WHERE provider_payment_id=$1',[payment.id]);
  if(existing) { requireValue(existing.booking_id===bookingId,'Payment belongs to another booking.',400); return b; }
  const record=(await one(c,"INSERT INTO payments(booking_id,provider_payment_id,provider_order_id,amount,currency,state) VALUES($1,$2,$3,$4,$5,'CAPTURED') RETURNING id",[bookingId,payment.id,payment.orderId,payment.amount,payment.currency]))!;
  if(b.status==='CONFIRMED'||b.status==='CANCELLED'||b.status==='REFUND_REQUIRED'||b.status==='REFUNDED') { await refundCase(c,b,record.id,payment.amount,'Excess captured payment'); return b; }
  await expireIn(c,bookingId);
  const assessment=await assessBooking(c,b);
  if(!assessment.canFulfill) {
   // A live hold must also be released if an organiser cancelled its show.
   if(assessment.live) await releaseLiveHold(c,b,assessment.allocations,'capture-release:','Captured booking no longer eligible');
   await c.query("UPDATE bookings SET status='REFUND_REQUIRED' WHERE id=$1",[b.id]);
   await refundCase(c,b,record.id,payment.amount,'Capture arrived without available coverage');
   return {...b,status:'REFUND_REQUIRED'};
  }
  await commitBooking(c,b,assessment,record.id);
  return {...b,status:'CONFIRMED'};
 },true);
}
/**
 * Voids sales for a cancelled show (caller holds the commerce lock and has
 * already moved the show to CANCELLED). Idempotent: it only touches live
 * holds and ACTIVE entitlements, and never creates a second refund for a
 * payment that already has one.
 *
 * Season bookings that also cover other performances cannot be partly
 * refunded until the committee sets the refund policy (DECISIONS.md D14),
 * so cancellation is refused while any exist (see assertShowCancellable).
 */
export async function assertShowCancellable(c: Client, showId: string) {
  const season = await one<{ n: number }>(
    c,
    `SELECT count(DISTINCT b.id)::int n FROM bookings b
     JOIN entitlements e ON e.show_id=$1 AND e.status='ACTIVE'
     JOIN tickets t ON t.id=e.ticket_id AND t.booking_id=b.id
     WHERE b.status='CONFIRMED' AND jsonb_array_length(b.snapshot->'coverage') > 1`,
    [showId],
  );
  requireValue(
    (season?.n ?? 0) === 0,
    `${season?.n} season booking(s) include this performance. Partial season refunds are not supported until the refund policy (D14) is decided. Contact engineering before cancelling.`,
    409,
  );
}
export async function cancelShowSales(c: Client, showId: string, actorId: string) {
  await assertShowCancellable(c, showId);
  const pools = (await c.query(
    'SELECT p.id FROM pools p JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1 ORDER BY p.id FOR UPDATE OF p',
    [showId],
  )).rows as { id: string }[];
  if (pools.length === 0) return { bookings: 0, refunds: 0 };
  const bookings = (await c.query(
    `SELECT b.id, b.status, b.checkout_id, b.total FROM bookings b
     WHERE b.id IN (
       SELECT h.booking_id FROM hold_allocations h
       WHERE h.pool_id = ANY($1::uuid[]) AND h.state IN ('HELD','COMMITTED')
     ) AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')
     ORDER BY b.id FOR UPDATE`,
    [pools.map((p) => p.id)],
  )).rows as { id: string; status: string; checkout_id: string | null; total: number }[];

  let refunds = 0;
  for (const b of bookings) {
    // An unpaid cart checkout cannot complete without this line: release the whole
    // cart (all-or-nothing). A payment arriving later on its order is refunded.
    if (b.checkout_id && b.status !== 'CONFIRMED') await supersedeCheckout(c, b.checkout_id, actorId);
    const allocations = (await c.query(
      "SELECT pool_id, quantity, state FROM hold_allocations WHERE booking_id=$1 AND state IN ('HELD','COMMITTED') ORDER BY pool_id FOR UPDATE",
      [b.id],
    )).rows as { pool_id: string; quantity: number; state: string }[];

    for (const a of allocations) {
      if (a.state === 'HELD') {
        await c.query('UPDATE pools SET held=held-$1, version=version+1 WHERE id=$2', [a.quantity, a.pool_id]);
        await movement(c, a.pool_id, 'show-cancel:' + b.id, -a.quantity, 0, 'Show cancelled');
      } else {
        await c.query('UPDATE pools SET committed=committed-$1, version=version+1 WHERE id=$2', [a.quantity, a.pool_id]);
        await movement(c, a.pool_id, 'show-cancel:' + b.id, 0, -a.quantity, 'Show cancelled');
      }
    }
    await c.query("UPDATE hold_allocations SET state='RELEASED' WHERE booking_id=$1 AND state IN ('HELD','COMMITTED')", [b.id]);
    await c.query(
      "UPDATE entitlements SET status='CANCELLED' WHERE status='ACTIVE' AND ticket_id IN (SELECT id FROM tickets WHERE booking_id=$1)",
      [b.id],
    );
    await c.query(
      "UPDATE credentials SET status='REVOKED' WHERE status='ACTIVE' AND ticket_id IN (SELECT id FROM tickets WHERE booking_id=$1)",
      [b.id],
    );
    await c.query("UPDATE tickets SET status='CANCELLED' WHERE booking_id=$1 AND status='ACTIVE'", [b.id]);
    await c.query("UPDATE bookings SET status='CANCELLED' WHERE id=$1", [b.id]);

    // Every captured payment on the booking without a refund yet is refunded in full.
    const unpaidBack = (await c.query(
      `SELECT p.id, p.amount FROM payments p WHERE p.booking_id=$1 AND p.state='CAPTURED'
       AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id=p.id) ORDER BY p.created_at`,
      [b.id],
    )).rows as { id: string; amount: number }[];
    for (const payment of unpaidBack) {
      await refundCase(c, { id: b.id }, payment.id, Number(payment.amount), 'Show cancelled', false);
      refunds += 1;
    }
    // A confirmed line of a cart checkout: refund THIS booking's price from the
    // shared payment (owner decision), taken from the payment that still has
    // that much unrefunded. Once per booking (it is now CANCELLED).
    if (b.checkout_id && b.status === 'CONFIRMED') {
      const shared = (await c.query(
        `SELECT p.id, p.amount - COALESCE((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id=p.id AND r.state<>'FAILED'),0) AS remaining
         FROM payments p WHERE p.checkout_id=$1 AND p.state='CAPTURED' ORDER BY p.created_at`,
        [b.checkout_id],
      )).rows as { id: string; remaining: number }[];
      const source = shared.find((p) => Number(p.remaining) >= Number(b.total));
      if (source) {
        await refundCase(c, { id: b.id }, source.id, Number(b.total), 'Show cancelled', false);
        refunds += 1;
      } else {
        await c.query('INSERT INTO reconciliation_cases(key,kind,detail) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',
          ['show-cancel-refund:' + b.id, 'REFUND', JSON.stringify({ bookingId: b.id, checkoutId: b.checkout_id, reason: 'No captured checkout payment with enough unrefunded balance' })]);
      }
    }
    await job(c, 'NOTICE', 'cancel-booking:' + showId + ':' + b.id, {
      bookingId: b.id,
      message: b.status === 'CONFIRMED'
        ? 'A performance you booked was cancelled. Your tickets are void and a full refund has been started to your original payment method.'
        : 'A performance in your checkout was cancelled. The hold has been released. If you completed a payment, it will be refunded automatically.',
    });
    await audit(c, actorId, 'show.cancel.booking', b.id, { showId, previousStatus: b.status, refunds: unpaidBack.length });
  }
  return { bookings: bookings.length, refunds };
}
export async function refundCase(c:Client,b:Record<string,unknown>,paymentId:string,amount:number,reason:string,openCase=true) {
 const refund=(await one(c,'INSERT INTO refunds(booking_id,payment_id,amount,reason) VALUES($1,$2,$3,$4) RETURNING id',[b.id,paymentId,amount,reason]))!;
 await job(c,'REFUND','refund:'+refund.id,{refundId:refund.id});
 if(openCase) await c.query('INSERT INTO reconciliation_cases(key,kind,detail) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',['capture:'+paymentId,'PAYMENT',JSON.stringify({bookingId:b.id,refundId:refund.id,reason})]);
}
export async function ownedBookings(userId:string,id?:string) {
 return query(`SELECT b.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'reference',t.reference,'status',t.status,'ordinal',t.ordinal,'credentialKind',cr.kind,'admitted',(SELECT count(*) FROM admissions a WHERE a.ticket_id=t.id)) ORDER BY t.ordinal) FROM tickets t LEFT JOIN credentials cr ON cr.ticket_id=t.id AND cr.status='ACTIVE' WHERE t.booking_id=b.id),'[]') tickets,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount,'state',r.state,'reason',r.reason)) FROM refunds r WHERE r.booking_id=b.id),'[]') refunds,
 co.reference checkout_reference, co.total checkout_total
 FROM bookings b LEFT JOIN checkouts co ON co.id=b.checkout_id WHERE b.user_id=$1 AND ($2::uuid IS NULL OR b.id=$2) ORDER BY b.created_at DESC`,[userId,id??null]);
}
