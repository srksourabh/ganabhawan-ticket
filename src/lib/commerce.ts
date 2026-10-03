import { randomBytes } from 'node:crypto';
import { transaction, one, query, type Client } from './db';
import { requireValue } from './errors';
import { token, hash, encrypt } from './security';
import { audit, job } from './audit';
import { markAttemptsConfirmed } from './attempts';
import { devMode, assertLiveConfiguration } from './env';
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
export async function reserve(user:User,input:{productId:string;quantity:number;version:number},key:string) {
 requireValue(key.length>=8 && key.length<=128,'A valid idempotency key is required.',400);
 assertLiveConfiguration();
 return transaction(async c=>{
  const scope='hold:'+user.id; const digest=hash(JSON.stringify(input));
  const previous=await one(c,'SELECT * FROM idempotency WHERE scope=$1 AND key=$2',[scope,key]);
  if(previous) { requireValue(previous.input_digest===digest,'This request key was already used for another selection.'); return previous.result; }
  await expireIn(c);
  const product=await one(c,'SELECT p.*,f.status festival_status,f.hold_minutes,f.max_quantity,f.terms,f.physical_required FROM products p JOIN festivals f ON f.id=p.festival_id WHERE p.id=$1 FOR UPDATE OF p',[input.productId]);
  requireValue(product && product.enabled,'This ticket option is not available.',404);
  requireValue(product.festival_status==='PUBLISHED' && (devMode() || process.env.ALLOW_PUBLIC_SALES==='true'),'Ticket sales are paused.');
  requireValue(product.version===input.version,'This price has changed. Please refresh your selection.');
  requireValue(Number.isInteger(input.quantity)&&input.quantity>=1&&input.quantity<=product.max_quantity,'Choose a valid ticket quantity.',400);
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
  await c.query('INSERT INTO idempotency(scope,key,input_digest,result) VALUES($1,$2,$3,$4)',[scope,key,digest,JSON.stringify(booking)]);
  await audit(c,user.id,'booking.hold',booking.id,{quantity:input.quantity}); return booking;
 },true);
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
  if(b.status==='CONFIRMED'||b.status==='CANCELLED'||b.status==='REFUND_REQUIRED') { await refundCase(c,b,record.id,payment.amount,'Excess captured payment'); return b; }
  await expireIn(c,bookingId);
  const allocations=(await c.query('SELECT h.*,p.allocation,p.held,p.committed FROM hold_allocations h JOIN pools p ON p.id=h.pool_id WHERE h.booking_id=$1 ORDER BY p.id FOR UPDATE OF p',[bookingId])).rows;
  const live=allocations.length>0&&allocations.every(a=>a.state==='HELD');
  const covered=b.snapshot.coverage as {showId:string;poolId:string;weight:number}[];
  const shows=(await c.query('SELECT status FROM shows WHERE id=ANY($1::uuid[])',[covered.map(s=>s.showId)])).rows;
  const canFulfill=shows.every(s=>s.status==='PUBLISHED') && allocations.length===covered.length && (live||allocations.every(a=>a.allocation-a.held-a.committed>=a.quantity));
  if(!canFulfill) {
   // A live hold must also be released if an organiser cancelled its show.
   if(live) { for(const a of allocations) { await c.query('UPDATE pools SET held=held-$1,version=version+1 WHERE id=$2',[a.quantity,a.pool_id]); await movement(c,a.pool_id,'capture-release:'+b.id,-a.quantity,0,'Captured booking no longer eligible'); } await c.query("UPDATE hold_allocations SET state='RELEASED' WHERE booking_id=$1",[b.id]); }
   await c.query("UPDATE bookings SET status='REFUND_REQUIRED' WHERE id=$1",[b.id]);
   await refundCase(c,b,record.id,payment.amount,'Capture arrived without available coverage');
   return {...b,status:'REFUND_REQUIRED'};
  }
  for(const a of allocations) {
   await c.query('UPDATE pools SET held=held-$1,committed=committed+$2,version=version+1 WHERE id=$3',[live?a.quantity:0,a.quantity,a.pool_id]);
   await movement(c,a.pool_id,'fulfill:'+b.id,live?-a.quantity:0,a.quantity,'Verified captured payment');
  }
  await c.query("UPDATE hold_allocations SET state='COMMITTED' WHERE booking_id=$1",[b.id]);
  for(let i=1;i<=b.quantity;i++) {
   const ticket=(await one(c,'INSERT INTO tickets(booking_id,ordinal,reference) VALUES($1,$2,$3) RETURNING id',[b.id,i,b.reference+'-'+i]))!;
   for(const s of covered) await c.query('INSERT INTO entitlements(ticket_id,show_id,pool_id,weight) VALUES($1,$2,$3,$4)',[ticket.id,s.showId,s.poolId,s.weight]);
   const qr=token(); await c.query("INSERT INTO credentials(ticket_id,digest,encrypted_token,kind,status) VALUES($1,$2,$3,'DIGITAL','ACTIVE')",[ticket.id,hash(qr),encrypt(qr)]);
  }
  await c.query("UPDATE bookings SET status='CONFIRMED' WHERE id=$1",[b.id]);
  await markAttemptsConfirmed(c, b.id);
  await job(c,'DELIVERY','confirmation:'+b.id,{bookingId:b.id});
  await audit(c,b.user_id,'booking.confirmed',b.id,{paymentId:record.id});
  return {...b,status:'CONFIRMED'};
 },true);
}
async function refundCase(c:Client,b:Record<string,unknown>,paymentId:string,amount:number,reason:string) {
 const refund=(await one(c,'INSERT INTO refunds(booking_id,payment_id,amount,reason) VALUES($1,$2,$3,$4) RETURNING id',[b.id,paymentId,amount,reason]))!;
 await job(c,'REFUND','refund:'+refund.id,{refundId:refund.id});
 await c.query('INSERT INTO reconciliation_cases(key,kind,detail) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING',['capture:'+paymentId,'PAYMENT',JSON.stringify({bookingId:b.id,refundId:refund.id,reason})]);
}
export async function ownedBookings(userId:string,id?:string) {
 return query(`SELECT b.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'reference',t.reference,'status',t.status,'ordinal',t.ordinal,'credentialKind',cr.kind,'admitted',(SELECT count(*) FROM admissions a WHERE a.ticket_id=t.id)) ORDER BY t.ordinal) FROM tickets t LEFT JOIN credentials cr ON cr.ticket_id=t.id AND cr.status='ACTIVE' WHERE t.booking_id=b.id),'[]') tickets,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount,'state',r.state,'reason',r.reason)) FROM refunds r WHERE r.booking_id=b.id),'[]') refunds
 FROM bookings b WHERE b.user_id=$1 AND ($2::uuid IS NULL OR b.id=$2) ORDER BY b.created_at DESC`,[userId,id??null]);
}
