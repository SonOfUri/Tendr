'use client';

import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

type Point = { x: number; y: number };

type Props = {
  className?: string;
  style?: CSSProperties;
  /** Navigate / activate on a click that didn’t become a drag. */
  onActivate?: () => void;
  children: ReactNode;
};

const DRAG_THRESHOLD_PX = 6;

export function LoginDraggable({ className, style, onActivate, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ pointer: Point; delta: Point } | null>(null);
  const moved = useRef(false);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, textarea, select')) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some environments reject capture when the pointer id isn't active.
    }
    moved.current = false;
    origin.current = {
      pointer: { x: e.clientX, y: e.clientY },
      delta: { ...delta },
    };
    setDragging(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || !origin.current || !ref.current) return;
    const parent = ref.current.parentElement;
    if (!parent) return;

    const dx = e.clientX - origin.current.pointer.x;
    const dy = e.clientY - origin.current.pointer.y;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) moved.current = true;

    let x = origin.current.delta.x + dx;
    let y = origin.current.delta.y + dy;

    // Soft-clamp so most of the card stays inside the stack.
    const el = ref.current.getBoundingClientRect();
    const bounds = parent.getBoundingClientRect();
    const visualLeft = el.left - delta.x + x;
    const visualTop = el.top - delta.y + y;
    const slackX = el.width * 0.35;
    const slackY = el.height * 0.35;

    if (visualLeft < bounds.left - slackX) x += bounds.left - slackX - visualLeft;
    if (visualTop < bounds.top - slackY) y += bounds.top - slackY - visualTop;
    if (visualLeft + el.width > bounds.right + slackX) {
      x -= visualLeft + el.width - (bounds.right + slackX);
    }
    if (visualTop + el.height > bounds.bottom + slackY) {
      y -= visualTop + el.height - (bounds.bottom + slackY);
    }

    setDelta({ x, y });
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const wasDrag = moved.current;
    origin.current = null;
    setDragging(false);
    if (!wasDrag) onActivate?.();
  }

  return (
    <div
      ref={ref}
      className={`${className ?? ''}${dragging ? ' is-dragging' : ''}`}
      style={
        {
          ...style,
          '--drag-x': `${delta.x}px`,
          '--drag-y': `${delta.y}px`,
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {children}
    </div>
  );
}
