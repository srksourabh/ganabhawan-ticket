'use client';

import { useLocale } from '@/components/LocaleProvider';

export default function CatalogueLoading() {
  const { t } = useLocale();
  return (
    <main className="page-pad">
      <p className="container muted" role="status">
        {t('catalogue.loading')}
      </p>
    </main>
  );
}
