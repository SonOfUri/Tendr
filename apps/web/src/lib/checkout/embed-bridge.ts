// Messages from a framed checkout to the store page that framed it (tendr.js listens for them).
//
// - Only when framed (`window.parent !== window`).
// - Only to the framing page's origin, taken from `document.referrer`, and only when that origin
//   is exactly one of the session's checkout domains. Never to '*'. Otherwise nothing is posted.
// - Only `{ type, sessionId, status }` (or `{ type: 'tendr:resize', sessionId, height }`): never
//   the client secret, a deposit address or an email.
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

/** The checkout's height in CSS px, so tendr.js can size its frame. */
export interface BridgeResizeMessage {
  type: 'tendr:resize';
  sessionId: string;
  height: number;
}

interface ResizeObserverLike {
  observe(el: never): void;
  disconnect(): void;
}

/** The parts of `window` the bridge uses. */
export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  document: { referrer: string };
  ResizeObserver?: new (cb: () => void) => ResizeObserverLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: never) => void;
}

/** The element whose height is reported (the checkout page's root). */
export interface MeasuredElement {
  getBoundingClientRect(): { height: number };
}

/** At most one `tendr:resize` per this many ms (the first at once, the latest at the end). */
export const RESIZE_THROTTLE_MS = 100;

export interface EmbedBridge {
  /** Whether the page is inside a frame. */
  readonly framed: boolean;
  /** The origin messages go to, or null when nothing is posted. */
  readonly targetOrigin: string | null;
  ready(status: BridgeStatus | null): void;
  /** Posts `tendr:status` when the status changed, plus `tendr:complete` once on `settled`. */
  status(status: BridgeStatus | null): void;
  close(): void;
  /**
   * Posts `tendr:resize` with `el`'s height now and whenever it changes (throttled). Returns a
   * function that stops it. Does nothing when nothing may be posted, or without ResizeObserver.
   */
  watchHeight(el: MeasuredElement): () => void;
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

  const send = (message: BridgeMessage | BridgeResizeMessage) => {
    if (targetOrigin === null) return;
    try {
      win.parent.postMessage(message, targetOrigin);
    } catch {
      // The parent went away; nothing to tell.
    }
  };
  const post = (type: BridgeMessageType, status: BridgeStatus | null) =>
    send({ type, sessionId, status });

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
    watchHeight(el) {
      const RO = win.ResizeObserver;
      const setT = win.setTimeout;
      const clearT = win.clearTimeout;
      if (targetOrigin === null || !RO || !setT || !clearT) return () => {};

      let sent = -1;
      let timer: unknown = null;
      let stopped = false;
      const report = () => {
        const height = Math.ceil(el.getBoundingClientRect().height);
        if (!(height >= 0) || height === sent) return;
        sent = height;
        send({ type: 'tendr:resize', sessionId, height });
      };
      // A leading post, then at most one more per window, carrying the latest height.
      const changed = () => {
        if (stopped || timer !== null) return;
        report();
        timer = setT.call(
          win,
          () => {
            timer = null;
            if (!stopped) report();
          },
          RESIZE_THROTTLE_MS,
        );
      };
      const observer = new RO(changed);
      observer.observe(el as never);
      changed();
      return () => {
        stopped = true;
        observer.disconnect();
        if (timer !== null) clearT.call(win, timer as never);
        timer = null;
      };
    },
  };
}
