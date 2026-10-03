import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { applySecurityHeaders } from '@/lib/security-headers';

/** Vinext drops next.config headers on Workers — apply them here so production gets CSP. */
export default clerkMiddleware(() => {
  const response = NextResponse.next();
  applySecurityHeaders(response.headers);
  return response;
});

/** Vinext's matcher validator rejects complex Clerk defaults — keep paths simple. */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/|uploads/|api/catalogue|api/health|api/payments/webhook).*)'],
};
