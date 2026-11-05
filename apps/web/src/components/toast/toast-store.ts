export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
  duration: number;
};

type Listener = () => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

function uid() {
  return `toast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dismiss(id: string) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

function show(
  message: string,
  opts?: { tone?: ToastTone; duration?: number },
): string {
  const id = uid();
  const tone = opts?.tone ?? 'info';
  const duration = opts?.duration ?? (tone === 'danger' ? 6500 : 4200);
  toasts = [...toasts, { id, message, tone, duration }].slice(-4);
  emit();
  if (duration > 0) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), duration),
    );
  }
  return id;
}

export const toast = {
  show,
  info: (message: string, duration?: number) => show(message, { tone: 'info', duration }),
  success: (message: string, duration?: number) =>
    show(message, { tone: 'success', duration }),
  warning: (message: string, duration?: number) =>
    show(message, { tone: 'warning', duration }),
  error: (message: string, duration?: number) =>
    show(message, { tone: 'danger', duration }),
  dismiss,
  dismissAll() {
    for (const id of timers.keys()) clearTimeout(timers.get(id));
    timers.clear();
    toasts = [];
    emit();
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot() {
    return toasts;
  },
};
