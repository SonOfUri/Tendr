// tendr.js against a small hand-written DOM (the web unit tests run without a browser DOM). The
// fake models only what the embed touches: elements, focus, body style and event listeners.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTendr, type TendrEvent } from './tendr';

const BASE = 'https://checkout.example';
const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const OTHER_SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ1';
const URL_OK = `${BASE}/pay/${SESSION}#cs=${SESSION}_secret_0123456789abcdef0123456789abcdef`;

type Listener = (e: Record<string, unknown>) => void;

class Target {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, e: Record<string, unknown> = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, ...e });
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeElement extends Target {
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  contentWindow: object | null;
  innerHTMLSet = false;
  tabIndex = -1;
  constructor(
    readonly tagName: string,
    readonly doc: FakeDocument,
  ) {
    super();
    this.contentWindow = tagName === 'IFRAME' ? { frame: true } : null;
  }
  set innerHTML(_v: string) {
    this.innerHTMLSet = true;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child: FakeElement) {
    child.parentNode?.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }
  get isConnected(): boolean {
    let n: FakeElement | null = this;
    while (n) {
      if (n === this.doc.body) return true;
      n = n.parentNode;
    }
    return false;
  }
  focus() {
    const prev = this.doc.activeElement;
    this.doc.activeElement = this;
    if (prev !== this) this.dispatch('focus', { target: this });
  }
  /** Every descendant (depth first). */
  all(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

class FakeDocument extends Target {
  body: FakeElement;
  documentElement: FakeElement;
  activeElement: FakeElement | null = null;
  constructor() {
    super();
    this.documentElement = new FakeElement('HTML', this);
    this.body = new FakeElement('BODY', this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string) {
    return new FakeElement(tag.toUpperCase(), this);
  }
}

class FakeWindow extends Target {
  document = new FakeDocument();
}

function setup() {
  const win = new FakeWindow();
  const doc = win.document;
  const events: TendrEvent[] = [];
  const onEvent = (e: TendrEvent) => events.push(e);
  const tendr = createTendr(win as unknown as Window, BASE);
  const iframes = () => doc.body.all().filter((e) => e.tagName === 'IFRAME');
  /** A message from `source` (default: the only iframe's window) at `origin`. */
  const message = (data: unknown, opts: { origin?: string; source?: unknown } = {}) =>
    win.dispatch('message', {
      data,
      origin: opts.origin ?? BASE,
      source: 'source' in opts ? opts.source : iframes()[0]!.contentWindow,
    });
  return { win, doc, events, onEvent, tendr, iframes, message };
}

describe('tendr.js', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  describe('sessionUrl', () => {
    it('frames the session URL unchanged, fragment included', () => {
      const host = t.doc.createElement('div');
      t.doc.body.appendChild(host);
      t.tendr.mount(host as unknown as Element, { sessionUrl: URL_OK, onEvent: t.onEvent });
      const [iframe] = t.iframes();
      expect(iframe!.getAttribute('src')).toBe(URL_OK);
      expect(iframe!.getAttribute('allow')).toBe('clipboard-write');
      expect(iframe!.getAttribute('title')).toBeTruthy();
      // The checkout always learns the store page's origin, whatever that page's own policy.
      expect(iframe!.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
      expect(t.doc.body.all().some((e) => e.innerHTMLSet)).toBe(false);
    });

    it('accepts the root-form session URL the pay host hands out (`/<session id>`)', () => {
      const root = `${BASE}/${SESSION}#cs=${SESSION}_secret_0123456789abcdef0123456789abcdef`;
      const host = t.doc.createElement('div');
      t.doc.body.appendChild(host);
      t.tendr.mount(host as unknown as Element, { sessionUrl: root, onEvent: t.onEvent });
      expect(t.iframes()[0]!.getAttribute('src')).toBe(root);
    });

    it('the modal frames it with ?embed=modal, the #cs fragment untouched', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      const [iframe] = t.iframes();
      const [path, fragment] = URL_OK.split('#');
      expect(iframe!.getAttribute('src')).toBe(`${path}?embed=modal#${fragment}`);
      expect(iframe!.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    });

    it.each([
      ['another origin', `https://evil.example/pay/${SESSION}#cs=x`],
      ['another scheme', `http://checkout.example/pay/${SESSION}`],
      ['another port', `https://checkout.example:8443/pay/${SESSION}`],
      ['a look-alike host', `https://checkout.example.evil.example/pay/${SESSION}`],
      ['not a checkout path', `${BASE}/dashboard`],
      ['a malformed session id', `${BASE}/pay/ses_nope`],
      ['javascript:', 'javascript:alert(1)'],
      ['not a URL', 'not a url'],
      ['not a string', 42],
    ])('throws a clear error for %s, and creates nothing', (_label, sessionUrl) => {
      const host = t.doc.createElement('div');
      t.doc.body.appendChild(host);
      expect(() =>
        t.tendr.mount(host as unknown as Element, {
          sessionUrl: sessionUrl as string,
          onEvent: t.onEvent,
        }),
      ).toThrow(/Tendr: sessionUrl must be a checkout link on https:\/\/checkout\.example/);
      expect(() => t.tendr.open({ sessionUrl: sessionUrl as string })).toThrow(/Tendr:/);
      expect(t.iframes()).toHaveLength(0);
      expect(t.doc.body.style.overflow ?? '').toBe('');
    });

    it('refuses a base URL that is not http(s)', () => {
      expect(() => createTendr(new FakeWindow() as unknown as Window, 'javascript:x')).toThrow(
        /Tendr/,
      );
    });
  });

  describe('messages', () => {
    let host: FakeElement;
    beforeEach(() => {
      host = t.doc.createElement('div');
      t.doc.body.appendChild(host);
      t.tendr.mount(host as unknown as Element, { sessionUrl: URL_OK, onEvent: t.onEvent });
    });

    it('passes on ready, status and complete from its own frame', () => {
      t.message({ type: 'tendr:ready', sessionId: SESSION, status: 'pending' });
      t.message({ type: 'tendr:status', sessionId: SESSION, status: 'settled' });
      t.message({ type: 'tendr:complete', sessionId: SESSION, status: 'settled' });
      expect(t.events).toEqual([
        { type: 'ready', sessionId: SESSION, status: 'pending' },
        { type: 'status', sessionId: SESSION, status: 'settled' },
        { type: 'complete', sessionId: SESSION, status: 'settled' },
      ]);
    });

    it('ignores messages from any other origin', () => {
      for (const origin of [
        'https://evil.example',
        'http://checkout.example',
        'https://checkout.example:8443',
        'null',
      ]) {
        t.message({ type: 'tendr:complete', sessionId: SESSION, status: 'settled' }, { origin });
      }
      expect(t.events).toEqual([]);
    });

    it('ignores messages from any other window, even on the checkout origin', () => {
      const other = t.doc.createElement('iframe');
      for (const source of [other.contentWindow, t.win, null, undefined]) {
        t.message({ type: 'tendr:complete', sessionId: SESSION, status: 'settled' }, { source });
      }
      expect(t.events).toEqual([]);
    });

    it('ignores malformed messages and other sessions', () => {
      for (const data of [
        null,
        'tendr:complete',
        { type: 'tendr:complete' },
        { type: 'tendr:complete', sessionId: OTHER_SESSION, status: 'settled' },
        { type: 'other', sessionId: SESSION },
        { type: 'tendr:resize', sessionId: SESSION, height: 'big' },
        { type: 'tendr:resize', sessionId: SESSION, height: -5 },
        { type: 'tendr:resize', sessionId: SESSION, height: Number.NaN },
      ]) {
        t.message(data);
      }
      expect(t.events).toEqual([]);
      expect(t.iframes()[0]!.style.height).not.toBe('-5px');
    });

    it('resizes the widget to the height its frame reports (bounded)', () => {
      const [iframe] = t.iframes();
      t.message({ type: 'tendr:resize', sessionId: SESSION, height: 512.4 });
      expect(iframe!.style.height).toBe('513px');
      t.message({ type: 'tendr:resize', sessionId: SESSION, height: 10_000_000 });
      expect(parseInt(iframe!.style.height!, 10)).toBeLessThanOrEqual(5000);
      t.message(
        { type: 'tendr:resize', sessionId: SESSION, height: 300 },
        { origin: 'https://x.example' },
      );
      expect(parseInt(iframe!.style.height!, 10)).toBeLessThanOrEqual(5000);
      expect(t.events).toEqual([]);
    });

    it('a widget passes tendr:close on and stays mounted', () => {
      t.message({ type: 'tendr:close', sessionId: SESSION, status: 'pending' });
      expect(t.events).toEqual([{ type: 'close' }]);
      expect(t.iframes()).toHaveLength(1);
    });

    it('unmount removes the frame and stops listening', () => {
      const handle = t.tendr.mount(host as unknown as Element, { sessionUrl: URL_OK });
      expect(t.iframes()).toHaveLength(2);
      handle.unmount();
      expect(t.iframes()).toHaveLength(1);
      expect(t.win.count('message')).toBe(1);
    });

    it('a throwing onEvent does not break the embed', () => {
      const bad = vi.fn(() => {
        throw new Error('store bug');
      });
      const second = setup();
      const h = second.doc.createElement('div');
      second.doc.body.appendChild(h);
      second.tendr.mount(h as unknown as Element, { sessionUrl: URL_OK, onEvent: bad });
      expect(() =>
        second.message({ type: 'tendr:ready', sessionId: SESSION, status: 'pending' }),
      ).not.toThrow();
      expect(bad).toHaveBeenCalledOnce();
    });
  });

  describe('modal', () => {
    let opener: FakeElement;
    beforeEach(() => {
      opener = t.doc.createElement('button');
      t.doc.body.appendChild(opener);
      opener.focus();
      t.doc.body.style.overflow = 'auto';
    });

    it('opens an overlay dialog, moves focus into it and stops the page scrolling', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      const dialog = t.doc.body.all().find((e) => e.getAttribute('role') === 'dialog');
      expect(dialog).toBeDefined();
      expect(dialog!.getAttribute('aria-modal')).toBe('true');
      const [iframe] = t.iframes();
      expect(dialog!.contains(iframe)).toBe(true);
      expect(t.doc.activeElement).toBe(iframe);
      expect(t.doc.body.style.overflow).toBe('hidden');
    });

    it('closes on Esc: removes the frame, restores focus and scrolling, emits close', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      t.doc.dispatch('keydown', { key: 'Escape', preventDefault() {} });
      expect(t.iframes()).toHaveLength(0);
      expect(t.doc.body.all().some((e) => e.getAttribute('role') === 'dialog')).toBe(false);
      expect(t.doc.activeElement).toBe(opener);
      expect(t.doc.body.style.overflow).toBe('auto');
      expect(t.events).toEqual([{ type: 'close' }]);
      expect(t.win.count('message')).toBe(0);
      expect(t.doc.count('keydown')).toBe(0);
      expect(t.doc.count('focusin')).toBe(0);
    });

    it('other keys do not close it', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      t.doc.dispatch('keydown', { key: 'Enter', preventDefault() {} });
      expect(t.iframes()).toHaveLength(1);
    });

    it('closes on tendr:close from its frame, and only from its frame', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      t.message(
        { type: 'tendr:close', sessionId: SESSION, status: null },
        { origin: 'https://evil.example' },
      );
      t.message({ type: 'tendr:close', sessionId: SESSION, status: null }, { source: {} });
      expect(t.iframes()).toHaveLength(1);
      t.message({ type: 'tendr:ready', sessionId: SESSION, status: 'pending' });
      t.message({ type: 'tendr:close', sessionId: SESSION, status: 'pending' });
      expect(t.iframes()).toHaveLength(0);
      expect(t.doc.activeElement).toBe(opener);
      expect(t.events).toEqual([
        { type: 'ready', sessionId: SESSION, status: 'pending' },
        { type: 'close' },
      ]);
    });

    it('the returned close() closes once', () => {
      const m = t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      m.close();
      m.close();
      t.doc.dispatch('keydown', { key: 'Escape', preventDefault() {} });
      expect(t.events).toEqual([{ type: 'close' }]);
      expect(t.doc.body.style.overflow).toBe('auto');
    });

    it('has its own close button, which closes it with no word from the frame', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      const dialog = t.doc.body.all().find((e) => e.getAttribute('role') === 'dialog')!;
      const button = dialog.all().find((e) => e.tagName === 'BUTTON');
      expect(button).toBeDefined();
      expect(button!.getAttribute('type')).toBe('button');
      expect(button!.getAttribute('aria-label')).toBe('Close checkout');
      expect(button!.style.cssText).not.toMatch(/display:\s*none|visibility:\s*hidden/);
      button!.dispatch('click', { preventDefault() {} });
      expect(t.iframes()).toHaveLength(0);
      expect(t.doc.body.all().some((e) => e.getAttribute('role') === 'dialog')).toBe(false);
      expect(t.doc.activeElement).toBe(opener);
      expect(t.doc.body.style.overflow).toBe('auto');
      expect(t.events).toEqual([{ type: 'close' }]);
    });

    it('traps focus between the close button and the checkout', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      const [iframe] = t.iframes();
      const dialog = t.doc.body.all().find((e) => e.getAttribute('role') === 'dialog')!;
      const button = dialog.all().find((e) => e.tagName === 'BUTTON')!;
      const sentinels = dialog.children.filter((c) => c.getAttribute('tabindex') === '0');
      expect(sentinels.length).toBe(2);
      // Order: sentinel, close button, checkout, sentinel.
      expect(dialog.children.indexOf(button)).toBeLessThan(dialog.children.indexOf(iframe!));
      // Tab past the checkout wraps to the close button; Shift+Tab before the button wraps to the
      // checkout.
      sentinels[1]!.focus();
      expect(t.doc.activeElement).toBe(button);
      sentinels[0]!.focus();
      expect(t.doc.activeElement).toBe(iframe);
      // Focus on the button stays there (it is inside the trap).
      button.focus();
      t.doc.dispatch('focusin', { target: button });
      expect(t.doc.activeElement).toBe(button);
      // Focus anywhere else on the page comes back to the checkout.
      opener.focus();
      t.doc.dispatch('focusin', { target: opener });
      expect(t.doc.activeElement).toBe(iframe);
    });

    it('opening a second modal closes the first', () => {
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      t.tendr.open({ sessionUrl: URL_OK, onEvent: t.onEvent });
      expect(t.iframes()).toHaveLength(1);
      expect(t.events).toEqual([{ type: 'close' }]);
    });

    it('applies tendr:resize to the modal frame too', () => {
      t.tendr.open({ sessionUrl: URL_OK });
      t.message({ type: 'tendr:resize', sessionId: SESSION, height: 700 });
      expect(t.iframes()[0]!.style.height).toBe('700px');
    });
  });
});
