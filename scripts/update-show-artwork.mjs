/**
 * Point existing published shows at local poster paths without wiping bookings.
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });

const ARTWORK_BY_TITLE = {
  'Samatat prologue (title TBA)': '/images/samatat/shows/samatat-double-bill.jpg',
  'Macbeth Two': '/images/samatat/shows/macbeth-two.jpg',
  Goraibabu: '/images/samatat/shows/goraibabu.jpg',
  Asakti: '/images/samatat/shows/asakti.jpg',
  'Babu Jana Dui': '/images/samatat/shows/actor-anjana-basu.jpg',
  'Pratham Partha': '/images/samatat/shows/pratham-partha.png',
  Kundubabu: '/images/samatat/shows/samatat-double-bill.jpg',
  Kirtankhola: '/images/samatat/shows/kirtankhola.jpg',
  'Angina Jure Bhor': '/images/samatat/shows/angina-jure-bhor.jpg',
  "Samatat's new play (title TBA)": '/images/samatat/shows/samatat-double-bill.jpg',
  'Padma Nodir Majhi': '/images/samatat/shows/macbeth-two-still.jpg',
  'Jatra Gopal': '/images/samatat/shows/jatra-gopal.jpg',
  'Jiboner Chawa-Pawa': '/images/samatat/shows/jatra-gopal-still.jpg',
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let updated = 0;
for (const [title, artwork] of Object.entries(ARTWORK_BY_TITLE)) {
  const result = await client.query('UPDATE shows SET artwork=$1 WHERE title=$2 RETURNING id, title', [artwork, title]);
  if (result.rowCount) {
    updated += result.rowCount;
    console.log('updated', title, '→', artwork);
  } else {
    console.log('skip (not found)', title);
  }
}
await client.end();
console.log(`Done. ${updated} show row(s) updated.`);
