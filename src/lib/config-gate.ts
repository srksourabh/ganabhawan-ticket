import { coreConfigurationProblems, customerConfigurationProblems, paymentConfigurationProblems } from './env';

/**
 * Staff and internal-operations APIs: usable whenever the core settings are
 * valid, even before customer sales are configured (payments, SMS, email).
 * Every handler still authenticates and checks roles itself.
 */
export const STAFF_API_PREFIXES = [
  '/api/auth/password', // staff sign-in (both doors)
  '/api/auth/logout',
  '/api/auth/me',
  '/api/admin/',
  '/api/admission/', // gate scanning
  '/api/ops/',
  '/api/posters/', // admin-uploaded images
] as const;

export function isStaffApi(pathname: string) {
  return STAFF_API_PREFIXES.some((prefix) => (prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix));
}

/**
 * The APIs that take a payment: holds, creating a checkout (not reading one), and payment
 * orders/confirmation/sync. The Razorpay webhook is outside the proxy matcher.
 */
export const PURCHASE_API_PATHS = ['/api/holds', '/api/checkouts', '/api/payments/'] as const;

export function isPurchaseApi(pathname: string) {
  return PURCHASE_API_PATHS.some((path) => (path.endsWith('/') ? pathname.startsWith(path) : pathname === path));
}

/**
 * Why an API request must be refused before any handler runs, or null.
 * Broken core settings stop everything. Missing customer settings (sign-in codes, email, Clerk,
 * worker) stop every API except staff/internal ones ("sales readiness controls customer sales,
 * not internal administration"). Missing or invalid PAYMENT settings stop only the purchase APIs:
 * customers can still sign in, see their account, tickets and receipts. Customer purchase
 * functions also re-check the full set themselves (assertLiveConfiguration).
 */
export function apiRefusal(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null;
  if (coreConfigurationProblems().length > 0) return 'This service is not configured yet. Please try again later.';
  if (isStaffApi(pathname)) return null;
  if (customerConfigurationProblems().length > 0) return 'This service is not configured for sales yet. Please try again later.';
  if (paymentConfigurationProblems().length > 0 && isPurchaseApi(pathname)) {
    return 'Ticket sales are not open yet. Please try again later.';
  }
  return null;
}
