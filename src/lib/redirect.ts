/** Same-origin path only. Reject protocol-relative and absolute URLs. */
export function safeNextPath(value: string | null | undefined, fallback = '/catalogue'): string {
  if (!value) return fallback;
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('://')) return fallback;
  return path;
}
