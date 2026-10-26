import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearClientSecret,
  forgetClientSecrets,
  storageKey,
  takeClientSecret,
  type FragmentEnv,
} from './secret';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const SECRET = `${SESSION}_secret_0123456789abcdef0123456789abcdef`;
const STALE = `${SESSION}_secret_ffffffffffffffffffffffffffffffff`;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn((k: string) => void data.delete(k)),
  };
}

function env(
  hash: string,
  opts: { search?: string; storage?: FragmentEnv['sessionStorage'] } = {},
) {
  const replaceState = vi.fn();
  const e: FragmentEnv = {
    location: { hash, pathname: `/pay/${SESSION}`, search: opts.search ?? '' },
    history: { state: { keep: 1 }, replaceState },
    ...(opts.storage ? { sessionStorage: opts.storage } : {}),
  };
  return { e, replaceState };
}

/** An env whose sessionStorage getter throws (storage blocked). */
function blockedEnv(hash: string) {
  const { e, replaceState } = env(hash);
  Object.defineProperty(e, 'sessionStorage', {
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });
  return { e, replaceState };
}

afterEach(() => {
  forgetClientSecrets();
  vi.unstubAllGlobals();
});

describe('client secret from the URL fragment', () => {
  it('reads #cs=, stores it under tendr:cs:<id>, and strips the fragment (path, query, state kept)', () => {
    const storage = memoryStorage();
    const { e, replaceState } = env(`#cs=${SECRET}`, { search: '?lang=en', storage });
    expect(takeClientSecret(SESSION, e)).toBe(SECRET);
    expect(storage.data.get(storageKey(SESSION))).toBe(SECRET);
    expect(storageKey(SESSION)).toBe(`tendr:cs:${SESSION}`);
    expect(replaceState).toHaveBeenCalledTimes(1);
    const [state, , url] = replaceState.mock.calls[0]!;
    expect(state).toEqual({ keep: 1 });
    expect(url).toBe(`/pay/${SESSION}?lang=en`);
  });

  it('survives a reload: no fragment, read from sessionStorage', () => {
    const storage = memoryStorage();
    takeClientSecret(SESSION, env(`#cs=${SECRET}`, { storage }).e);
    forgetClientSecrets(); // a reload empties memory
    const { e, replaceState } = env('', { storage });
    expect(takeClientSecret(SESSION, e)).toBe(SECRET);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('a fragment overrides a stale stored value', () => {
    const storage = memoryStorage({ [storageKey(SESSION)]: STALE });
    expect(takeClientSecret(SESSION, env(`#cs=${SECRET}`, { storage }).e)).toBe(SECRET);
    expect(storage.data.get(storageKey(SESSION))).toBe(SECRET);
  });

  it('works with storage blocked (memory only)', () => {
    expect(takeClientSecret(SESSION, blockedEnv(`#cs=${SECRET}`).e)).toBe(SECRET);
    expect(takeClientSecret(SESSION, blockedEnv('').e)).toBe(SECRET); // same page, from memory
    forgetClientSecrets();
    expect(takeClientSecret(SESSION, blockedEnv('').e)).toBeNull(); // reload: nothing to read
    expect(() => clearClientSecret(SESSION, blockedEnv('').e)).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    };
    expect(takeClientSecret(SESSION, env(`#cs=${SECRET}`, { storage: throwing }).e)).toBe(SECRET);
  });

  it('is cleared from memory and storage on a terminal state', () => {
    const storage = memoryStorage();
    takeClientSecret(SESSION, env(`#cs=${SECRET}`, { storage }).e);
    clearClientSecret(SESSION, { sessionStorage: storage });
    expect(storage.data.has(storageKey(SESSION))).toBe(false);
    expect(takeClientSecret(SESSION, env('', { storage }).e)).toBeNull();
  });

  it('is null when missing, malformed or for another session (and the fragment is still stripped)', () => {
    expect(takeClientSecret(SESSION, env('').e)).toBeNull();
    const bad = env('#cs=nope');
    expect(takeClientSecret(SESSION, bad.e)).toBeNull();
    expect(bad.replaceState).toHaveBeenCalledTimes(1);
    const other = 'ses_01JZZZZZZZZZZZZZZZZZZZZZZZ_secret_0123456789abcdef0123456789abcdef';
    const storage = memoryStorage({ [storageKey(SESSION)]: other });
    const wrong = env(`#cs=${other}`, { storage });
    expect(takeClientSecret(SESSION, wrong.e)).toBeNull();
    expect(wrong.replaceState).toHaveBeenCalledTimes(1);
  });

  it('is never written to localStorage or cookies', () => {
    const localSet = vi.fn();
    vi.stubGlobal('localStorage', { setItem: localSet });
    const doc = { cookie: '' };
    vi.stubGlobal('document', doc);
    const storage = memoryStorage();
    expect(takeClientSecret(SESSION, env(`#cs=${SECRET}`, { storage }).e)).toBe(SECRET);
    expect(localSet).not.toHaveBeenCalled();
    expect(doc.cookie).toBe('');
    expect([...storage.data.keys()]).toEqual([storageKey(SESSION)]);
  });
});
