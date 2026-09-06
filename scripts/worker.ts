import { config } from 'dotenv';
config({ path: '.env.local' });

import { processJobs } from '../src/lib/jobs';
import { expireHolds } from '../src/lib/commerce';

async function main() {
  console.log('[worker] starting');
  try {
    await expireHolds();
    const processed = await processJobs(50);
    console.log(`[worker] processed ${processed} job(s)`);
  } catch (err) {
    console.error('[worker] error', err);
    process.exit(1);
  }
  process.exit(0);
}

main();
