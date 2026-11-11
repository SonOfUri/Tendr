'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { errorMessage, type StoreContext } from '@/lib/api';
import { matchesConfirmation } from '@/lib/recovery-kit';
import {
  createNativeKit,
  encodeNativeKit,
  nativeKitPublicKey,
  readNativeKit,
  type NativeRecoveryKit,
} from '@/lib/native-wallet-recovery';
import {
  addWalletPasskey,
  approveWalletKeyChange,
  cancelKeyOperation,
  continueKeyRegistration,
  enrollWalletKit,
  getKeyOperation,
  proveWalletKit,
  reviewKeyOperation,
  revokeWalletKey,
  walletKeys,
  type KeyOperation,
  type WalletKeyChallenge,
  type WalletKeyState,
} from '@/lib/native-wallet-keys';
import styles from './native-wallet-security.module.css';

const pendingStates = ['registering', 'proving', 'awaiting_signature', 'submitting'];
const shortKey = (key: string) => `${key.slice(0, 15)}…${key.slice(-12)}`;
const statusText: Record<string, string> = {
  registering: 'Create the new passkey',
  proving: 'Verify the new key',
  awaiting_signature: 'Needs wallet approval',
  submitting: 'Confirming on-chain',
  confirmed: 'Confirmed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** Mount with key={merchantId}. Recovery secrets stay in component memory until unmount. */
export function NativeWalletSecurity({ store }: { store: StoreContext }) {
  const [data, setData] = useState<WalletKeyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [label, setLabel] = useState('');
  const [kit, setKit] = useState<NativeRecoveryKit | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [kitText, setKitText] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [review, setReview] = useState<WalletKeyChallenge | null>(null);
  const [approved, setApproved] = useState(false);
  const load = useCallback(async () => {
    const value = await walletKeys(store);
    setData(value);
    setReview((old) =>
      old && value.operations.find((op) => op.id === old.id)?.status === 'awaiting_signature'
        ? old
        : null,
    );
    if (value.operations[0]?.status === 'confirmed') setKit(null);
  }, [store]);
  useEffect(() => {
    void load().catch((e) => setError(errorMessage(e)));
  }, [load]);
  const pending = data?.operations.find((op) => pendingStates.includes(op.status));
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load().catch((e) => setError(errorMessage(e))), 5000);
    return () => clearInterval(timer);
  }, [pending, load]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      try {
        await load();
      } catch (e) {
        setError(errorMessage(e));
      }
      setBusy(false);
    }
  }
  function readKit() {
    if (!data) throw new Error('Load the wallet first.');
    return readNativeKit(kitText, data.accountId, data.rpId);
  }
  async function reviewChange(id: string) {
    setReview(await reviewKeyOperation(store, id));
    setApproved(false);
  }
  async function resume(op: KeyOperation) {
    let current = await getKeyOperation(store, op.id);
    if (current.kind === 'add_recovery' && current.status === 'proving')
      current = await proveWalletKit(store, current, kit ?? readKit());
    else current = await continueKeyRegistration(store, current);
    if (current.status === 'awaiting_signature')
      setNotice(
        'New key verified. Review and approve it with an existing wallet passkey, or open this wallet on your old device to approve it there.',
      );
  }
  function downloadKit() {
    if (!kit) return;
    const url = URL.createObjectURL(new Blob([encodeNativeKit(kit)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tendr-wallet-recovery-${kit.accountId.slice(-8)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  }
  const active = data?.keys.filter((k) => k.status === 'active') ?? [];
  const recovery = active.find((k) => k.kind === 'recovery');
  const passkeys = active.filter((k) => k.kind === 'passkey');

  return (
    <section className={styles.panel} aria-label="Wallet devices and recovery">
      <header>
        <span className={styles.eyebrow}>WALLET SECURITY</span>
        <h2>Devices &amp; recovery</h2>
        <p>
          Use the same wallet on your other devices. Each enabled wallet passkey and recovery kit
          has full control of its funds.
        </p>
      </header>
      <p className={styles.note}>
        A synced passkey can already work on another device using the same password manager. You can
        also choose your phone or security key in the passkey prompt. Your{' '}
        <Link href="/settings/login-recovery">login passkeys and recovery codes</Link> are separate.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {!data ? (
        <p>Loading wallet keys…</p>
      ) : (
        <>
          <div className={styles.keyList}>
            {active.map((key) => (
              <div className={styles.keyRow} key={key.id}>
                <div>
                  <strong>{key.label}</strong>
                  <span>
                    {key.kind === 'recovery' ? 'Offline recovery kit' : 'Wallet passkey'} · Enabled
                  </span>
                  <code title={key.publicKey}>{shortKey(key.publicKey)}</code>
                </div>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy || !!pending || (key.kind === 'passkey' && passkeys.length < 2)}
                  onClick={() =>
                    void run(async () => {
                      const op = await revokeWalletKey(store, key.id);
                      await reviewChange(op.id);
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          {pending ? (
            <div className={styles.inset}>
              <h3>Pending: {pending.label}</h3>
              <p role="status">{statusText[pending.status]}</p>
              {pending.candidateKeyId && (
                <code className={styles.fullKey}>
                  {data.keys.find((k) => k.id === pending.candidateKeyId)?.publicKey}
                </code>
              )}
              <p className={styles.note}>
                Compare the key fingerprint with the new device before approval. Only approve a
                request you started. The wallet address stays the same.
              </p>
              {pending.status === 'submitting' ? (
                <p>
                  Waiting for final on-chain confirmation. It is safe to reload; retries use the
                  same signed request.
                </p>
              ) : (
                <div className={styles.actions}>
                  {['registering', 'proving'].includes(pending.status) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => resume(pending))}
                    >
                      Continue on the new device
                    </button>
                  )}
                  {pending.status === 'awaiting_signature' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => reviewChange(pending.id))}
                    >
                      Review {pending.kind === 'recover' ? 'recovery' : 'and approve'}
                    </button>
                  )}
                  {pending.canCancel && (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await cancelKeyOperation(store, pending.id);
                          setReview(null);
                        })
                      }
                    >
                      Cancel request
                    </button>
                  )}
                </div>
              )}
              {!pending.canCancel && pending.status !== 'submitting' && (
                <p className={styles.note}>
                  A signing request has been issued. If you leave it unsigned, it clears after{' '}
                  {new Date(pending.expiresAt).toLocaleTimeString()} once expiry is confirmed
                  on-chain.
                </p>
              )}
              {pending.kind === 'add_recovery' && pending.status === 'proving' && !kit && (
                <label>
                  Saved wallet recovery file
                  <textarea
                    value={kitText}
                    onChange={(e) => setKitText(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the complete JSON file"
                  />
                </label>
              )}
            </div>
          ) : (
            <div className={styles.columns}>
              <div className={styles.inset}>
                <h3>Add another wallet passkey</h3>
                <p>
                  Create it on the device you want to use, then approve it with an existing wallet
                  passkey. You can approve the pending request from your old device.
                </p>
                <label>
                  Device name
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    maxLength={80}
                    placeholder="My iPhone or backup security key"
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !label.trim()}
                  onClick={() =>
                    void run(async () => {
                      await addWalletPasskey(store, label.trim());
                      setNotice(
                        'New passkey verified. Review and approve the pending request with an existing wallet passkey.',
                      );
                    })
                  }
                >
                  Create a wallet passkey
                </button>
              </div>
              <div className={styles.inset}>
                <h3>{recovery ? 'Recovery kit enabled' : 'Protect against losing every device'}</h3>
                <p>
                  {recovery
                    ? 'Keep your saved kit offline. Anyone holding it can control your wallet. Replacing it will revoke the previous kit after confirmation.'
                    : 'Save a recovery kit and enable it with your wallet passkey now. Without an enabled kit or another usable wallet passkey, Tendr cannot restore access to your funds.'}
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setKit(createNativeKit(data.accountId, data.rpId));
                      setDownloaded(false);
                      setConfirmation('');
                      setRecovering(false);
                    }}
                  >
                    {recovery ? 'Replace recovery kit' : 'Create recovery kit'}
                  </button>
                  {recovery && (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => {
                        setRecovering(true);
                        setKit(null);
                      }}
                    >
                      Recover with saved kit
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {kit && !pending && (
            <div className={styles.inset}>
              <h3>Save your wallet recovery kit</h3>
              <p>
                This file controls your wallet. Store it safely outside this device. It will not be
                shown again after you leave this page, and it is not active until you approve it and
                confirmation completes.
              </p>
              <pre className={styles.secret}>{encodeNativeKit(kit)}</pre>
              <button type="button" className={styles.secondary} onClick={downloadKit}>
                Download wallet recovery kit
              </button>
              <label>
                Enter the second group of the secret to confirm you saved it
                <input
                  type="password"
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  maxLength={8}
                />
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy || !downloaded || !matchesConfirmation(kit.secret, confirmation)}
                  onClick={() =>
                    void run(async () => {
                      const op = await enrollWalletKit(store, kit);
                      setKit(null);
                      setConfirmation('');
                      await reviewChange(op.id);
                    })
                  }
                >
                  Continue to wallet approval
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    setKit(null);
                    setConfirmation('');
                  }}
                >
                  Discard this kit
                </button>
              </div>
            </div>
          )}
          {((recovering && !pending) ||
            (pending?.kind === 'recover' && pending.status !== 'submitting')) && (
            <div className={styles.inset}>
              <h3>Recover this wallet</h3>
              <p>
                Create a replacement wallet passkey here, then authorize it using your saved kit.
                This revokes all previous Tendr wallet passkeys. Your wallet address and funds stay
                in place. The recovery kit remains enabled until you replace or remove it.
              </p>
              <label>
                Saved wallet recovery file
                <textarea
                  value={kitText}
                  onChange={(e) => setKitText(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste the complete JSON file. It stays in this browser."
                />
              </label>
              {!pending && (
                <>
                  <label>
                    Replacement device name
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      maxLength={80}
                      placeholder="Replacement laptop"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !label.trim() || !kitText.trim()}
                    onClick={() =>
                      void run(async () => {
                        const restored = readKit();
                        if (!recovery || nativeKitPublicKey(restored) !== recovery.publicKey)
                          throw new Error(
                            'This kit is not the enabled recovery key for this wallet.',
                          );
                        const op = await addWalletPasskey(store, label.trim(), recovery.id);
                        await reviewChange(op.id);
                      })
                    }
                  >
                    Create replacement wallet passkey
                  </button>
                </>
              )}
            </div>
          )}
          {review && (
            <div className={styles.review} aria-label="Review wallet key change">
              <h3>Review wallet key change</h3>
              <p>
                Wallet <code className={styles.fullKey}>{review.accountId}</code>
              </p>
              {review.addedKey && (
                <p>
                  Enable <strong>{review.addedKey.label}</strong>
                  <code className={styles.fullKey}>{review.addedKey.publicKey}</code>
                </p>
              )}
              {review.removedKeys.length > 0 && (
                <div>
                  <strong>Revoke</strong>
                  <ul>
                    {review.removedKeys.map((key) => (
                      <li key={key.id}>
                        {key.label}
                        <code className={styles.fullKey}>{key.publicKey}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                I recognize these keys and understand that every enabled key has full control of
                this wallet.
              </label>
              <button
                type="button"
                disabled={busy || !approved || (review.kind === 'recover' && !kitText.trim())}
                onClick={() =>
                  void run(async () => {
                    const op = await approveWalletKeyChange(
                      store,
                      review,
                      review.kind === 'recover' ? readKit() : undefined,
                    );
                    setKitText('');
                    setReview(null);
                    setApproved(false);
                    setRecovering(false);
                    setNotice(
                      op.status === 'confirmed'
                        ? 'Wallet keys updated.'
                        : 'Signed request submitted. Waiting for final on-chain confirmation.',
                    );
                  })
                }
              >
                {busy
                  ? 'Waiting…'
                  : review.kind === 'recover'
                    ? 'Recover wallet with saved kit'
                    : 'Approve with existing wallet passkey'}
              </button>
            </div>
          )}
          {!pending && data.operations[0] && (
            <p className={styles.note}>
              Latest request: {data.operations[0].label} ·{' '}
              {statusText[data.operations[0].status] ?? data.operations[0].status}
            </p>
          )}
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void run(load)}
          >
            Refresh wallet keys
          </button>
        </>
      )}
    </section>
  );
}
