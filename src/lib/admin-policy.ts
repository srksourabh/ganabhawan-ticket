import type { Role } from './types';

/**
 * Who may use each admin area. The API routes enforce these server-side
 * (authenticated → assertRole); the dashboard only mirrors them to hide tabs.
 * The owner always passes (assertRole).
 */
export const ADMIN_POLICY = {
  catalogue: ['owner', 'inventory'],
  inventory: ['owner', 'inventory'],
  staff: ['owner'],
  metrics: ['owner', 'inventory', 'finance'],
} as const satisfies Record<string, readonly Role[]>;

/** Gate staff roles (they sign in at /gate/login). */
export const GATE_ROLES: readonly Role[] = ['scanner', 'supervisor'];
/** Roles the owner can create, reset and deactivate from the dashboard. Owners are managed with the operator CLI only. */
export const MANAGEABLE_STAFF_ROLES: readonly Role[] = ['scanner', 'supervisor', 'inventory', 'finance', 'desk'];
