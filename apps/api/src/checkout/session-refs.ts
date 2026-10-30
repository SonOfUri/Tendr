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
