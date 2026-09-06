'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect, useRef } from 'react';

/** After Clerk (Google) sign-in, link the Clerk user into the festival users table. */
export default function ClerkSync() {
  const { isSignedIn, userId } = useAuth();
  const synced = useRef<string | null>(null);

  useEffect(() => {
    if (!isSignedIn || !userId || synced.current === userId) return;
    synced.current = userId;
    fetch('/api/auth/clerk/sync', { method: 'POST' }).catch(() => {
      synced.current = null;
    });
  }, [isSignedIn, userId]);

  return null;
}
