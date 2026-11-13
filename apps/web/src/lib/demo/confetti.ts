/** Same burst as the demo status “All set” card. */

const CONFETTI_COLORS = ['#b6f34d', '#111111', '#ffffff', '#6ee7b7', '#93c5fd', '#fbbf24'];

type ConfettiBurst = {
  count?: number;
  delay?: number;
  durMin?: number;
  durSpan?: number;
  removeAfter?: number;
};

export function burstDemoConfetti(root: HTMLElement, burst: ConfettiBurst = {}): () => void {
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return () => {};
  }
  const count = burst.count ?? 64;
  const delay = burst.delay ?? 0.35;
  const durMin = burst.durMin ?? 1.4;
  const durSpan = burst.durSpan ?? 1.2;
  const removeAfter = burst.removeAfter ?? 3200;
  const layer = document.createElement('div');
  layer.className = 'demo-confetti-layer';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'demo-confetti-piece';
    piece.style.setProperty('--x', `${8 + Math.random() * 84}%`);
    piece.style.setProperty('--delay', `${Math.random() * delay}s`);
    piece.style.setProperty('--dur', `${durMin + Math.random() * durSpan}s`);
    piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    piece.style.setProperty('--drift', `${Math.random() * 140 - 70}px`);
    piece.style.setProperty('--size', `${6 + Math.random() * 8}px`);
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
    layer.appendChild(piece);
  }
  root.appendChild(layer);
  const t = window.setTimeout(() => layer.remove(), removeAfter);
  return () => {
    window.clearTimeout(t);
    layer.remove();
  };
}
