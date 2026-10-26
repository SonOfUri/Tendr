import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoller, type PollerDocument } from './poller';

function fakeDoc(state: 'visible' | 'hidden' = 'visible') {
  const listeners = new Set<() => void>();
  const doc: PollerDocument & { set(s: 'visible' | 'hidden'): void } = {
    visibilityState: state,
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    set(s) {
      this.visibilityState = s;
      for (const l of listeners) l();
    },
  };
  return doc;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('status poller', () => {
  it('polls every 2 s while visible and stops on a terminal state', async () => {
    let n = 0;
    const tick = vi.fn(async () => ({ terminal: ++n >= 3 }));
    const p = createPoller({ tick, doc: fakeDoc(), onConnection: () => {} });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('pauses while hidden and resumes at once when visible again', async () => {
    const doc = fakeDoc('hidden');
    const tick = vi.fn(async () => ({ terminal: false }));
    const p = createPoller({ tick, doc, onConnection: () => {} });
    p.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
    doc.set('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    doc.set('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('backs off to 10 s after repeated network errors and says it is reconnecting', async () => {
    const onConnection = vi.fn();
    let fail = true;
    const tick = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return { terminal: false };
    });
    const p = createPoller({ tick, doc: fakeDoc(), onConnection });
    p.start();
    await vi.advanceTimersByTimeAsync(0); // 1st error
    await vi.advanceTimersByTimeAsync(2000); // 2nd
    await vi.advanceTimersByTimeAsync(2000); // 3rd → back off
    expect(tick).toHaveBeenCalledTimes(3);
    expect(onConnection).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(tick).toHaveBeenCalledTimes(4);
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(onConnection).toHaveBeenLastCalledWith('ok');
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(6);
    p.stop();
  });

  it('stop() ends polling', async () => {
    const tick = vi.fn(async () => ({ terminal: false }));
    const p = createPoller({ tick, doc: fakeDoc(), onConnection: () => {} });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
