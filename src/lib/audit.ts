import type { Client } from './db';
export async function audit(c: Client, actor: string | null, action: string, entity: string, detail: unknown = {}) {
 await c.query('INSERT INTO audit_events(actor_id,action,entity,detail) VALUES($1,$2,$3,$4)', [actor, action, entity, JSON.stringify(detail)]);
}
export async function job(c: Client, kind: string, key: string, payload: unknown) {
 await c.query('INSERT INTO jobs(kind,key,payload) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING', [kind,key,JSON.stringify(payload)]);
}
