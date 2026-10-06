'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { FESTIVAL, FESTIVAL_BN } from '@/lib/brand';
import { dateLocale } from '@/lib/i18n';
import { completeBookingPayment, prefillFromContact } from '@/lib/razorpay-checkout';

const money = (paise: number, locale: string) => `₹${(paise / 100).toLocaleString(locale)}`;

export default function PayBookingButton({
  bookingId,
  amount,
  description,
  contact,
  name,
}: {
  bookingId: string;
  amount: number;
  description: string;
  contact?: string;
  name?: string;
}) {
  const router = useRouter();
  const { locale, t } = useLocale();
  const dl = dateLocale(locale);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const festivalName = locale === 'bn' ? FESTIVAL_BN : FESTIVAL;

  async function pay() {
    setError('');
    setLoading(true);
    try {
      await completeBookingPayment(bookingId, {
        name: festivalName,
        description,
        ...prefillFromContact(contact, name),
        prefillEmail: contact?.includes('@') ? contact : undefined,
        prefillContact: contact && !contact.includes('@') ? contact : undefined,
        prefillName: name,
      });
      router.refresh();
    } catch (err) {
      const refund = err instanceof Error && err.message === 'REFUND_REQUIRED';
      setError(refund ? t('pay.refunded') : err instanceof Error && /cancelled/i.test(err.message) ? t('pay.cancelled') : err instanceof Error ? err.message : t('pay.failed'));
      if (refund) router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="stack stack--sm">
      {error && <p role="alert" className="banner banner--err">{error}</p>}
      <button type="button" className="btn btn--primary" disabled={loading} onClick={pay}>
        {loading ? t('book.processing') : t('book.payRazorpay', { amount: money(amount, dl) })}
      </button>
    </div>
  );
}
