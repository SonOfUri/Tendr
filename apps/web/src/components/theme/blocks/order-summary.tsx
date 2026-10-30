// The order summary block. Its content (line items, or a payment link's title and description)
// comes from the page as a slot; with nothing to show the block is hidden (spec §3.2).
import type { ReactNode } from 'react';

export function orderSummary(slot: ReactNode | undefined): ReactNode {
  if (slot === undefined || slot === null || slot === false) return null;
  return <div className="tdr-order-summary">{slot}</div>;
}
