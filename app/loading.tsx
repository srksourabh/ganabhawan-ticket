'use client';

import { useLocale } from '@/components/LocaleProvider';

export default function RootLoading() {
  const { t } = useLocale();
  return (
    <main className="page-pad">
      <p className="container muted" role="status">
        {t('loading.page')}
      </p>
    </main>
  );
}
