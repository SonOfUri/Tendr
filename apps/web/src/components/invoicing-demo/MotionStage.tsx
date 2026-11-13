'use client';

import type { ReactNode } from 'react';
import './invoicing-demo.css';

/** Black plate in a white rounded frame. Later motion shots reuse this. */
export function MotionStage({ children }: { children?: ReactNode }) {
  return (
    <div className="motion-frame">
      <div className="motion-stage" aria-label="Motion canvas">
        {children}
      </div>
    </div>
  );
}
