import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { applySecurityHeaders } from '@/lib/security-headers';
import { apiRefusal } from '@/lib/config-gate';

const clerk = clerkMiddleware(() => {
  const response = NextResponse.next();
  // Vinext drops next.config headers on Workers, so security headers are set here.
  applySecurityHeaders(response.headers);
  return response;
});

/**
 * Fail closed before anything else (including Clerk). Broken core settings
 * (session/encryption keys, database, public URL, development adapters on a
 * public host…) refuse every API call; missing customer-sales settings
 * (payments, SMS, email…) refuse every API except staff sign-in, admin and gate
 * scanning (config-gate.ts). /api/health (outside the matcher) reports the state.
 */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const refusal = apiRefusal(request.nextUrl.pathname);
  if (refusal) {
    const refused = NextResponse.json({ error: refusal, code: 'CONFIG_INVALID' }, { status: 503 });
    applySecurityHeaders(refused.headers);
    return refused;
  }
  return clerk(request, event);
}

/** Vinext's matcher validator rejects complex Clerk defaults — keep paths simple. */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/|uploads/|api/catalogue|api/health|api/payments/webhook).*)'],
};
