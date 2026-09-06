'use client';

import { AuthenticateWithRedirectCallback } from '@clerk/nextjs';
import { useLocale } from '@/components/LocaleProvider';

export default function SsoCallbackPage() {
  const { t } = useLocale();
  return (
    <main className="page-pad" style={{ textAlign: 'center' }}>
      <p className="muted">{t('sso.finishing')}</p>
      <AuthenticateWithRedirectCallback />
    </main>
  );
}
