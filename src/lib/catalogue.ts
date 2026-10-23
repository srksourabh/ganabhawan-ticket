import { query, transaction, one, type Client } from './db';
import type { Festival, Product, Show, User } from './types';
import { AppError, requireValue } from './errors';
import { audit } from './audit';
import { developmentAdaptersAllowed, seasonTicketSalesEnabled } from './env';
import { assertShowCancellable, cancelShowSales } from './commerce';
import { defaultDailyClose, productSellState, type CoveredPerformance, type SaleWindow } from './availability';
import { zoneTemplate } from './inventory-admin';
import { ADMIN_POLICY } from './admin-policy';
export async function catalogue() {
 const festival=(await query<Festival>('SELECT * FROM festivals ORDER BY created_at LIMIT 1'))[0];
 if(!festival) return {festival:null,shows:[],products:[],development:developmentAdaptersAllowed()};
 if(festival.status!=='PUBLISHED') {
  return {festival,shows:[],products:[],development:developmentAdaptersAllowed()};
 }
 const shows=await query<Show>("SELECT * FROM shows WHERE festival_id=$1 AND status='PUBLISHED' AND ends_at>now() ORDER BY starts_at",[festival.id]);
 return {festival,shows,products:await publicProducts(festival.id),development:developmentAdaptersAllowed()};
}
type CoverageRow = Record<string, unknown> & CoveredPerformance & { product_id: string; show_id: string; title: string; title_bn: string; ends_at: string; cap_used: number };
/**
 * Enabled products with their sale state, judged over EVERY covered performance
 * by the same rule as placeHold (availability.ts). `coverage` still lists only the
 * performances a customer can see (published, not yet ended); a product with none
 * is not listed. A product that cannot be sold is returned as CLOSED / SOLD_OUT
 * with available 0, never as purchasable. A daily ticket an admin took off sale
 * (Admin → Availability, "On sale" off) is listed as CLOSED, so customers see
 * "Sales closed" for that performance and zone; a disabled season ticket stays hidden.
 */
export async function publicProducts(festivalId: string, nowMs = Date.now()) {
 const rows=await query<CoverageRow>(`SELECT p.*, p.id product_id, pc.show_id, s.title, s.title_bn, s.starts_at, s.ends_at, s.status, s.sales_closes_at, i.allocation, i.held, i.committed,
  f.booking_opens_at, f.season_closes_at,
  (SELECT COALESCE(sum(quantity),0)::int FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')) cap_used
  FROM products p JOIN festivals f ON f.id=p.festival_id JOIN product_coverage pc ON pc.product_id=p.id JOIN pools i ON i.id=pc.pool_id JOIN shows s ON s.id=pc.show_id
  WHERE p.festival_id=$1 AND (p.enabled=true OR p.kind='DAILY') ORDER BY p.price, p.id, s.starts_at`,[festivalId]);
 const byProduct=new Map<string,CoverageRow[]>();
 for(const row of rows) byProduct.set(row.product_id,[...(byProduct.get(row.product_id)??[]),row]);
 const products:Product[]=[];
 for(const coverage of byProduct.values()) {
  const visible=coverage.filter(s=>s.status==='PUBLISHED'&&new Date(s.ends_at).getTime()>nowMs);
  if(visible.length===0) continue;
  const first=coverage[0];
  const kind=first.kind==='SEASON'?'SEASON':'DAILY';
  const {state,available}=!first.enabled?{state:'CLOSED' as const,available:0}:productSellState(kind,coverage,first.cap===null?null:Number(first.cap),Number(first.cap_used),nowMs,undefined,saleWindow(kind,{booking_opens_at:first.booking_opens_at,season_closes_at:first.season_closes_at}));
  const product:Record<string,unknown>={};
  for(const [key,value] of Object.entries(first)) {
   if(!['product_id','show_id','title','title_bn','starts_at','ends_at','status','allocation','held','committed','cap_used','sales_closes_at','booking_opens_at','season_closes_at'].includes(key)) product[key]=value;
  }
  products.push({...(product as unknown as Product),available,state,
   coverage:visible.map(s=>({id:s.show_id,title:s.title,title_bn:s.title_bn,starts_at:new Date(s.starts_at).toISOString(),status:s.status}) as unknown as Show)});
 }
 return products;
}
function saleWindow(kind: 'DAILY' | 'SEASON', row: { booking_opens_at?: unknown; season_closes_at?: unknown }): SaleWindow {
 return { kind, opensAt: row.booking_opens_at as string | null, closesAt: kind === 'SEASON' ? row.season_closes_at as string | null : undefined };
}
function instantOrNull(value: unknown, label: string): string | null {
 if (value === undefined || value === null || value === '') return null;
 const parsed = new Date(String(value));
 requireValue(!Number.isNaN(parsed.getTime()), `${label} is not a valid time.`, 400);
 return parsed.toISOString();
}
export async function adminCatalogue() {
 const festival=(await query<Festival>('SELECT * FROM festivals ORDER BY created_at LIMIT 1'))[0];
 if(!festival) return {festival:null,shows:[],products:[],development:developmentAdaptersAllowed()};
 const shows=await query<Show>('SELECT * FROM shows WHERE festival_id=$1 ORDER BY starts_at',[festival.id]);
 const products=await query<Product>(`SELECT p.*, GREATEST(0,LEAST(COALESCE(MIN(i.allocation-i.held-i.committed),0),
 COALESCE(p.cap-(SELECT COALESCE(sum(quantity),0) FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')),2147483647)))::int available,
 COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'title_bn',s.title_bn,'starts_at',s.starts_at,'status',s.status) ORDER BY s.starts_at) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) coverage
 FROM products p LEFT JOIN product_coverage pc ON pc.product_id=p.id LEFT JOIN pools i ON i.id=pc.pool_id LEFT JOIN shows s ON s.id=pc.show_id
 WHERE p.festival_id=$1 GROUP BY p.id ORDER BY p.price`,[festival.id]);
 return {festival,shows,products,development:developmentAdaptersAllowed()};
}
export async function inventory() { return query(`SELECT p.*, c.zone,c.ceiling,c.version capacity_version,c.row_count,s.id show_id,s.title,s.starts_at,
 (c.ceiling-(SELECT sum(allocation) FROM pools x WHERE x.capacity_id=c.id))::int reserve,
 (SELECT count(*)::int FROM admissions a JOIN entitlements e ON e.ticket_id=a.ticket_id AND e.show_id=a.show_id WHERE e.pool_id=p.id) admitted
 FROM pools p JOIN capacities c ON c.id=p.capacity_id JOIN shows s ON s.id=c.show_id ORDER BY s.starts_at,c.zone,p.kind`); }
export async function adjustInventory(user:User, input:{poolId:string;delta:number;version:number;sourceId?:string;sourceVersion?:number;reason:string;preview?:boolean}) {
 return transaction(async c=>{
  const target=await one(c,'SELECT p.*,c.ceiling FROM pools p JOIN capacities c ON c.id=p.capacity_id WHERE p.id=$1 FOR UPDATE OF p,c',[input.poolId]);
  requireValue(target,'Pool not found.',404); requireValue(target.version===input.version,'Stock changed. Refresh the preview.');
  requireValue(Number.isInteger(input.delta) && input.delta>0 && input.reason.trim().length>=5,'Enter a positive quantity and a reason.',400);
  const siblings=(await c.query('SELECT * FROM pools WHERE capacity_id=$1 ORDER BY id FOR UPDATE',[target.capacity_id])).rows;
  if(input.sourceId) {
   const source=siblings.find(p=>p.id===input.sourceId);
   requireValue(source && source.id!==target.id && source.version===input.sourceVersion,'Transfer source changed.');
   requireValue(source.allocation-source.held-source.committed>=input.delta,'Only unheld, uncommitted stock can be transferred.');
   if(!input.preview) {
    await c.query('UPDATE pools SET allocation=allocation-$1,version=version+1 WHERE id=$2',[input.delta,source.id]);
    await c.query("INSERT INTO movements(pool_id,operation,delta_allocation,reason) VALUES($1,'transfer-out',$2,$3)",[source.id,-input.delta,input.reason]);
   }
  } else requireValue(target.ceiling-siblings.reduce((n,p)=>n+p.allocation,0)>=input.delta,'The approved reserve is too small for this top-up.');
  const result={poolId:target.id,before:target.allocation,after:target.allocation+input.delta,version:target.version,preview:!!input.preview};
  if(!input.preview) {
   await c.query('UPDATE pools SET allocation=allocation+$1,version=version+1 WHERE id=$2',[input.delta,target.id]);
   await c.query("INSERT INTO movements(pool_id,operation,delta_allocation,reason) VALUES($1,'top-up',$2,$3)",[target.id,input.delta,input.reason]);
   await audit(c,user.id,'inventory.adjust',target.id,{...result,reason:input.reason,sourceId:input.sourceId});
  }
  return result;
 },true);
}
export function resolveEnabled(current: boolean, incoming: boolean | undefined) {
  return typeof incoming === 'boolean' ? incoming : current;
}
export function festivalLimits(
  input: { holdMinutes?: unknown; maxQuantity?: unknown; entryBefore?: unknown; entryAfter?: unknown },
  current: { holdMinutes: number; maxQuantity: number; entryBefore: number; entryAfter: number },
) {
  const holdMinutes = Number(input.holdMinutes ?? current.holdMinutes);
  const maxQuantity = Number(input.maxQuantity ?? current.maxQuantity);
  const entryBefore = Number(input.entryBefore ?? current.entryBefore);
  const entryAfter = Number(input.entryAfter ?? current.entryAfter);
  if (!Number.isInteger(holdMinutes) || holdMinutes < 1 || holdMinutes > 30) {
    throw new AppError(400, 'Hold time must be a whole number of minutes from 1 to 30.');
  }
  if (!Number.isInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 20) {
    throw new AppError(400, 'Maximum tickets must be a whole number from 1 to 20.');
  }
  if (!Number.isInteger(entryBefore) || entryBefore < 0 || !Number.isInteger(entryAfter) || entryAfter < 0) {
    throw new AppError(400, 'Entry window minutes must be whole numbers of zero or more.');
  }
  return { holdMinutes, maxQuantity, entryBefore, entryAfter };
}
export async function updateProduct(user:User,id:string,input:{price:number;enabled?:boolean;version:number;name?:string;nameBn?:string}) {
 return transaction(async c=>{
  const p=await one(c,'SELECT * FROM products WHERE id=$1 FOR UPDATE',[id]); requireValue(p,'Product not found',404);
  requireValue(p.version===input.version,'The product changed. Refresh and try again.');
  requireValue(Number.isInteger(input.price)&&input.price>=0,'Price must be nonnegative paise.',400);
  const name=input.name!==undefined?String(input.name):p.name;
  const nameBn=input.nameBn!==undefined?String(input.nameBn):p.name_bn;
  requireValue(name.trim().length>0 && nameBn.trim().length>0,'Product name is required.',400);
  const enabled = resolveEnabled(p.enabled, input.enabled);
  await c.query('UPDATE products SET price=$1,enabled=$2,name=$3,name_bn=$4,version=version+1 WHERE id=$5',[input.price,enabled,name,nameBn,id]);
  await audit(c,user.id,'product.update',id,{before:{price:p.price,enabled:p.enabled,name:p.name,nameBn:p.name_bn},after:input}); return {ok:true};
 },true);
}
/**
 * What the dashboard shows about NEW season-ticket sales. The switch is the runtime setting
 * SEASON_TICKET_SALES_ENABLED (env.ts), changed in the Worker configuration, not here: there
 * is no database-stored toggle, so the dashboard only reads it.
 */
export function seasonSalesState(user:User) {
 assertCatalogueRole(user);
 return {open:seasonTicketSalesEnabled(),setting:'SEASON_TICKET_SALES_ENABLED' as const};
}
function assertCatalogueRole(user:User) {
 requireValue(user.role==='owner' || (ADMIN_POLICY.catalogue as readonly string[]).includes(user.role),'You do not have permission for this action.',403);
}
export async function updateFestival(user:User,input:Record<string,unknown>) {
 return transaction(async c=>{
  const f=(await one<Festival>(c,'SELECT * FROM festivals LIMIT 1 FOR UPDATE'))!;
  const status=String(input.status??f.status);
  requireValue(['DRAFT','PUBLISHED','PAUSED','CLOSED'].includes(status),'Invalid publication state.',400);
  if(status==='PUBLISHED') {
   requireValue(f.capacity_approved && f.policies_approved,'Capacity and policies must be approved before publication.');
   const gaps=await one(c,"SELECT count(*)::int n FROM products p WHERE enabled=true AND NOT EXISTS(SELECT 1 FROM product_coverage pc WHERE pc.product_id=p.id)");
   requireValue(gaps?.n===0,'Every enabled product needs explicit coverage.');
   requireValue(developmentAdaptersAllowed() || process.env.ALLOW_PUBLIC_SALES==='true','Live sales have not been enabled by the operator.');
  }
  const name=String(input.name??f.name), nameBn=String(input.nameBn??f.name_bn);
  const venue=String(input.venue??f.venue), address=String(input.address??f.address);
  const contactEmail=String(input.contactEmail??f.contact_email), terms=String(input.terms??f.terms);
  const theaterPhoto=String(input.theaterPhoto??(f as Festival & {theater_photo?:string}).theater_photo??'/images/auditorium-two-floors.jpg');
  requireValue(name.trim().length>0 && nameBn.trim().length>0 && venue.trim().length>0 && address.trim().length>0 && contactEmail.trim().length>0,
   'Name, venue, address and contact email are required.',400);
  const limits = festivalLimits(
    { holdMinutes: input.holdMinutes, maxQuantity: input.maxQuantity, entryBefore: input.entryBefore, entryAfter: input.entryAfter },
    { holdMinutes: f.hold_minutes, maxQuantity: f.max_quantity, entryBefore: f.entry_before, entryAfter: f.entry_after },
  );
  const bookingOpensAt = input.bookingOpensAt === undefined ? (f.booking_opens_at ?? null) : instantOrNull(input.bookingOpensAt, 'Booking open time');
  const seasonClosesAt = input.seasonClosesAt === undefined
    ? (f.season_closes_at ?? null)
    : instantOrNull(input.seasonClosesAt, 'Season close time');
  requireValue(seasonClosesAt, 'Season ticket sales need a closing time.', 400);
  await c.query(`UPDATE festivals SET status=$1,physical_required=$2,hold_minutes=$3,max_quantity=$4,entry_before=$5,entry_after=$6,
   name=$7,name_bn=$8,venue=$9,address=$10,contact_email=$11,terms=$12,theater_photo=$13,booking_opens_at=$14,season_closes_at=$15 WHERE id=$16`,
   [status,input.physicalRequired??f.physical_required,limits.holdMinutes,limits.maxQuantity,
    limits.entryBefore,limits.entryAfter,name,nameBn,venue,address,contactEmail,terms,theaterPhoto,bookingOpensAt,seasonClosesAt,f.id]);
  await audit(c,user.id,'festival.update',f.id,input); return {ok:true};
 },true);
}
export interface ShowInput {
 title:string; titleBn:string; troupe:string; synopsis:string; synopsisBn:string;
 startsAt:string; runtime:number; genre:string; language?:string; artwork?:string; status?:string;
 salesClosesAt?:string;
}
export async function upsertShow(user:User, input:ShowInput) {
 return transaction(async c=>{
  const festival=await one<Festival>(c,'SELECT * FROM festivals LIMIT 1 FOR UPDATE');
  requireValue(festival,'Create the festival before adding shows.',404);
  requireValue(!!input.title?.trim() && !!input.titleBn?.trim() && !!input.troupe?.trim() && !!input.synopsis?.trim() && !!input.synopsisBn?.trim() && !!input.genre?.trim(),
   'Title, troupe, synopsis and genre are required.',400);
  const startsAt=new Date(input.startsAt);
  requireValue(!Number.isNaN(startsAt.getTime()),'A valid start time is required.',400);
  requireValue(Number.isInteger(input.runtime) && input.runtime>0,'Runtime must be a positive number of minutes.',400);
  const status=String(input.status??'DRAFT');
  requireValue(['DRAFT','PUBLISHED','CANCELLED'].includes(status),'Invalid show status.',400);
  const endsAt=new Date(startsAt.getTime()+input.runtime*60000);
  const salesClosesAt=input.salesClosesAt ? new Date(input.salesClosesAt) : defaultDailyClose(startsAt);
  requireValue(!Number.isNaN(salesClosesAt.getTime()),'Daily ticket sales need a valid closing time.',400);
  const show=(await one<Show>(c,`INSERT INTO shows(festival_id,title,title_bn,troupe,synopsis,synopsis_bn,starts_at,ends_at,language,runtime,genre,artwork,status,sales_closes_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
   [festival!.id,input.title,input.titleBn,input.troupe,input.synopsis,input.synopsisBn,startsAt.toISOString(),endsAt.toISOString(),
    input.language??'Bengali',input.runtime,input.genre,input.artwork??'red',status,salesClosesAt.toISOString()]))!;
  // A new performance never joins an existing season ticket by itself: that would change
  // what season customers bought (and close season sales while the show is a draft). The
  // admin adds it explicitly (addShowToSeason), which is refused once the season has sales.
  // Capacity, allocations and prices come from the dashboard configuration (the latest
  // performance), never from code. The first performance starts empty and unsellable.
  const template=await zoneTemplate(c,festival!.id,show.id);
  for(const {zone,ceiling,seasonAllocation,daily,season,price,enabled} of template) {
   const capacity=(await one(c,'INSERT INTO capacities(show_id,zone,ceiling,season_allocation) VALUES($1,$2,$3,$4) RETURNING *',[show.id,zone,ceiling,seasonAllocation]))!;
   const dailyPool=(await one(c,"INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'DAILY',$2,1,$3) RETURNING *",
    [capacity.id,daily,capacity.row_count]))!;
   await c.query("INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'SEASON',$2,1,$3)",
    [capacity.id,season,capacity.row_count]);
   const dailyProduct=(await one<Product>(c,`INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id,enabled) VALUES($1,$2,$3,$4,'DAILY',$5,$6,$7) RETURNING *`,
    [festival!.id,`${input.title} \u2013 ${zone}`,`${input.titleBn} \u2013 ${zone}`,zone,price,show.id,enabled]))!;
   await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)',[dailyProduct.id,show.id,dailyPool.id]);
  }
  await c.query(`INSERT INTO devices(id,name) VALUES('gate-one','Main entrance'),('gate-two','Balcony entrance') ON CONFLICT(id) DO NOTHING`);
  await c.query(
    `INSERT INTO staff_scopes(user_id,show_id,gate,device_id)
     SELECT u.id, $1, d.id, d.id FROM users u CROSS JOIN devices d
     WHERE u.role IN ('scanner','supervisor') AND d.revoked=false
     ON CONFLICT DO NOTHING`,
    [show.id],
  );
  await audit(c,user.id,'show.create',show.id,input);
  return show;
 },true);
}
/**
 * Status rules for a performance that may already have sold tickets:
 * - CANCELLED is terminal (tickets are void and refunds started; never revive).
 * - Cancelling is owner-only and needs an explicit confirmation flag.
 * - Unpublishing (DRAFT) is refused while tickets or holds exist, because the
 *   gate would then silently refuse paid tickets without any refund.
 */
export async function assertShowTransition(c:Client, user:User, show:Show, next:string, confirmed:boolean) {
 if(show.status===next) return;
 requireValue(show.status!=='CANCELLED','This performance was cancelled. Cancellation is final; create a new performance instead.',409);
 if(next==='CANCELLED') {
  requireValue(user.role==='owner','Only the owner can cancel a performance.',403);
  requireValue(confirmed,'Confirm the cancellation: every ticket is voided and refunds start immediately.',400);
  await assertShowCancellable(c, show.id);
 }
 if(next==='DRAFT') {
  const sold=await one<{n:number}>(c,`SELECT (SELECT count(*) FROM entitlements WHERE show_id=$1 AND status='ACTIVE')
   + (SELECT count(*) FROM hold_allocations h JOIN pools p ON p.id=h.pool_id JOIN capacities cap ON cap.id=p.capacity_id
      WHERE cap.show_id=$1 AND h.state='HELD') AS n`,[show.id]);
  requireValue(Number(sold?.n??0)===0,'Tickets or checkouts exist for this performance. Cancel it (with refunds) instead of unpublishing.',409);
 }
}
/**
 * Deletes a programme (performance) permanently, but only one that never had any
 * history: no booking or hold (any status), purchase attempt, ticket, inventory
 * ledger entry (movements are append-only), scan, and not part of a season ticket.
 * Anything else is refused with the reason and the existing alternative (unpublish
 * to Draft, or cancel with refunds); bookings, payments, tickets, the ledger and the
 * audit log are never deleted. The covering products are locked first: a hold takes
 * the same lock (commerce.reserve), so no sale can start while this runs.
 */
export async function deleteShow(user:User, id:string) {
 // The route checks this too; repeated here so no other caller can skip it (owner always passes).
 requireValue(user.role==='owner' || (ADMIN_POLICY.catalogue as readonly string[]).includes(user.role),'You do not have permission for this action.',403);
 requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),'Programme not found.',404);
 return transaction(async c=>{
  const show=await one<Show>(c,'SELECT * FROM shows WHERE id=$1 FOR UPDATE',[id]);
  requireValue(show,'Programme not found.',404);
  const products=(await c.query<{id:string;kind:string}>(
   `SELECT id,kind FROM products WHERE show_id=$1 OR id IN (SELECT product_id FROM product_coverage WHERE show_id=$1) ORDER BY id FOR UPDATE`,[id])).rows;
  if(products.some(p=>p.kind==='SEASON')) {
   throw new AppError(409,'This programme is part of a season ticket, so it cannot be deleted. Unpublish it (Draft) or cancel it instead.','PROGRAMME_IN_SEASON');
  }
  const ids=products.map(p=>p.id);
  const used=(await one<{sales:number;history:number}>(c,`SELECT
    (SELECT count(*) FROM bookings WHERE product_id=ANY($2::uuid[]))
    + (SELECT count(*) FROM entitlements WHERE show_id=$1)
    + (SELECT count(*) FROM hold_allocations h JOIN pools p ON p.id=h.pool_id JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1) AS sales,
    (SELECT count(*) FROM booking_attempts WHERE product_id=ANY($2::uuid[]))
    + (SELECT count(*) FROM movements m JOIN pools p ON p.id=m.pool_id JOIN capacities cap ON cap.id=p.capacity_id WHERE cap.show_id=$1)
    + (SELECT count(*) FROM scan_requests WHERE show_id=$1)
    + (SELECT count(*) FROM admissions WHERE show_id=$1) AS history`,[id,ids]))!;
  if(Number(used.sales)>0) {
   throw new AppError(409,'Tickets have been sold or reserved for this programme, so it cannot be deleted. Cancel it instead (every buyer is refunded); its bookings and tickets are kept.','PROGRAMME_HAS_BOOKINGS');
  }
  if(Number(used.history)>0) {
   throw new AppError(409,'This programme has inventory or purchase history, so it cannot be permanently deleted. Unpublish it (Draft) to remove it from the public site.','PROGRAMME_HAS_HISTORY');
  }
  // Unsold, unscanned saved carts for its products go with the products (ON DELETE CASCADE).
  await c.query('DELETE FROM product_coverage WHERE show_id=$1',[id]);
  if(ids.length) await c.query('DELETE FROM products WHERE id=ANY($1::uuid[])',[ids]);
  await c.query('DELETE FROM staff_scopes WHERE show_id=$1',[id]);
  await c.query('DELETE FROM pools WHERE capacity_id IN (SELECT id FROM capacities WHERE show_id=$1)',[id]);
  await c.query('DELETE FROM capacities WHERE show_id=$1',[id]);
  await c.query('DELETE FROM shows WHERE id=$1',[id]);
  await audit(c,user.id,'show.delete',id,{title:show!.title,startsAt:show!.starts_at,status:show!.status,products:ids});
  return {deleted:true,id};
 },true);
}
export async function updateShow(user:User, id:string, input:Record<string,unknown>) {
 return transaction(async c=>{
  const show=await one<Show>(c,'SELECT * FROM shows WHERE id=$1 FOR UPDATE',[id]);
  requireValue(show,'Show not found.',404);
  const status=String(input.status??show!.status);
  requireValue(['PUBLISHED','DRAFT','CANCELLED'].includes(status),'Invalid show status.',400);
  await assertShowTransition(c, user, show!, status, input.confirmCancellation === true);
  const startsAt=input.startsAt!==undefined?new Date(String(input.startsAt)):new Date(show!.starts_at);
  requireValue(!Number.isNaN(startsAt.getTime()),'A valid start time is required.',400);
  const runtime=input.runtime!==undefined?Number(input.runtime):show!.runtime;
  requireValue(Number.isInteger(runtime) && runtime>0,'Runtime must be a positive number of minutes.',400);
  const endsAt=new Date(startsAt.getTime()+runtime*60000);
  const title=String(input.title??show!.title), titleBn=String(input.titleBn??show!.title_bn);
  const troupe=String(input.troupe??show!.troupe);
  const synopsis=String(input.synopsis??show!.synopsis), synopsisBn=String(input.synopsisBn??show!.synopsis_bn);
  const genre=String(input.genre??show!.genre), language=String(input.language??show!.language);
  const artwork=input.artwork!==undefined?String(input.artwork):show!.artwork;
  const salesClosesAt=input.salesClosesAt===undefined && show!.sales_closes_at
    ? new Date(show!.sales_closes_at)
    : input.salesClosesAt ? new Date(String(input.salesClosesAt)) : defaultDailyClose(startsAt);
  requireValue(!Number.isNaN(salesClosesAt.getTime()),'Daily ticket sales need a valid closing time.',400);
  requireValue(title.trim().length>0 && titleBn.trim().length>0 && troupe.trim().length>0 && synopsis.trim().length>0 && synopsisBn.trim().length>0 && genre.trim().length>0,
   'Title, troupe, synopsis and genre are required.',400);
  const updated=(await one<Show>(c,`UPDATE shows SET title=$1,title_bn=$2,troupe=$3,synopsis=$4,synopsis_bn=$5,starts_at=$6,ends_at=$7,runtime=$8,genre=$9,language=$10,status=$11,artwork=$12,sales_closes_at=$13
   WHERE id=$14 RETURNING *`,
   [title,titleBn,troupe,synopsis,synopsisBn,startsAt.toISOString(),endsAt.toISOString(),runtime,genre,language,status,artwork,salesClosesAt.toISOString(),id]))!;
  if (status === 'CANCELLED' && show!.status !== 'CANCELLED') await cancelShowSales(c, id, user.id);
  await audit(c,user.id,'show.update',id,input);
  return updated;
 },true);
}
