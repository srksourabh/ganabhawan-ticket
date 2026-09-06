import { pool, transaction, one } from '../src/lib/db';
import { devMode } from '../src/lib/env';
import { audit } from '../src/lib/audit';
if(!devMode()) throw new Error('Synthetic seed is development-only.');
await transaction(async c=>{
 const existing=await one(c,'SELECT id FROM festivals LIMIT 1');
 if(existing) {
  await c.query(`UPDATE festivals SET name=$1, name_bn=$2, venue=$3, address=$4, theater_photo=$5 WHERE id=$6`,
   ['Samatat Sanskriti Theatre Festival','সমতট সংস্কৃতি নাট্যোৎসব','Ganabhawan','Uttarpara, West Bengal','/images/auditorium-two-floors.jpg',existing.id]);
  console.log('Updated festival branding (organisation Samatat Sanskriti; venue Ganabhawan).');
  return;
 }
 const festival=(await one(c,`INSERT INTO festivals(name,name_bn,venue,address,status,contact_email,terms,capacity_approved,policies_approved,theater_photo)
 VALUES('Samatat Sanskriti Theatre Festival','সমতট সংস্কৃতি নাট্যোৎসব','Ganabhawan','Uttarpara, West Bengal','PUBLISHED','festival@example.test','One person per ticket. Unnumbered seating within your section. No standard re-entry. Daily tickets cover one performance. Season passes cover only the listed performances. Presented by Samatat Sanskriti at Ganabhawan. Sample programme for development; public sales are not open.',true,true,'/images/auditorium-two-floors.jpg') RETURNING id`))!;
 const shows=[
 ['Raktakarabi','রক্তকরবী','A voice that refuses to be silenced. Tagore’s Nandini arrives in a kingdom built on gold, and reminds it how to be human.','সোনার রাজ্যে নন্দিনীর আগমন। রবীন্দ্রনাথের চিরকালীন নাটক, নতুন মঞ্চভাষায়।','2026-10-09T13:00:00Z',120,'Classic','red'],
 ['Dakghar','ডাকঘর','Through a little window, an entire world. A tender, luminous journey with Amal and his boundless imagination.','ছোট্ট জানালা দিয়ে এক বিশাল পৃথিবী। অমলের সঙ্গে কল্পনার পথে।','2026-10-10T11:00:00Z',85,'Poetic drama','ochre'],
 ['Bisarjan','বিসর্জন','Faith, power, and the price of devotion. A searching production of Tagore’s drama about the courage to question.','বিশ্বাস, ক্ষমতা আর প্রশ্ন করার সাহস নিয়ে রবীন্দ্রনাথের নাটক।','2026-10-10T14:00:00Z',110,'Drama','forest'],
 ['Achalayatan','অচলায়তন','When the walls begin to speak. An energetic closing performance about learning, freedom, and opening the doors.','শিক্ষা, মুক্তি আর বন্ধ দরজা খোলার এক প্রাণবন্ত মঞ্চায়ন।','2026-10-11T13:00:00Z',100,'Ensemble','blue'],
 ];
 const ids:string[]=[];
 for(const [title,bn,syn,synbn,start,runtime,genre,artwork] of shows) {
  const end=new Date(new Date(String(start)).getTime()+Number(runtime)*60000).toISOString();
  const show=(await one(c,'INSERT INTO shows(festival_id,title,title_bn,troupe,synopsis,synopsis_bn,starts_at,ends_at,runtime,genre,artwork) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',[festival.id,title,bn,'Festival Ensemble · sample programme',syn,synbn,start,end,runtime,genre,artwork]))!;
  ids.push(show.id);
 }
 for(const [zone,daily,season,ceiling,seasonRows] of [['Premier',500,1600,100,4],['Superior',350,1100,120,2],['Balcony',250,800,80,2]] as const) {
  const seasonProduct=(await one(c,'INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,$2,$3,$4,\'SEASON\',$5) RETURNING id',[festival.id,zone+' Season',zone==='Premier'?'প্রিমিয়ার সিজন':zone==='Superior'?'সুপিরিয়র সিজন':'ব্যালকনি সিজন',zone,season*100]))!;
  for(const showId of ids) {
   const cap=(await one(c,'INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,$2,$3) RETURNING id',[showId,zone,ceiling]))!;
   const dailyProduct=(await one(c,"INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,$2,$3,$4,'DAILY',$5,$6) RETURNING id",[festival.id,zone+' Daily',zone==='Premier'?'প্রিমিয়ার দৈনিক':zone==='Superior'?'সুপিরিয়র দৈনিক':'ব্যালকনি দৈনিক',zone,daily*100,showId]))!;
   for(const [kind,allocation,first,last,pid] of [['SEASON',30,1,seasonRows,seasonProduct.id],['DAILY',ceiling-40,seasonRows+1,12,dailyProduct.id]] as const) {
    const p=(await one(c,'INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,$2,$3,$4,$5) RETURNING id',[cap.id,kind,allocation,first,last]))!;
    await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)',[pid,showId,p.id]);
    await c.query("INSERT INTO movements(pool_id,operation,delta_allocation,reason) VALUES($1,'initial-allocation',$2,'Synthetic development fixture')",[p.id,allocation]);
   }
  }
 }
 await c.query("INSERT INTO devices(id,name) VALUES('gate-one','Main entrance'),('gate-two','Balcony entrance')");
 for(const role of ['owner','inventory','finance','desk','scanner','supervisor']) {
  const u=(await one(c,'INSERT INTO users(contact,name,role) VALUES($1,$2,$3) RETURNING id',[role+'@example.test',role==='owner'?'Festival team':role,role]))!;
  for(const s of ids) for(const device of ['gate-one','gate-two']) await c.query('INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,$3,$3)',[u.id,s,device]);
 }
 await audit(c,null,'development.seed',festival.id,{synthetic:true});
 console.log('Seeded sample programme, inventory and development staff accounts.');
});
await pool.end();
