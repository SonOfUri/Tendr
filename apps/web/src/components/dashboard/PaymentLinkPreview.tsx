'use client';

/** Live “checkout link” mock shown while creating/editing a payment link. */
export function PaymentLinkPreview({
  merchantName,
  title,
  amountType,
  amount,
  minAmount,
  currency = 'USD',
}: {
  merchantName: string;
  title: string;
  amountType: 'fixed' | 'open';
  amount: string;
  minAmount?: string;
  currency?: string;
}) {
  const displayTitle = title.trim() || 'Payment link title';
  const initial = (merchantName.trim()[0] ?? 'T').toUpperCase();
  const amountLine =
    amountType === 'fixed'
      ? amount.trim()
        ? `${amount.trim()} ${currency}`
        : `0.00 ${currency}`
      : minAmount?.trim()
        ? `Pay any amount · min ${minAmount.trim()} ${currency}`
        : 'Pay any amount';

  return (
    <aside className="dash-link-preview" aria-label="Checkout link preview">
      <p className="dash-link-preview-label">Checkout preview</p>
      <div className="dash-link-preview-card">
        <div className="dash-link-preview-merchant">
          <span className="dash-link-preview-mark" aria-hidden>
            {initial}
          </span>
          <span>{merchantName || 'Your business'}</span>
        </div>
        <h3 className="dash-link-preview-title">{displayTitle}</h3>
        <p className="dash-link-preview-amount">{amountLine}</p>
        <div className="dash-link-preview-pay" aria-hidden>
          Continue to payment
        </div>
      </div>
      <p className="dash-muted dash-small">
        Updates as you edit. Customers see the real branded checkout on the payment link.
      </p>
    </aside>
  );
}
