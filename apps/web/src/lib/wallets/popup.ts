// The wallet step in a popup window, for when a wallet cannot work inside the store's frame
// (popup blocked, deep link refused, no injected wallet reachable from the frame).
//
// - The framed checkout opens `/pay/<id>?wallet=1#cs=<secret>` with window.open (from the
//   shopper's click). The fragment never reaches a server; the boot script strips it on load.
// - The popup completes the wallet step and posts `{ type: 'tendr:wallet-done', sessionId, txHash }`
//   to its opener on Tendr's own origin (never '*', never the store's origin), then closes.
// - The opener accepts it only when `event.origin` is its own origin AND `event.source` is the
//   popup it opened. The message only reports a hash; nothing is marked paid by it.

export const WALLET_DONE = 'tendr:wallet-done';

export interface WalletDoneMessage {
  type: typeof WALLET_DONE;
  sessionId: string;
  txHash: string;
}

export interface PopupWindow {
  location: { origin: string };
  open(url: string, target: string, features: string): Window | null;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}

const HASH = /^[\x21-\x7e]{1,256}$/;

export function walletWindowUrl(origin: string, sessionId: string, secret: string): string {
  return `${origin}/pay/${encodeURIComponent(sessionId)}?wallet=1#cs=${encodeURIComponent(secret)}`;
}

/** Opens the wallet window (call from a click). Null when the browser blocked it. */
export function openWalletWindow(
  win: PopupWindow,
  sessionId: string,
  secret: string,
): Window | null {
  try {
    return win.open(
      walletWindowUrl(win.location.origin, sessionId, secret),
      'tendr-wallet',
      'popup,width=440,height=760',
    );
  } catch {
    return null;
  }
}

/** In the popup: tells the opener the transaction was sent. False when there is no opener. */
export function postWalletDone(
  win: {
    location: { origin: string };
    opener: { postMessage(m: unknown, origin: string): void } | null;
  },
  sessionId: string,
  txHash: string,
): boolean {
  if (!win.opener) return false;
  const msg: WalletDoneMessage = { type: WALLET_DONE, sessionId, txHash };
  try {
    win.opener.postMessage(msg, win.location.origin);
    return true;
  } catch {
    return false;
  }
}

/** In the opener: calls `onDone(txHash)` for the popup's message. Returns the unsubscribe. */
export function listenForWalletDone(
  win: PopupWindow,
  popup: Window,
  sessionId: string,
  onDone: (txHash: string) => void,
): () => void {
  const handler = (e: MessageEvent) => {
    if (e.origin !== win.location.origin || e.source !== popup) return;
    const d = e.data as Partial<WalletDoneMessage> | null;
    if (!d || typeof d !== 'object' || d.type !== WALLET_DONE || d.sessionId !== sessionId) return;
    if (typeof d.txHash !== 'string' || !HASH.test(d.txHash)) return;
    onDone(d.txHash);
  };
  win.addEventListener('message', handler);
  return () => win.removeEventListener('message', handler);
}

/** This page is the wallet window (`?wallet=1`). */
export function isWalletWindow(search: string): boolean {
  return new URLSearchParams(search).get('wallet') === '1';
}

/** Inside a frame (a cross-origin `top` that throws counts as framed). */
export function isFramed(win: { self: unknown; top: unknown }): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}
