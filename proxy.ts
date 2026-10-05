import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { applySecurityHeaders } from '@/lib/security-headers';
import { configurationProblems } from '@/lib/env';

const clerk = clerkMiddleware(() => {
  const response = NextResponse.next();
  // Vinext drops next.config headers on Workers, so security headers are set here.
  applySecurityHeaders(response.headers);
  return response;
});

/**
 * Fail closed before anything else (including Clerk): if this runtime is
 * misconfigured (development adapters on a public host, missing payment,
 * webhook or session secrets…), every API call is refused with 503 before
 * any handler runs. /api/health (outside the matcher) reports the state.
 */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.nextUrl.pathname.startsWith('/api/') && configurationProblems().length > 0) {
    const refused = NextResponse.json(
      { error: 'This service is not configured for sales yet. Please try again later.', code: 'CONFIG_INVALID' },
      { status: 503 },
    );
    applySecurityHeaders(refused.headers);
    return refused;
  }
  return clerk(request, event);
}

/** Vinext's matcher validator rejects complex Clerk defaults — keep paths simple. */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/|uploads/|api/catalogue|api/health|api/payments/webhook).*)'],
};
