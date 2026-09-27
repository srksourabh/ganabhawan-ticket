import { clerkMiddleware } from '@clerk/nextjs/server';

export default clerkMiddleware();

/** Vinext's matcher validator rejects complex Clerk defaults — keep paths simple. */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/|uploads/|api/catalogue|api/health|api/payments/webhook).*)'],
};
