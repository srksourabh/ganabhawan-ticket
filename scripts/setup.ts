import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('.local', { recursive: true });
if (!existsSync('.env.local')) {
 const key = () => randomBytes(32).toString('hex');
 writeFileSync('.env.local', `DATABASE_URL=postgresql://festival:local-only@127.0.0.1:54329/festival\nAPP_URL=http://localhost:3000\nAPP_MODE=development\nPAYMENT_PROVIDER=development\nOTP_PROVIDER=development\nSESSION_SECRET=${key()}\nCREDENTIAL_KEY=${key()}\nCRON_SECRET=${key()}\nALLOW_PUBLIC_SALES=false\n`);
 console.log('Created private local environment. Next: npm run db:local, then npm run db:migrate and npm run db:seed.');
} else console.log('Existing .env.local preserved.');
