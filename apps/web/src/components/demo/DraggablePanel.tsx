'use client';

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

type Props = {
  kind: 'component' | 'code';
  visible: boolean;
  /** Prefer top-centered for code, dead-center for component */
  anchor: 'center' | 'top';
  children: ReactNode;
};

type Point = { x: number; y: number };

function defaultOffset(
  parent: HTMLElement,
  el: HTMLElement,
  anchor: 'center' | 'top',
): Point {
  const pw = parent.clientWidth;
  const ph = parent.clientHeight;
  const w = el.offsetWidth || 320;
  const h = el.offsetHeight || 200;
  const x = Math.max(16, (pw - w) / 2);
  const y =
    anchor === 'top'
      ? Math.max(64, Math.min(88, Math.max(64, ph - h - 24)))
      : Math.max(72, (ph - h) / 2);
  return { x, y };
}

export function DraggablePanel({ kind, visible, anchor, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef<{ pointer: Point; offset: Point } | null>(null);
  const userMoved = useRef(false);

  useLayoutEffect(() => {
    const el = panelRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    userMoved.current = false;

    const place = () => {
      if (userMoved.current || dragOrigin.current) return;
      setOffset(defaultOffset(parent, el, anchor));
      setReady(true);
    };

    place();

    const ro = new ResizeObserver(place);
    ro.observe(parent);
    ro.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, kind]);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!visible) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, pre, code')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragOrigin.current = {
      pointer: { x: e.clientX, y: e.clientY },
      offset: { ...offset },
    };
    setDragging(true);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging || !dragOrigin.current) return;
    const parent = panelRef.current?.parentElement;
    const el = panelRef.current;
    if (!parent || !el) return;
    const dx = e.clientX - dragOrigin.current.pointer.x;
    const dy = e.clientY - dragOrigin.current.pointer.y;
    let x = dragOrigin.current.offset.x + dx;
    let y = dragOrigin.current.offset.y + dy;
    const maxX = Math.max(8, parent.clientWidth - el.offsetWidth - 8);
    const maxY = Math.max(8, parent.clientHeight - el.offsetHeight - 8);
    x = Math.min(maxX, Math.max(8, x));
    y = Math.min(maxY, Math.max(8, y));
    userMoved.current = true;
    setOffset({ x, y });
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragOrigin.current = null;
    setDragging(false);
  }

  const style = {
    '--dx': `${offset.x}px`,
    '--dy': `${offset.y}px`,
    left: 0,
    top: 0,
    opacity: ready ? undefined : 0,
  } as CSSProperties;

  return (
    <div
      ref={panelRef}
      className={`demo-draggable${dragging ? ' is-dragging' : ''}`}
      data-kind={kind}
      data-hidden={visible ? 'false' : 'true'}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {children}
    </div>
  );
}
