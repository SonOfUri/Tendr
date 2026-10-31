import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKOUT_BOOT_SCRIPT, SECRET_HANDOFF } from './boot-secret';
import { forgetClientSecrets, storageKey, takeClientSecret, type FragmentEnv } from './secret';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const SECRET = `${SESSION}_secret_0123456789abcdef0123456789abcdef`;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

/** A fake window whose address bar and history behave like a browser's. */
function fakeWindow(url: string, opts: { storage?: 'ok' | 'blocked' } = {}) {
  const u = new URL(url);
  const loc = { pathname: u.pathname, search: u.search, hash: u.hash };
  const history = {
    state: { __PRIVATE_NEXTJS_INTERNALS_TREE: 'old', canonical: url } as unknown,
    replaceState: vi.fn((state: unknown, _t: string, next?: string | null) => {
      history.state = state;
      if (next != null) {
        const n = new URL(next, u.origin);
        loc.pathname = n.pathname;
        loc.search = n.search;
        loc.hash = n.hash;
      }
    }),
  };
  const storage = memoryStorage();
  const win: Record<string, unknown> = { location: loc, history };
  Object.defineProperty(win, 'sessionStorage', {
    enumerable: true,
    get() {
      if (opts.storage === 'blocked') throw new DOMException('blocked', 'SecurityError');
      return storage;
    },
  });
  const href = () => `${u.origin}${loc.pathname}${loc.search}${loc.hash}`;
  return { win, loc, history, storage, href };
}

const boot = (win: Record<string, unknown>) =>
  new Function('window', CHECKOUT_BOOT_SCRIPT)(win) as void;

afterEach(() => forgetClientSecrets());

describe('checkout boot script (runs before Next hydrates)', () => {
  it('moves #cs= into sessionStorage and strips the fragment', () => {
    const w = fakeWindow(`https://pay.tendr.test/pay/${SESSION}?x=1#cs=${SECRET}`);
    boot(w.win);
    expect(w.storage.data.get(storageKey(SESSION))).toBe(SECRET);
    expect(w.history.replaceState).toHaveBeenCalledTimes(1);
    expect(w.history.replaceState.mock.calls[0]![0]).toBeNull();
    expect(w.href()).toBe(`https://pay.tendr.test/pay/${SESSION}?x=1`);
  });

  it('after boot neither the URL nor history.state contains cs=, and the page still gets the secret', () => {
    const w = fakeWindow(`https://pay.tendr.test/pay/${SESSION}#cs=${SECRET}`);
    boot(w.win);
    expect(w.href()).not.toContain('cs=');
    expect(JSON.stringify(w.history.state ?? null)).not.toContain('cs=');
    expect(takeClientSecret(SESSION, w.win as unknown as FragmentEnv)).toBe(SECRET);
    expect(w.href()).not.toContain('cs=');
    expect(JSON.stringify(w.history.state ?? null)).not.toContain('cs=');
  });

  it('a fragment overrides a stale stored value', () => {
    const w = fakeWindow(`https://pay.tendr.test/pay/${SESSION}#cs=${SECRET}`);
    w.storage.setItem(storageKey(SESSION), `${SESSION}_secret_${'f'.repeat(32)}`);
    boot(w.win);
    expect(w.storage.data.get(storageKey(SESSION))).toBe(SECRET);
  });

  it('with storage blocked, hands the secret over on a hidden window property, read once', () => {
    const w = fakeWindow(`https://pay.tendr.test/pay/${SESSION}#cs=${SECRET}`, {
      storage: 'blocked',
    });
    expect(() => boot(w.win)).not.toThrow();
    expect(w.href()).not.toContain('cs=');
    expect(Object.keys(w.win)).not.toContain(SECRET_HANDOFF);
    expect(takeClientSecret(SESSION, w.win as unknown as FragmentEnv)).toBe(SECRET);
    expect(SECRET_HANDOFF in w.win).toBe(false); // deleted after the read
  });

  it('drops a malformed or other-session secret (still stripping it)', () => {
    const w = fakeWindow(`https://pay.tendr.test/pay/${SESSION}#cs=nope`);
    boot(w.win);
    expect(w.href()).not.toContain('cs=');
    expect(w.storage.data.size).toBe(0);
    expect(SECRET_HANDOFF in w.win).toBe(false);
  });

  it('runs on the root form the pay host serves (`/<session id>`) as on `/pay/<session id>`', () => {
    for (const path of [`/${SESSION}`, `/pay/${SESSION}`]) {
      const w = fakeWindow(`https://pay.tendr.test${path}?x=1#cs=${SECRET}`);
      boot(w.win);
      expect(w.storage.data.get(storageKey(SESSION))).toBe(SECRET);
      expect(w.href()).toBe(`https://pay.tendr.test${path}?x=1`);
    }
    const sub = fakeWindow(`https://pay.tendr.test/${SESSION}/refund-address#cs=${SECRET}`);
    boot(sub.win);
    expect(sub.history.replaceState).not.toHaveBeenCalled();
  });

  it('leaves other pages and other fragments alone', () => {
    const other = fakeWindow(`https://pay.tendr.test/dashboard#cs=${SECRET}`);
    boot(other.win);
    expect(other.history.replaceState).not.toHaveBeenCalled();
    const anchor = fakeWindow(`https://pay.tendr.test/pay/${SESSION}#details`);
    boot(anchor.win);
    expect(anchor.history.replaceState).not.toHaveBeenCalled();
  });
});
