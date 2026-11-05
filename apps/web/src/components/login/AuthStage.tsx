'use client';

import type { ReactNode } from 'react';
import { LoginPillNav } from '@/components/login/LoginPillNav';

type Props = {
  children: ReactNode;
};

/** Shared auth shell: pill nav, full mobile demo, and the form panel. */
export function AuthStage({ children }: Props) {
  return (
    <div className="login-screen">
      <LoginPillNav />
      <div className="login-frame">
        <aside className="login-demos login-demos--art" aria-label="Tendr">
          <img
            className="login-demos-mark login-demos-mark--on-dark"
            src="/logo-with-watermark-white.png"
            alt=""
          />
          <img
            className="login-demos-mark login-demos-mark--on-light"
            src="/logo-with-watermark-dark.png"
            alt="Tendr"
          />
        </aside>
        <section className="login-panel">
          <div className="login-panel-brand">
            <img className="login-panel-mark login-panel-mark--on-dark" src="/logo-white.png" alt="" />
            <img className="login-panel-mark login-panel-mark--on-light" src="/logo-black.png" alt="Tendr" />
          </div>
          {children}
        </section>
      </div>
    </div>
  );
}
