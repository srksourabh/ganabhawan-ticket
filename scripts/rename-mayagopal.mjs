/**
 * Rename Dec 29 Mayagopal → Jatra Gopal (EN + BN) without wiping bookings.
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const result = await client.query(
  `UPDATE shows
   SET title = 'Jatra Gopal',
       title_bn = 'যাত্রা গোপাল'
   WHERE title IN ('Mayagopal', 'Maya Gopal', 'MayaGopal')
      OR title_bn IN ('মায়াগোপাল', 'মায়া গোপাল')
   RETURNING id, title, title_bn, starts_at`,
);

for (const row of result.rows) {
  console.log('updated', row.id, row.title, row.title_bn, row.starts_at);
}
console.log(`Done. ${result.rowCount} show row(s) updated.`);
await client.end();
