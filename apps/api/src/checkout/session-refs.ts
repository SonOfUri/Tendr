// The references a session carries on every merchant-facing event payload (webhooks `data`): the
// store's own order reference, the payment link it was opened from, and the payer's note from the
// link's page. All three are always present, null when the session has none, so a consumer reads
// the same keys on every event of a session.
export type SessionRefsInput = {
  externalRef: string | null;
  paymentLinkId: string | null;
  payerNote: string | null;
};

export type SessionRefs = {
  external_ref: string | null;
  payment_link_id: string | null;
  payer_note: string | null;
};

export function sessionRefs(s: SessionRefsInput): SessionRefs {
  return {
    external_ref: s.externalRef,
    payment_link_id: s.paymentLinkId,
    payer_note: s.payerNote,
  };
}

/**
 * A session from a link's public page: it names a link and has no `external_ref`. A store-path
 * session (`POST /v1/checkout/sessions` with `payment_link_id`) always carries its order's ref and
 * keeps the store's own expiry, success/cancel URLs and email wording.
 */
export function publicLinkSession(s: {
  paymentLinkId: string | null;
  externalRef: string | null;
}): boolean {
  return s.paymentLinkId !== null && s.externalRef === null;
}

/** `publicLinkSession` as a Prisma session filter. */
export const PUBLIC_LINK_SESSION_WHERE = {
  paymentLinkId: { not: null },
  externalRef: null,
} as const;
