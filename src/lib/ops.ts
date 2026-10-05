import { query } from './db';
import { STALE_JOB_MINUTES } from './jobs';

/**
 * Operational signals for the owner/finance dashboard and an external uptime
 * monitor. Counts only: no contacts, payment ids or secrets.
 * `critical` lists conditions that can mean a customer's money is unresolved
 * or the background worker has stopped; the monitor endpoint returns 503 for them.
 */
export interface OpsStatus {
  generatedAt: string;
  jobs: { failed7d: number; stuckRunning: number; overduePending: number; lastDoneAt: string | null };
  payments: { openCases: number; unmatchedCaptures: number; livePending: number };
  refunds: { failed: number; processingOver7d: number; requestedOver1h: number };
  gate: { denied24h: number; unknown24h: number };
  auth: { staffMfaFailures24h: number; staffPasswordFailures24h: number };
  critical: string[];
}

export async function opsStatus(): Promise<OpsStatus> {
  const [row] = await query<Record<string, number | string | null>>(
    `SELECT
      (SELECT count(*) FROM jobs WHERE state='FAILED' AND run_at > now() - interval '7 days')::int AS failed7d,
      (SELECT count(*) FROM jobs WHERE state='RUNNING' AND locked_at < now() - ($1 * interval '1 minute'))::int AS stuck,
      (SELECT count(*) FROM jobs WHERE state='PENDING' AND run_at < now() - interval '15 minutes')::int AS overdue,
      (SELECT max(locked_at) FROM jobs WHERE state='DONE') AS last_done,
      (SELECT count(*) FROM reconciliation_cases WHERE state='OPEN')::int AS open_cases,
      (SELECT count(*) FROM reconciliation_cases WHERE state='OPEN' AND (key LIKE 'unknown-order:%' OR key LIKE 'webhook:%'))::int AS unmatched,
      (SELECT count(*) FROM bookings WHERE status='PAYMENT_PENDING' AND expires_at > now())::int AS live_pending,
      (SELECT count(*) FROM refunds WHERE state='FAILED')::int AS refunds_failed,
      (SELECT count(*) FROM refunds WHERE state='PROCESSING' AND created_at < now() - interval '7 days')::int AS refunds_slow,
      (SELECT count(*) FROM refunds WHERE state='REQUESTED' AND created_at < now() - interval '1 hour')::int AS refunds_stalled,
      (SELECT count(*) FROM scan_requests WHERE created_at > now() - interval '24 hours' AND result->>'result'='DENIED')::int AS denied,
      (SELECT count(*) FROM scan_requests WHERE created_at > now() - interval '24 hours' AND result->>'result'='UNKNOWN')::int AS unknown,
      (SELECT count(*) FROM audit_events WHERE action='auth.mfa.failed' AND created_at > now() - interval '24 hours')::int AS mfa_fail,
      (SELECT count(*) FROM audit_events WHERE action='auth.password.failed' AND created_at > now() - interval '24 hours')::int AS pw_fail`,
    [STALE_JOB_MINUTES],
  );
  const n = (key: string) => Number(row?.[key] ?? 0);
  const status: OpsStatus = {
    generatedAt: new Date().toISOString(),
    jobs: { failed7d: n('failed7d'), stuckRunning: n('stuck'), overduePending: n('overdue'), lastDoneAt: (row?.last_done as string | null) ?? null },
    payments: { openCases: n('open_cases'), unmatchedCaptures: n('unmatched'), livePending: n('live_pending') },
    refunds: { failed: n('refunds_failed'), processingOver7d: n('refunds_slow'), requestedOver1h: n('refunds_stalled') },
    gate: { denied24h: n('denied'), unknown24h: n('unknown') },
    auth: { staffMfaFailures24h: n('mfa_fail'), staffPasswordFailures24h: n('pw_fail') },
    critical: [],
  };
  if (status.payments.unmatchedCaptures) status.critical.push(`${status.payments.unmatchedCaptures} captured payment(s) not matched to a booking`);
  if (status.refunds.failed) status.critical.push(`${status.refunds.failed} refund(s) failed at the provider`);
  if (status.refunds.requestedOver1h) status.critical.push(`${status.refunds.requestedOver1h} refund(s) not sent to the provider within 1 hour`);
  if (status.jobs.stuckRunning || status.jobs.overduePending) status.critical.push('background worker is behind or stuck');
  if (status.jobs.failed7d) status.critical.push(`${status.jobs.failed7d} job(s) permanently failed in the last 7 days`);
  return status;
}
