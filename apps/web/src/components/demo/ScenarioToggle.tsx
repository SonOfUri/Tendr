'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEMOS, type DemoSlug } from '@/lib/demo';

type Props = {
  value: DemoSlug;
  onChange: (slug: DemoSlug) => void;
};

type Thumb = { left: number; width: number };

export function ScenarioToggle({ value, onChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState<Thumb>({ left: 4, width: 0 });
  const [ready, setReady] = useState(false);

  const measure = () => {
    const track = trackRef.current;
    const btn = btnRefs.current[value];
    if (!track || !btn) return;
    const trackBox = track.getBoundingClientRect();
    const btnBox = btn.getBoundingClientRect();
    setThumb({
      left: btnBox.left - trackBox.left,
      width: btnBox.width,
    });
    setReady(true);
  };

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(track);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div
      ref={trackRef}
      className="demo-scenario-toggle"
      role="tablist"
      aria-label="Usecases"
      data-ready={ready ? 'true' : 'false'}
    >
      <span
        className="demo-scenario-thumb"
        aria-hidden
        style={{
          transform: `translateX(${thumb.left}px)`,
          width: thumb.width || undefined,
        }}
      />
      {DEMOS.map((item) => {
        const active = item.slug === value;
        return (
          <button
            key={item.slug}
            ref={(el) => {
              btnRefs.current[item.slug] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-pressed={active}
            title={item.title}
            className="demo-scenario-opt"
            onClick={() => onChange(item.slug)}
          >
            {item.shortTitle}
          </button>
        );
      })}
    </div>
  );
}
