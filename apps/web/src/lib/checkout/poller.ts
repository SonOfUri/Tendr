// Status polling for the checkout page: every 2 s, only while the page is visible; paused while
// hidden and resumed at once when shown; stopped when a tick reports a terminal state. After
// repeated failures (network, rate limit) it backs off to 10 s and reports 'reconnecting'.

export interface PollerDocument {
  visibilityState: DocumentVisibilityState | string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface Poller {
  start(): void;
  stop(): void;
  /** Runs a tick now (e.g. after the shopper acted), keeping the schedule. */
  poke(): void;
}

export function createPoller(opts: {
  /** One poll. Throws on a transient failure; `terminal: true` stops polling. */
  tick: () => Promise<{ terminal: boolean }>;
  doc: PollerDocument;
  onConnection: (state: 'ok' | 'reconnecting') => void;
  intervalMs?: number;
  backoffMs?: number;
  /** Consecutive failures before backing off. */
  failuresBeforeBackoff?: number;
}): Poller {
  const interval = opts.intervalMs ?? 2000;
  const backoff = opts.backoffMs ?? 10_000;
  const threshold = opts.failuresBeforeBackoff ?? 3;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight = false;
  let failures = 0;
  let reconnecting = false;

  const visible = () => opts.doc.visibilityState === 'visible';
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    if (running && visible()) timer = setTimeout(run, ms);
  };

  async function run() {
    timer = null;
    if (!running || !visible() || inFlight) return;
    inFlight = true;
    try {
      const { terminal } = await opts.tick();
      failures = 0;
      if (reconnecting) {
        reconnecting = false;
        opts.onConnection('ok');
      }
      if (terminal) {
        running = false;
        return;
      }
      schedule(interval);
    } catch {
      failures++;
      if (failures >= threshold && !reconnecting) {
        reconnecting = true;
        opts.onConnection('reconnecting');
      }
      schedule(failures >= threshold ? backoff : interval);
    } finally {
      inFlight = false;
    }
  }

  const onVisibility = () => {
    if (!running) return;
    if (visible()) schedule(0);
    else clear();
  };

  return {
    start() {
      if (running) return;
      running = true;
      opts.doc.addEventListener('visibilitychange', onVisibility);
      schedule(0);
    },
    stop() {
      running = false;
      clear();
      opts.doc.removeEventListener('visibilitychange', onVisibility);
    },
    poke() {
      if (!running) {
        running = true;
        opts.doc.addEventListener('visibilitychange', onVisibility);
      }
      schedule(0);
    },
  };
}
