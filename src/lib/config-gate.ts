import { coreConfigurationProblems, salesConfigurationProblems } from './env';

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
 * Why an API request must be refused before any handler runs, or null.
 * Broken core settings stop everything; missing customer-sales settings stop
 * every API except staff/internal ones ("sales readiness controls customer
 * sales, not internal administration"). Customer purchase functions also
 * re-check the full set themselves (assertLiveConfiguration).
 */
export function apiRefusal(pathname: string): string | null {
  if (!pathname.startsWith('/api/')) return null;
  if (coreConfigurationProblems().length > 0) return 'This service is not configured yet. Please try again later.';
  if (salesConfigurationProblems().length > 0 && !isStaffApi(pathname)) {
    return 'This service is not configured for sales yet. Please try again later.';
  }
  return null;
}
