import { pool, transaction, one } from '../src/lib/db';
import { devMode } from '../src/lib/env';
import { audit } from '../src/lib/audit';

if (!devMode()) throw new Error('Synthetic seed is development-only.');

/** Evening curtain in IST (Asia/Kolkata), stored as timestamptz. */
function istEvening(day: number, month = 12): string {
  return `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T18:30:00+05:30`;
}

/** Tentative Samatat Natyomela 2026 programme — Ganabhawan, Uttarpara. */
const PROGRAMME: {
  month?: number;
  day: number;
  title: string;
  titleBn: string;
  troupe: string;
  synopsis: string;
  synopsisBn: string;
  runtime: number;
  genre: string;
  artwork: string;
}[] = [
  {
    month: 10,
    day: 12,
    title: 'Samatat prologue (title TBA)',
    titleBn: 'সমতট প্রস্তাবনা (নাম চূড়ান্ত নয়)',
    troupe: 'সমতট',
    synopsis: 'October prologue to Samatat Natyomela 2026. Final title to be announced.',
    synopsisBn: 'সমতট নাট্যমেলা ২০২৬-এর অক্টোবর প্রস্তাবনা। নাম চূড়ান্ত হয়নি।',
    runtime: 110,
    genre: 'Prologue',
    artwork: '/images/samatat/shows/samatat-double-bill.jpg',
  },
  {
    day: 19,
    title: 'Macbeth Two',
    titleBn: 'ম্যাকবেথ টু',
    troupe: 'স্বপ্নসন্ধানী — কৌশিক সেন',
    synopsis: 'A searching take on Macbeth. Directed by Kaushik Sen for Swapnasandhani.',
    synopsisBn: 'ম্যাকবেথের নতুন মঞ্চভাষা। পরিচালনা: কৌশিক সেন — স্বপ্নসন্ধানী।',
    runtime: 120,
    genre: 'Drama',
    artwork: '/images/samatat/shows/macbeth-two.jpg',
  },
  {
    day: 20,
    title: 'Goraibabu',
    titleBn: 'গড়াইবাবু',
    troupe: 'থিয়েটার ওয়ার্কশপ — গৌতম হালদার',
    synopsis: 'Theatre Workshop presents Goraibabu, led by Gautam Haldar.',
    synopsisBn: 'থিয়েটার ওয়ার্কশপের গড়াইবাবু। পরিচালনা: গৌতম হালদার।',
    runtime: 120,
    genre: 'Drama',
    artwork: '/images/samatat/shows/goraibabu.jpg',
  },
  {
    day: 21,
    title: 'Asakti',
    titleBn: 'আসক্তি',
    troupe: 'পূর্ব-পশ্চিম — দেবশংকর হালদার',
    synopsis: 'Purba-Paschim presents Asakti, directed by Debshankar Haldar.',
    synopsisBn: 'পূর্ব-পশ্চিমের আসক্তি। পরিচালনা: দেবশংকর হালদার।',
    runtime: 110,
    genre: 'Drama',
    artwork: '/images/samatat/shows/asakti.jpg',
  },
  {
    day: 22,
    title: 'Babu Jana Dui',
    titleBn: 'বাবু জনা দুই',
    troupe: 'গড়িয়া আন্তরিক — দেবশংকর হালদার ও অঞ্জনা বসু',
    synopsis: 'Garia Antarik presents Babu Jana Dui, with Debshankar Haldar and Anjana Basu.',
    synopsisBn: 'গড়িয়া আন্তরিকের বাবু জনা দুই। দেবশংকর হালদার ও অঞ্জনা বসু।',
    runtime: 110,
    genre: 'Drama',
    artwork: '/images/samatat/shows/actor-anjana-basu.jpg',
  },
  {
    day: 23,
    title: 'Pratham Partha',
    titleBn: 'প্রথম পার্থ',
    troupe: 'সংস্কৃতি — রজতাভ দত্ত',
    synopsis: 'Sanskriti presents Pratham Partha, directed by Rajatava Dutta.',
    synopsisBn: 'সংস্কৃতির প্রথম পার্থ। পরিচালনা: রজতাভ দত্ত।',
    runtime: 120,
    genre: 'Drama',
    artwork: '/images/samatat/shows/pratham-partha.png',
  },
  {
    day: 24,
    title: 'Kundubabu',
    titleBn: 'কুণ্ডুবাবু',
    troupe: 'সায়ক — মেঘনাদ ভট্টাচার্য',
    synopsis: 'Sayak presents Kundubabu, directed by Meghnad Bhattacharya.',
    synopsisBn: 'সায়কের কুণ্ডুবাবু। পরিচালনা: মেঘনাদ ভট্টাচার্য।',
    runtime: 110,
    genre: 'Drama',
    artwork: '/images/samatat/shows/samatat-double-bill.jpg',
  },
  {
    day: 25,
    title: 'Kirtankhola',
    titleBn: 'কীর্তনখোলা',
    troupe: 'ইচ্ছেমতো — সৌরভ পালোধী',
    synopsis: 'Icchemato presents Kirtankhola, directed by Sourav Palodhi.',
    synopsisBn: 'ইচ্ছেমতোর কীর্তনখোলা। পরিচালনা: সৌরভ পালোধী।',
    runtime: 120,
    genre: 'Drama',
    artwork: '/images/samatat/shows/kirtankhola.jpg',
  },
  {
    day: 26,
    title: 'Angina Jure Bhor',
    titleBn: 'আঙিনা জুড়ে ভোর',
    troupe: 'অনীক',
    synopsis: 'Anik presents Angina Jure Bhor.',
    synopsisBn: 'অনীকের আঙিনা জুড়ে ভোর।',
    runtime: 100,
    genre: 'Drama',
    artwork: '/images/samatat/shows/angina-jure-bhor.jpg',
  },
  {
    day: 27,
    title: "Samatat's new play (title TBA)",
    titleBn: 'সমতটের নতুন নাটক (নাম চূড়ান্ত নয়)',
    troupe: 'সমতট',
    synopsis: 'A new Samatat production. Final title to be announced.',
    synopsisBn: 'সমতটের নতুন নাটক। নাম চূড়ান্ত হয়নি।',
    runtime: 120,
    genre: 'Drama',
    artwork: '/images/samatat/shows/samatat-double-bill.jpg',
  },
  {
    day: 28,
    title: 'Padma Nodir Majhi',
    titleBn: 'পদ্মা নদীর মাঝি',
    troupe: 'বাঘাযতীন আলাপ — পার্থপ্রতিম',
    synopsis: 'Baghayatin Alap presents Padma Nodir Majhi, directed by Parthapratim.',
    synopsisBn: 'বাঘাযতীন আলাপের পদ্মা নদীর মাঝি। পরিচালনা: পার্থপ্রতিম।',
    runtime: 120,
    genre: 'Drama',
    artwork: '/images/samatat/shows/macbeth-two-still.jpg',
  },
  {
    day: 29,
    title: 'Jatra Gopal',
    titleBn: 'যাত্রা গোপাল',
    troupe: 'চারদল নাট্যজন — সঞ্জীব সরকার',
    synopsis: 'Chardal Natyajan presents Jatra Gopal, directed by Sanjib Sarkar.',
    synopsisBn: 'চারদল নাট্যজনের যাত্রা গোপাল। পরিচালনা: সঞ্জীব সরকার।',
    runtime: 110,
    genre: 'Drama',
    artwork: '/images/samatat/shows/jatra-gopal.jpg',
  },
  {
    day: 30,
    title: 'Jiboner Chawa-Pawa',
    titleBn: 'জীবনের চাওয়া-পাওয়া',
    troupe: 'অগ্রগামী অপেরা — অনল–কাকলি',
    synopsis: 'Agragami Opera presents Jiboner Chawa-Pawa, with Anal–Kakali.',
    synopsisBn: 'অগ্রগামী অপেরার জীবনের চাওয়া-পাওয়া। অনল–কাকলি।',
    runtime: 120,
    genre: 'Opera',
    artwork: '/images/samatat/shows/jatra-gopal-still.jpg',
  },
];

const FESTIVAL_NAME = 'Samatat Natyomela 2026';
const FESTIVAL_NAME_BN = 'সমতট নাট্যমেলা ২০২৬';
const CONTACT_EMAIL = process.env.FESTIVAL_CONTACT_EMAIL || 'tickets@samatat.org';
const TERMS =
  'One person per ticket. Unnumbered seating within your section. No standard re-entry. Daily tickets cover one performance. Season passes cover only the listed performances, including the October prologue. Presented by Samatat Sanskriti at Ganabhawan, Uttarpara. Tentative programme October prologue + 19–30 December 2026; titles may change before publication.';

await transaction(async (c) => {
  let festival = await one<{ id: string }>(c, 'SELECT id FROM festivals LIMIT 1');

  if (festival) {
    await c.query(
      `UPDATE festivals SET name=$1, name_bn=$2, venue=$3, address=$4, theater_photo=$5, terms=$6, contact_email=$7, status='PUBLISHED', capacity_approved=true, policies_approved=true WHERE id=$8`,
      [
        FESTIVAL_NAME,
        FESTIVAL_NAME_BN,
        'Ganabhawan',
        'Uttarpara, West Bengal',
        '/images/auditorium-two-floors.jpg',
        TERMS,
        CONTACT_EMAIL,
        festival.id,
      ],
    );
    // Wipe synthetic programme so Dec 2026 can replace older sample shows.
    await c.query(`
      TRUNCATE
        admissions, scan_requests, entitlements, physical_issues, credentials, tickets,
        refunds, payments, payment_attempts, hold_allocations, bookings,
        product_coverage, movements, pools, capacities, products, staff_scopes, shows
      RESTART IDENTITY CASCADE
    `);
    console.log('Updated festival branding and cleared prior programme for re-seed.');
  } else {
    festival = (await one(
      c,
      `INSERT INTO festivals(name,name_bn,venue,address,status,contact_email,terms,capacity_approved,policies_approved,theater_photo)
       VALUES($1,$2,'Ganabhawan','Uttarpara, West Bengal','PUBLISHED',$3,$4,true,true,'/images/auditorium-two-floors.jpg')
       RETURNING id`,
      [FESTIVAL_NAME, FESTIVAL_NAME_BN, CONTACT_EMAIL, TERMS],
    ))!;
  }

  const ids: string[] = [];
  for (const play of PROGRAMME) {
    const start = istEvening(play.day, play.month ?? 12);
    const end = new Date(new Date(start).getTime() + play.runtime * 60000).toISOString();
    const show = (await one(
      c,
      `INSERT INTO shows(festival_id,title,title_bn,troupe,synopsis,synopsis_bn,starts_at,ends_at,runtime,genre,artwork,status,language)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PUBLISHED','Bengali') RETURNING id`,
      [
        festival.id,
        play.title,
        play.titleBn,
        play.troupe,
        play.synopsis,
        play.synopsisBn,
        start,
        end,
        play.runtime,
        play.genre,
        play.artwork,
      ],
    ))!;
    ids.push(show.id);
  }

  for (const [zone, daily, season, ceiling, seasonRows] of [
    ['Premier', 500, 1600, 100, 4],
    ['Superior', 350, 1100, 120, 2],
    ['Balcony', 250, 800, 80, 2],
  ] as const) {
    const seasonProduct = (await one(
      c,
      `INSERT INTO products(festival_id,name,name_bn,category,kind,price) VALUES($1,$2,$3,$4,'SEASON',$5) RETURNING id`,
      [
        festival.id,
        `${zone} Season`,
        zone === 'Premier' ? 'প্রিমিয়ার সিজন' : zone === 'Superior' ? 'সুপিরিয়র সিজন' : 'ব্যালকনি সিজন',
        zone,
        season * 100,
      ],
    ))!;
    for (const showId of ids) {
      const cap = (await one(c, 'INSERT INTO capacities(show_id,zone,ceiling) VALUES($1,$2,$3) RETURNING id', [
        showId,
        zone,
        ceiling,
      ]))!;
      const play = PROGRAMME[ids.indexOf(showId)]!;
      const dailyProduct = (await one(
        c,
        `INSERT INTO products(festival_id,name,name_bn,category,kind,price,show_id) VALUES($1,$2,$3,$4,'DAILY',$5,$6) RETURNING id`,
        [
          festival.id,
          `${play.title} – ${zone}`,
          `${play.titleBn} – ${zone}`,
          zone,
          daily * 100,
          showId,
        ],
      ))!;
      for (const [kind, allocation, first, last, pid] of [
        ['SEASON', 30, 1, seasonRows, seasonProduct.id],
        ['DAILY', ceiling - 40, seasonRows + 1, 12, dailyProduct.id],
      ] as const) {
        const p = (await one(
          c,
          'INSERT INTO pools(capacity_id,kind,allocation,row_start,row_end) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [cap.id, kind, allocation, first, last],
        ))!;
        await c.query('INSERT INTO product_coverage(product_id,show_id,pool_id) VALUES($1,$2,$3)', [
          pid,
          showId,
          p.id,
        ]);
        await c.query(
          `INSERT INTO movements(pool_id,operation,delta_allocation,reason) VALUES($1,'initial-allocation',$2,'Samatat Natyomela 2026 tentative programme')`,
          [p.id, allocation],
        );
      }
    }
  }

  const devices = await c.query('SELECT id FROM devices LIMIT 1');
  if (devices.rows.length === 0) {
    await c.query(`INSERT INTO devices(id,name) VALUES('gate-one','Main entrance'),('gate-two','Balcony entrance')`);
  }

  for (const role of ['owner', 'inventory', 'finance', 'desk', 'scanner', 'supervisor']) {
    let u = await one<{ id: string }>(c, 'SELECT id FROM users WHERE contact=$1', [`${role}@example.test`]);
    if (!u) {
      u = (await one(
        c,
        'INSERT INTO users(contact,name,role) VALUES($1,$2,$3) RETURNING id',
        [role + '@example.test', role === 'owner' ? 'Festival team' : role, role],
      ))!;
    }
    for (const s of ids) {
      for (const device of ['gate-one', 'gate-two']) {
        await c.query(
          `INSERT INTO staff_scopes(user_id,show_id,gate,device_id) VALUES($1,$2,$3,$3)
           ON CONFLICT DO NOTHING`,
          [u.id, s, device],
        );
      }
    }
  }

  await audit(c, null, 'development.seed', festival.id, {
    synthetic: true,
    festival: FESTIVAL_NAME,
    shows: PROGRAMME.length,
    window: '2026-10-12 + 2026-12-19..2026-12-30',
  });
  console.log(`Seeded ${FESTIVAL_NAME}: ${PROGRAMME.length} plays, Oct prologue + 19–30 Dec 2026, inventory and staff scopes.`);
});
await pool.end();
