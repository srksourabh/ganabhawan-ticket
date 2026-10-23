import { query } from '@/lib/db';
import { appMode, configurationProblems, coreConfigurationProblems, deployEnv, developmentAdaptersAllowed, mobileFeaturesEnabled, paymentMode, seasonTicketSalesEnabled } from '@/lib/env';
import { jsonOk } from '@/lib/http';

/**
 * Public liveness/readiness. Reports mode and booleans only, never names of
 * missing secrets or any value: staff = core settings, config = customer-sales
 * settings, publicSales = config + the ALLOW_PUBLIC_SALES switch, seasonSales = publicSales +
 * SEASON_TICKET_SALES_ENABLED, mobile = mobile features. 503 when the database is unreachable or the
 * configuration is unsafe (the proxy refuses API traffic in that state too).
 */
export async function GET(): Promise<Response> {
  // A hung connection must read as unhealthy, not hang the monitor: every query is bounded.
  const bounded = <T,>(work: Promise<T>) =>
    Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('db timeout')), 5000))]);
  let db = false;
  try {
    await bounded(query('SELECT 1'));
    db = true;
  } catch {
    db = false;
  }
  const config = configurationProblems().length === 0;
  // Customer sales are open only when the settings are valid AND the operator's switch is on
  // (the same ALLOW_PUBLIC_SALES rule as catalogue.ts/commerce.ts). Festival status is per festival, not here.
  const publicSales = config && (developmentAdaptersAllowed() || process.env.ALLOW_PUBLIC_SALES === 'true');
  // Staff sign-in, admin and gate scanning need only the core settings.
  const staff = coreConfigurationProblems().length === 0;
  // Customer mobile sign-in + SMS (MOBILE_PHONE_NUMBER_ENABLED and MSG91 complete). Not part of `ok`.
  const mobile = mobileFeaturesEnabled();
  // The deploy workflow does not migrate: report a schema behind what this code uses (0007 checkouts,
  // 0008 season allocations, 0009 account carts, 0010 sale windows and checkout contact details).
  let schema = false;
  if (db) {
    try {
      schema = (await bounded(query<{ ok: boolean }>(
        `SELECT to_regclass('public.checkouts') IS NOT NULL
           AND to_regclass('public.cart_items') IS NOT NULL
           AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='capacities' AND column_name='season_allocation')
           AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (table_name, column_name) IN
             (('shows','sales_closes_at'),('festivals','season_closes_at'),('bookings','holder_email'),('booking_attempts','email'))) = 4 AS ok`,
      )))[0]?.ok === true;
    } catch {
      schema = false;
    }
  }
  const ok = db && config && schema;
  // New season-ticket sales: public sales AND the operator's SEASON_TICKET_SALES_ENABLED.
  const seasonSales = publicSales && seasonTicketSalesEnabled();
  // Razorpay environment of new payments: "test" (no real money) or "live" (from the server's keys).
  return jsonOk({ ok, db, config, publicSales, seasonSales, staff, mobile, schema, paymentMode: paymentMode(), mode: appMode(), env: deployEnv() ?? 'local' }, ok ? 200 : 503);
}
