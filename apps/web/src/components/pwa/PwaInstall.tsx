'use client';

import { Download, WifiOff } from 'lucide-react';
import { useOnline, usePwaInstall } from '@/lib/pwa-install';

export { useOnline } from '@/lib/pwa-install';

/** Offline status and the install offer, in the dashboard banner row. */
export function PwaBanners() {
  const online = useOnline();
  const pwa = usePwaInstall();

  if (online && !pwa.showBanner) return null;

  return (
    <>
      {!online ? (
        <p className="dash-offline-banner" role="status">
          <WifiOff size={15} strokeWidth={1.85} aria-hidden />
          <span>
            <strong>You’re offline.</strong> You can look around. Creating or sending a payment
            link needs a connection.
          </span>
        </p>
      ) : null}
      {pwa.showBanner ? (
        <div className="dash-pwa-slot">
          <div className="dash-pwa">
            <span className="dash-pwa-mark" aria-hidden>
              <Download size={15} strokeWidth={1.85} />
            </span>
            <p className="dash-pwa-copy">
              <strong>{pwa.ios ? 'Add Tendr to your Home Screen' : 'Install Tendr'}</strong>
              <span>
                {pwa.ios
                  ? 'Tap Share, then Add to Home Screen, and send a payment link on the go.'
                  : 'Keep it on your phone and send a payment link without opening a browser tab.'}
              </span>
            </p>
            <div className="dash-pwa-actions">
              {pwa.canPrompt ? (
                <button type="button" className="dash-pwa-btn" onClick={() => void pwa.install()}>
                  Install
                </button>
              ) : null}
              <button type="button" className="dash-pwa-btn dash-pwa-btn--ghost" onClick={pwa.dismiss}>
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Stays in the sidebar after the banner is dismissed, until the app is installed. */
export function PwaInstallButton() {
  const pwa = usePwaInstall();
  if (!pwa.showAction) return null;
  return (
    <button
      type="button"
      className="dash-sidebar-install"
      title={pwa.ios ? 'Add to Home Screen' : 'Install Tendr'}
      onClick={() => void pwa.install()}
    >
      <Download size={16} strokeWidth={1.85} aria-hidden />
      <span>{pwa.ios ? 'Add to Home Screen' : 'Install app'}</span>
    </button>
  );
}
