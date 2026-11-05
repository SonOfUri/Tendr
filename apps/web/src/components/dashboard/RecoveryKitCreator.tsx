'use client';

import { useEffect, useState } from 'react';
import { Alert, Button } from '@tendr/ui';
import { QrImage } from '@/components/QrImage';
import { api, errorMessage } from '@/lib/api';
import {
  createRecoveryKit,
  matchesConfirmation,
  recoveryKitPdfOrPrint,
  type RecoveryKit,
} from '@/lib/recovery-kit';
import { withStepUp } from '@/lib/webauthn';

type Registered = { stored: true } | { stored: false; proposal: { id: string } };

/**
 * Makes the recovery kit in this browser, shows and prints it, asks for characters 5–8 back, then
 * registers ONLY its public key. The kit text lives in this component's state until it is
 * registered, then it is cleared; it is never sent anywhere or written to browser storage.
 */
export function RecoveryKitCreator({
  storeName,
  storeSlug,
  replacing,
  onRegistered,
}: {
  storeName: string;
  storeSlug: string;
  replacing: boolean;
  onRegistered: (r: Registered) => void;
}) {
  const [kit, setKit] = useState<RecoveryKit | null>(null);
  const [step, setStep] = useState<'show' | 'confirm'>('show');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear the kit if the person leaves this screen half way.
  useEffect(() => () => setKit(null), []);

  function start() {
    setKit(createRecoveryKit());
    setStep('show');
    setTyped('');
    setError(null);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!kit) return;
    if (!matchesConfirmation(kit.secretWords, typed)) {
      setError('Those characters don’t match. Look at the second group on your kit.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await withStepUp(() =>
        api<Registered>('/v1/account/recovery-key', {
          method: 'POST',
          json: { publicKey: kit.publicKeyB64 },
        }),
      );
      setKit(null);
      setTyped('');
      onRegistered(res);
    } catch (err) {
      // Keep the kit so the person can retry without printing a new one.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!kit) {
    return (
      <div className="form">
        <p className="muted">
          A recovery kit is a code you print or write down and keep somewhere safe, like with your
          passport. If you ever lose every device, it lets you set up new ones. It can’t move money,
          and every signer is emailed and can stop a recovery for 3 days.
        </p>
        {replacing && (
          <Alert tone="warning">You already have a recovery kit. A new one replaces it.</Alert>
        )}
        <Button onClick={start}>Create recovery kit</Button>
      </div>
    );
  }

  const groups = kit.secretWords.split('-');

  return (
    <div className="form">
      {step === 'show' && (
        <div className="print-kit">
          <h3>Tendr recovery kit</h3>
          <p className="small">
            Business: <strong>{storeName}</strong> · Address: <code>{storeSlug}</code>
          </p>
          <p className="kit-code" aria-label="Recovery code">
            {groups.map((g, i) => (
              <span key={i} className={i === 1 ? 'kit-group kit-group-confirm' : 'kit-group'}>
                {g}
              </span>
            ))}
          </p>
          <QrImage value={kit.secretWords} label="Recovery code as a QR code" />
          <p className="small">
            Keep this private and offline. Anyone with this code can ask to take over the account
            (signers get 3 days to stop it). Tendr does not have a copy and cannot send you a new
            one.
          </p>
          <p className="small muted">Made {new Date().toLocaleDateString()}</p>
        </div>
      )}

      {step === 'show' ? (
        <div className="cta-row">
          <Button variant="secondary" onClick={() => recoveryKitPdfOrPrint(kit)}>
            Print or save as PDF
          </Button>
          <Button onClick={() => setStep('confirm')}>I’ve saved it</Button>
        </div>
      ) : (
        <form onSubmit={confirm} className="form">
          <p className="muted small">
            Your kit is hidden now. Check the copy you saved: type its second group of four.
          </p>
          <label className="field">
            <span>Type the second group of your kit (characters 5–8)</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={8}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              inputMode="text"
            />
          </label>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="cta-row">
            <Button variant="ghost" onClick={() => setStep('show')} disabled={busy}>
              Back
            </Button>
            <Button type="submit" disabled={busy || typed.trim().length < 4}>
              {busy ? 'Saving…' : 'Confirm and turn on'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
