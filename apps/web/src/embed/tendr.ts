// tendr.js: the script a store puts on its site to show Tendr's checkout as a modal or an inline
// widget. Built by scripts/build-embed.mjs into public/v1/tendr.js (no dependencies, < 10 KB).
//
//   Tendr.open({ sessionUrl, onEvent })        an overlay dialog; closes on Esc or tendr:close
//   Tendr.mount(el, { sessionUrl, onEvent })   an inline frame that takes the checkout's height
//
// - `sessionUrl` is the session's `url` from the API, used unchanged as the frame's src (its
//   `#cs=` fragment carries the client secret to the checkout). It must be a checkout page on
//   CHECKOUT_BASE_URL's origin, or this throws.
// - Messages are accepted only from CHECKOUT_BASE_URL's origin AND from this embed's own frame
//   (`event.source === iframe.contentWindow`), for this session; everything else is ignored.
// - The events are informational. A store must mark orders paid from its webhook, never from these.
// - Elements are built with createElement / setAttribute only, never innerHTML.

export type TendrStatus = string | null;

export type TendrEvent =
  | { type: 'ready' | 'status' | 'complete'; sessionId: string; status: TendrStatus }
  | { type: 'close' };

export interface TendrOptions {
  sessionUrl: string;
  onEvent?: (event: TendrEvent) => void;
}

export interface Tendr {
  /** The inline widget, inside `el`. */
  mount(el: Element, opts: TendrOptions): { unmount(): void };
  /** The modal. Opening another closes this one. */
  open(opts: TendrOptions): { close(): void };
}

/** A checkout page: `/<session id>` (the pay host's form) or the old `/pay/<session id>`. */
const SESSION_PATH = /^(?:\/pay)?\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/?$/;
/** Highest frame height a checkout may ask for, in CSS px. */
const MAX_HEIGHT = 5000;
const FRAME_TITLE = 'Tendr checkout';

export function createTendr(win: Window, baseUrl: string): Tendr {
  let origin: string;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0;
    origin = u.origin;
  } catch {
    throw new Error('Tendr: invalid checkout base URL');
  }
  const doc = win.document;
  let closeModal: (() => void) | null = null;

  /** The session id of a valid checkout link on our origin; throws otherwise. */
  function sessionOf(sessionUrl: unknown): string {
    let id: string | undefined;
    try {
      const u = new URL(sessionUrl as string);
      if (u.origin === origin) id = SESSION_PATH.exec(u.pathname)?.[1];
    } catch {
      // Falls through to the error.
    }
    if (typeof sessionUrl !== 'string' || !id) {
      throw new Error(`Tendr: sessionUrl must be a checkout link on ${origin}`);
    }
    return id;
  }

  /** A frame for the session, plus its message listener (`stop` removes the listener). */
  function frame(opts: TendrOptions, onClose: () => void, src = opts.sessionUrl) {
    const sessionId = sessionOf(opts.sessionUrl);
    const iframe = doc.createElement('iframe');
    iframe.setAttribute('src', src);
    iframe.setAttribute('title', FRAME_TITLE);
    iframe.setAttribute('allow', 'clipboard-write');
    // The checkout posts only to the origin in its document.referrer: send at least the origin,
    // even from a store page whose own policy is no-referrer or same-origin.
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.style.cssText = 'display:block;width:100%;height:640px;border:0;background:transparent';

    const emit = (e: TendrEvent) => {
      try {
        opts.onEvent?.(e);
      } catch {
        // The store's handler failing must not break the checkout.
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || !e.source || e.source !== iframe.contentWindow) return;
      const d = e.data as {
        type?: unknown;
        sessionId?: unknown;
        status?: unknown;
        height?: unknown;
      };
      if (!d || typeof d !== 'object' || d.sessionId !== sessionId) return;
      const status = typeof d.status === 'string' ? d.status : null;
      switch (d.type) {
        case 'tendr:ready':
        case 'tendr:status':
        case 'tendr:complete':
          emit({ type: d.type.slice(6) as 'ready', sessionId, status });
          break;
        case 'tendr:resize': {
          const h = d.height;
          if (typeof h === 'number' && h > 0 && h < Infinity) {
            iframe.style.height = `${Math.min(Math.ceil(h), MAX_HEIGHT)}px`;
          }
          break;
        }
        case 'tendr:close':
          onClose();
          break;
      }
    };
    win.addEventListener('message', onMessage as EventListener);
    return {
      iframe,
      emit,
      stop: () => win.removeEventListener('message', onMessage as EventListener),
    };
  }

  return {
    mount(el, opts) {
      if (!el || typeof (el as Node).appendChild !== 'function') {
        throw new Error('Tendr: mount needs an element');
      }
      const f = frame(opts, () => f.emit({ type: 'close' }));
      el.appendChild(f.iframe);
      return {
        unmount() {
          f.stop();
          f.iframe.remove();
        },
      };
    },

    open(opts) {
      sessionOf(opts.sessionUrl);
      closeModal?.();
      const body = doc.body;
      const opener = doc.activeElement as HTMLElement | null;
      const overflow = body.style.overflow;

      const overlay = doc.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', FRAME_TITLE);
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;' +
        'justify-content:center;overflow:auto;padding:16px;box-sizing:border-box;' +
        'background:rgba(5,8,18,.72)';

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        f.stop();
        doc.removeEventListener('keydown', onKey);
        doc.removeEventListener('focusin', onFocusIn);
        overlay.remove();
        body.style.overflow = overflow;
        if (closeModal === close) closeModal = null;
        try {
          if (opener && opener.isConnected) opener.focus();
        } catch {
          // Nothing to give focus back to.
        }
        f.emit({ type: 'close' });
      };
      // `?embed=modal` (never touching the #cs fragment) tells the checkout it may close on Esc.
      const hash = opts.sessionUrl.indexOf('#');
      const path = hash < 0 ? opts.sessionUrl : opts.sessionUrl.slice(0, hash);
      const src = `${path}${path.includes('?') ? '&' : '?'}embed=modal${
        hash < 0 ? '' : opts.sessionUrl.slice(hash)
      }`;
      const f = frame(opts, close, src);
      // ~2× the original 480px modal; checkout content keeps its own width.
      f.iframe.style.width = '100%';
      f.iframe.style.maxWidth = '960px';
      f.iframe.style.borderRadius = '16px';

      // The overlay's own close control: it works even when the checkout cannot talk to this page
      // (framing refused, origin not registered), so the shopper is never stuck behind it.
      const button = doc.createElement('button');
      button.setAttribute('type', 'button');
      button.setAttribute('aria-label', 'Close checkout');
      button.textContent = '\u00d7';
      button.style.cssText =
        'position:fixed;top:12px;right:12px;width:40px;height:40px;border-radius:20px;' +
        'border:1px solid #fff;background:#0b1020;color:#fff;font:24px/1 sans-serif;' +
        'cursor:pointer;z-index:1';
      button.addEventListener('click', close);

      // Focus trap (close button, then the checkout): tabbing past either end lands on a sentinel
      // that wraps around, and focus anywhere else on the page is sent back to the checkout.
      const toFrame = () => f.iframe.focus();
      const sentinel = (to: () => void) => {
        const s = doc.createElement('div');
        s.setAttribute('tabindex', '0');
        s.addEventListener('focus', to);
        return s;
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      };
      const onFocusIn = (e: FocusEvent) => {
        if (!overlay.contains(e.target as Node)) toFrame();
      };

      overlay.appendChild(sentinel(toFrame));
      overlay.appendChild(button);
      overlay.appendChild(f.iframe);
      overlay.appendChild(sentinel(() => button.focus()));
      body.appendChild(overlay);
      body.style.overflow = 'hidden';
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('focusin', onFocusIn);
      toFrame();
      closeModal = close;
      return { close };
    },
  };
}

// The build defines the checkout's base URL; unit tests import createTendr without it.
declare const __TENDR_CHECKOUT_BASE_URL__: string | undefined;
if (typeof window !== 'undefined' && typeof __TENDR_CHECKOUT_BASE_URL__ === 'string') {
  const w = window as Window & { Tendr?: Tendr };
  w.Tendr = w.Tendr || createTendr(window, __TENDR_CHECKOUT_BASE_URL__);
}
