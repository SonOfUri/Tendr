// Messages from a framed checkout to the store page that framed it (tendr.js listens for them).
//
// - Only when framed (`window.parent !== window`).
// - Only to the framing page's origin, taken from `document.referrer`, and only when that origin
//   is exactly one of the session's checkout domains. Never to '*'. Otherwise nothing is posted.
// - Only `{ type, sessionId, status }`: never the client secret, a deposit address or an email.
//
// The events are informational. A store must rely on its webhook, never on these, to mark an
// order paid.

/** The status values the store sees. */
export type BridgeStatus =
  'pending' | 'detected' | 'converting' | 'settled' | 'refunded' | 'expired' | 'held';

export type BridgeMessageType = 'tendr:ready' | 'tendr:status' | 'tendr:complete' | 'tendr:close';

export interface BridgeMessage {
  type: BridgeMessageType;
  sessionId: string;
  status: BridgeStatus | null;
}

/** The parts of `window` the bridge uses. */
export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  document: { referrer: string };
}

export interface EmbedBridge {
  /** Whether the page is inside a frame. */
  readonly framed: boolean;
  /** The origin messages go to, or null when nothing is posted. */
  readonly targetOrigin: string | null;
  ready(status: BridgeStatus | null): void;
  /** Posts `tendr:status` when the status changed, plus `tendr:complete` once on `settled`. */
  status(status: BridgeStatus | null): void;
  close(): void;
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

export function createEmbedBridge(opts: {
  win: BridgeWindow;
  sessionId: string;
  checkoutDomains: readonly string[];
}): EmbedBridge {
  const { win, sessionId } = opts;
  const framed = (win.parent as unknown) !== (win as unknown);
  const referrerOrigin = framed ? originOf(win.document.referrer) : null;
  const targetOrigin =
    referrerOrigin !== null && opts.checkoutDomains.includes(referrerOrigin)
      ? referrerOrigin
      : null;

  let last: BridgeStatus | null | undefined;
  let completed = false;

  const post = (type: BridgeMessageType, status: BridgeStatus | null) => {
    if (targetOrigin === null) return;
    const message: BridgeMessage = { type, sessionId, status };
    try {
      win.parent.postMessage(message, targetOrigin);
    } catch {
      // The parent went away; nothing to tell.
    }
  };

  const completeOnce = (status: BridgeStatus | null) => {
    if (status !== 'settled' || completed) return;
    completed = true;
    post('tendr:complete', status);
  };

  return {
    framed,
    targetOrigin,
    ready(status) {
      last = status;
      post('tendr:ready', status);
      completeOnce(status);
    },
    status(status) {
      if (status === last) return;
      last = status;
      post('tendr:status', status);
      completeOnce(status);
    },
    close() {
      post('tendr:close', last ?? null);
    },
  };
}
