import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetClientSecrets, takeClientSecret, type FragmentEnv } from './secret';

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';
const SECRET = `${SESSION}_secret_0123456789abcdef0123456789abcdef`;

function env(hash: string, search = '') {
  const replaceState = vi.fn();
  const e: FragmentEnv = {
    location: { hash, pathname: `/pay/${SESSION}`, search },
    history: { state: { keep: 1 }, replaceState },
  };
  return { e, replaceState };
}

afterEach(() => {
  forgetClientSecrets();
  vi.unstubAllGlobals();
});

describe('client secret from the URL fragment', () => {
  it('reads #cs= and strips the fragment, keeping the path, query and history state', () => {
    const { e, replaceState } = env(`#cs=${SECRET}`, '?lang=en');
    expect(takeClientSecret(SESSION, e)).toBe(SECRET);
    expect(replaceState).toHaveBeenCalledTimes(1);
    const [state, , url] = replaceState.mock.calls[0]!;
    expect(state).toEqual({ keep: 1 });
    expect(url).toBe(`/pay/${SESSION}?lang=en`);
  });

  it('keeps it in memory: a second read (fragment already gone) returns it', () => {
    takeClientSecret(SESSION, env(`#cs=${SECRET}`).e);
    const { e, replaceState } = env('');
    expect(takeClientSecret(SESSION, e)).toBe(SECRET);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('is null when missing, malformed or for another session (and the fragment is still stripped)', () => {
    expect(takeClientSecret(SESSION, env('').e)).toBeNull();
    const bad = env('#cs=nope');
    expect(takeClientSecret(SESSION, bad.e)).toBeNull();
    expect(bad.replaceState).toHaveBeenCalledTimes(1);
    const other = 'ses_01JZZZZZZZZZZZZZZZZZZZZZZZ_secret_0123456789abcdef0123456789abcdef';
    const wrong = env(`#cs=${other}`);
    expect(takeClientSecret(SESSION, wrong.e)).toBeNull();
    expect(wrong.replaceState).toHaveBeenCalledTimes(1);
  });

  it('is never written to web storage or cookies', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    vi.stubGlobal('sessionStorage', { setItem });
    const doc = { cookie: '' };
    vi.stubGlobal('document', doc);
    expect(takeClientSecret(SESSION, env(`#cs=${SECRET}`).e)).toBe(SECRET);
    expect(setItem).not.toHaveBeenCalled();
    expect(doc.cookie).toBe('');
  });
});
