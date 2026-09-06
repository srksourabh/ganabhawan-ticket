import { query, transaction, one } from './db';
import type { Festival, Product, Show, User } from './types';
import { requireValue } from './errors';
import { audit } from './audit';
import { devMode } from './env';
export async function catalogue() {
 const festival=(await query<Festival>('SELECT * FROM festivals ORDER BY created_at LIMIT 1'))[0];
 if(!festival) return {festival:null,shows:[],products:[],development:devMode()};
 const shows=await query<Show>("SELECT * FROM shows WHERE festival_id=$1 AND status='PUBLISHED' ORDER BY starts_at",[festival.id]);
 const products=await query<Product>(`SELECT p.*, GREATEST(0,LEAST(COALESCE(MIN(i.allocation-i.held-i.committed),0),
 COALESCE(p.cap-(SELECT COALESCE(sum(quantity),0) FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')),2147483647)))::int available,
 jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'title_bn',s.title_bn,'starts_at',s.starts_at,'status',s.status) ORDER BY s.starts_at) coverage
 FROM products p JOIN product_coverage pc ON pc.product_id=p.id JOIN pools i ON i.id=pc.pool_id JOIN shows s ON s.id=pc.show_id
 WHERE p.festival_id=$1 AND p.enabled=true GROUP BY p.id ORDER BY p.price`,[festival.id]);
 return {festival,shows,products,development:devMode()};
}
export async function adminCatalogue() {
 const festival=(await query<Festival>('SELECT * FROM festivals ORDER BY created_at LIMIT 1'))[0];
 if(!festival) return {festival:null,shows:[],products:[],development:devMode()};
 const shows=await query<Show>('SELECT * FROM shows WHERE festival_id=$1 ORDER BY starts_at',[festival.id]);
 const products=await query<Product>(`SELECT p.*, GREATEST(0,LEAST(COALESCE(MIN(i.allocation-i.held-i.committed),0),
 COALESCE(p.cap-(SELECT COALESCE(sum(quantity),0) FROM bookings b WHERE b.product_id=p.id AND b.status IN ('HELD','PAYMENT_PENDING','CONFIRMED')),2147483647)))::int available,
 COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'title_bn',s.title_bn,'starts_at',s.starts_at,'status',s.status) ORDER BY s.starts_at) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) coverage
 FROM products p LEFT JOIN product_coverage pc ON pc.product_id=p.id LEFT JOIN pools i ON i.id=pc.pool_id LEFT JOIN shows s ON s.id=pc.show_id
 WHERE p.festival_id=$1 GROUP BY p.id ORDER BY p.price`,[festival.id]);
 return {festival,shows,products,development:devMode()};
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
export async function updateProduct(user:User,id:string,input:{price:number;enabled:boolean;version:number;name?:string;nameBn?:string}) {
 return transaction(async c=>{
  const p=await one(c,'SELECT * FROM products WHERE id=$1 FOR UPDATE',[id]); requireValue(p,'Product not found',404);
  requireValue(p.version===input.version,'The product changed. Refresh and try again.');
  requireValue(Number.isInteger(input.price)&&input.price>=0,'Price must be nonnegative paise.',400);
  const name=input.name!==undefined?String(input.name):p.name;
  const nameBn=input.nameBn!==undefined?String(input.nameBn):p.name_bn;
  requireValue(name.trim().length>0 && nameBn.trim().length>0,'Product name is required.',400);
  await c.query('UPDATE products SET price=$1,enabled=$2,name=$3,name_bn=$4,version=version+1 WHERE id=$5',[input.price,input.enabled,name,nameBn,id]);
  await audit(c,user.id,'product.update',id,{before:{price:p.price,enabled:p.enabled,name:p.name,nameBn:p.name_bn},after:input}); return {ok:true};
 },true);
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
   requireValue(devMode() || process.env.ALLOW_PUBLIC_SALES==='true','Live sales have not been enabled by the operator.');
  }
  const name=String(input.name??f.name), nameBn=String(input.nameBn??f.name_bn);
  const venue=String(input.venue??f.venue), address=String(input.address??f.address);
  const contactEmail=String(input.contactEmail??f.contact_email), terms=String(input.terms??f.terms);
  const theaterPhoto=String(input.theaterPhoto??(f as Festival & {theater_photo?:string}).theater_photo??'/images/auditorium-two-floors.jpg');
  requireValue(name.trim().length>0 && nameBn.trim().length>0 && venue.trim().length>0 && address.trim().length>0 && contactEmail.trim().length>0,
   'Name, venue, address and contact email are required.',400);
  await c.query(`UPDATE festivals SET status=$1,physical_required=$2,hold_minutes=$3,max_quantity=$4,entry_before=$5,entry_after=$6,
   name=$7,name_bn=$8,venue=$9,address=$10,contact_email=$11,terms=$12,theater_photo=$13 WHERE id=$14`,
   [status,input.physicalRequired??f.physical_required,input.holdMinutes??f.hold_minutes,input.maxQuantity??f.max_quantity,
    input.entryBefore??f.entry_before,input.entryAfter??f.entry_after,name,nameBn,venue,address,contactEmail,terms,theaterPhoto,f.id]);
  await audit(c,user.id,'festival.update',f.id,input); return {ok:true};
 },true);
}
const ZONES: {zone:'Premier'|'Superior'|'Balcony';ceiling:number;price:number}[] = [
 {zone:'Premier',ceiling:100,price:50000},
 {zone:'Superior',ceiling:120,price:35000},
 {zone:'Balcony',ceiling:80,price:25000},
];
export interface ShowInput {
 title:string; titleBn:string; troupe:string; synopsis:string; synopsisBn:string;
 startsAt:string; runtime:number; genre:string; language?:string; artwork?:string;
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
  const endsAt=new Date(startsAt.getTime()+input.runtime*60000);
  const show=(await one<Show>(c,`INSERT INTO shows(festival_id,title,title_bn,troupe,synopsis,synopsis_bn,starts_at,ends_at,language,runtime,genre,artwork,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT') RETURNING *`,
   [festival!.id,input.title,input.titleBn,input.troupe,input.synopsis,input.synopsisBn,startsAt.toISOString(),endsAt.toISOString(),
    input.language??'Bengali',input.runtime,input.genre,input.artwork??'red']))!;
  const seasonProducts=(await c.query("SELECT * FROM products WHERE festival_id=$1 AND kind='SEASON'",[festival!.id])).rows;
  for(const {zone,ceiling,price} of ZONES) {
   const capacity=(await one(c,'INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,$2,$3) RETURNING *',[show.id,zone,ceiling]))!;
   const dailyPool=(await one(c,"INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'DAILY',$2,1,$3) RETURNING *",
    [capacity.id,ceiling-40,capacity.row_count]))!;
   const seasonPool=(await one(c,"INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,'SEASON',30,1,$2) RETURNING *",
    [capacity.id,capacity.row_count]))!;
   const dailyProduct=(await one<Product>(c,`INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,$2,$3,$4,'DAILY',$5,$6) RETURNING *`,
    [festival!.id,`${input.title} \u2013 ${zone}`,`${input.titleBn} \u2013 ${zone}`,zone,price,show.id]))!;
   await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)',[dailyProduct.id,show.id,dailyPool.id]);
   for(const sp of seasonProducts) {
    if(sp.category===zone) await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)',[sp.id,show.id,seasonPool.id]);
   }
  }
  await audit(c,user.id,'show.create',show.id,input);
  return show;
 },true);
}
export async function updateShow(user:User, id:string, input:Record<string,unknown>) {
 return transaction(async c=>{
  const show=await one<Show>(c,'SELECT * FROM shows WHERE id=$1 FOR UPDATE',[id]);
  requireValue(show,'Show not found.',404);
  const status=String(input.status??show!.status);
  requireValue(['PUBLISHED','DRAFT','CANCELLED'].includes(status),'Invalid show status.',400);
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
  requireValue(title.trim().length>0 && titleBn.trim().length>0 && troupe.trim().length>0 && synopsis.trim().length>0 && synopsisBn.trim().length>0 && genre.trim().length>0,
   'Title, troupe, synopsis and genre are required.',400);
  const updated=(await one<Show>(c,`UPDATE shows SET title=$1,title_bn=$2,troupe=$3,synopsis=$4,synopsis_bn=$5,starts_at=$6,ends_at=$7,runtime=$8,genre=$9,language=$10,status=$11,artwork=$12
   WHERE id=$13 RETURNING *`,
   [title,titleBn,troupe,synopsis,synopsisBn,startsAt.toISOString(),endsAt.toISOString(),runtime,genre,language,status,artwork,id]))!;
  await audit(c,user.id,'show.update',id,input);
  return updated;
 },true);
}
