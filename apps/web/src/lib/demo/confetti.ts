/** Same burst as the demo status “All set” card. */

const CONFETTI_COLORS = ['#b6f34d', '#111111', '#ffffff', '#6ee7b7', '#93c5fd', '#fbbf24'];

export function burstDemoConfetti(root: HTMLElement): () => void {
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return () => {};
  }
  const layer = document.createElement('div');
  layer.className = 'demo-confetti-layer';
  layer.setAttribute('aria-hidden', 'true');
  const count = 64;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('span');
    piece.className = 'demo-confetti-piece';
    piece.style.setProperty('--x', `${8 + Math.random() * 84}%`);
    piece.style.setProperty('--delay', `${Math.random() * 0.35}s`);
    piece.style.setProperty('--dur', `${1.4 + Math.random() * 1.2}s`);
    piece.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    piece.style.setProperty('--drift', `${Math.random() * 120 - 60}px`);
    piece.style.setProperty('--size', `${6 + Math.random() * 8}px`);
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length]!;
    layer.appendChild(piece);
  }
  root.appendChild(layer);
  const t = window.setTimeout(() => layer.remove(), 3200);
  return () => {
    window.clearTimeout(t);
    layer.remove();
  };
}
