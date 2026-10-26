// Esc in the framed checkout: tendr.js's modal cannot see keys pressed inside this cross-origin
// frame, so the checkout asks it to close (`tendr:close`). Only in the modal (tendr.js adds
// `?embed=modal` to the frame's URL; the widget and the hosted page never close on Esc), and only
// when nothing inside the checkout wanted that Esc: a wallet modal, a dialog, a select, or any
// handler that already called preventDefault.

/** Whether the checkout is tendr.js's modal (from `location.search`). */
export function isModalEmbed(search: string): boolean {
  return new URLSearchParams(search).get('embed') === 'modal';
}

/** Open overlays inside the checkout that Esc belongs to (NEAR wallet selector, dialogs). */
const OPEN_OVERLAYS = 'dialog[open], [aria-modal="true"], .nws-modal-wrapper.open';

export function shouldForwardEscape(
  e: {
    key: string;
    defaultPrevented: boolean;
    target: unknown;
  },
  opts: {
    modal: boolean;
    /** Reown AppKit's modal is open (lib/wallets/modal-state.ts). */
    walletModalOpen: boolean;
    doc: { querySelector(selector: string): unknown };
  },
): boolean {
  if (!opts.modal || e.key !== 'Escape' || e.defaultPrevented || opts.walletModalOpen) {
    return false;
  }
  const target = e.target as { closest?: (s: string) => unknown } | null;
  if (target && typeof target.closest === 'function' && target.closest('select')) return false;
  return !opts.doc.querySelector(OPEN_OVERLAYS);
}
