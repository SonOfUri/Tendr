/** Prepares a request only; no network call, passkey ceremony, or money movement. */
export function invoicePayoutStep(path: string, data: unknown): { payoutId: string } | null {
  const match = /^\/v1\/invoices\/([^/]+)\/payout$/.exec(path);
  if (!match || !data || typeof data !== 'object' || Array.isArray(data)) return null;
  const payout = data as Record<string, unknown>;
  let invoiceId: string;
  try {
    invoiceId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (
    payout.invoiceId !== invoiceId ||
    payout.status !== 'awaiting_signature' ||
    typeof payout.id !== 'string' ||
    !/^npay_[A-Za-z0-9]+$/.test(payout.id) ||
    typeof payout.expiresAt !== 'string' ||
    !(Date.parse(payout.expiresAt) > Date.now())
  )
    return null;
  return { payoutId: payout.id };
}
