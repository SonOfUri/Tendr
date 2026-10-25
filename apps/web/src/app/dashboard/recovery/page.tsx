'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { useAction, useLoad, useTick } from '@/components/dashboard/common';
import { countdown } from '@/lib/actions';
import {
  api,
  type MemberKeys,
  type RecoveryParams,
  type RecoveryRequest,
  type SignerChallenge,
  type Team,
} from '@/lib/api';
import { parseRecoveryKit, signRecovery } from '@/lib/recovery-kit';
import { recoveryMessage, validUntilNs, type RecoverySigner } from '@/lib/recovery-payload';
import { signChallenge } from '@/lib/webauthn';

// Recovery always concerns the LIVE account: the recovery kit is registered for it only.
const LIVE = { livemode: true } as const;

export default function RecoveryPage() {
  const { store, context } = useDashboard();
  const status = useLoad(
    () => api<{ recovery: RecoveryRequest | null }>('/v1/account/recovery', LIVE),
    context ? context.merchantId : null,
  );
  const now = useTick(15_000);
  const cancel = useAction();

  if (!store || !context) return null;
  const recovery = status.data?.recovery ?? null;
  const pending = recovery?.status === 'pending';

  async function cancelRecovery() {
    await cancel.run(async () => {
      const ch = await api<SignerChallenge>('/v1/account/recovery/challenge', {
        method: 'POST',
        json: {},
        ...LIVE,
      });
      const response = await signChallenge(ch.challengeB64u, ch.allowCredentials);
      await api('/v1/account/recovery/cancel', { method: 'POST', json: { response }, ...LIVE });
      await status.reload();
    });
  }

  return (
    <div className="stack">
      <div>
        <h1>Recovery</h1>
        <p className="muted">
          If your team loses its passkeys, the recovery kit can replace the live account’s signers.
          Every signer is emailed and has 3 days to stop it.
        </p>
      </div>

      <section className="card">
        <h2>Status</h2>
        {status.error && <Alert tone="danger">{status.error}</Alert>}
        {!status.data ? (
          <Spinner label="Loading" />
        ) : pending && recovery ? (
          <>
            <Alert tone="danger">
              A recovery is pending. It replaces the signers with {recovery.newSignerIds.length} new
              signer{recovery.newSignerIds.length === 1 ? '' : 's'} on{' '}
              {new Date(recovery.executesAt).toLocaleString()} (in{' '}
              {countdown(recovery.executesAt, now)}).
            </Alert>
            {store.isSigner ? (
              <Button onClick={() => void cancelRecovery()} disabled={cancel.busy}>
                {cancel.busy ? 'Waiting for your passkey…' : 'Cancel the recovery with passkey'}
              </Button>
            ) : (
              <p className="muted small">Any signer can cancel it.</p>
            )}
            {cancel.error && <Alert tone="danger">{cancel.error}</Alert>}
          </>
        ) : (
          <p className="muted">
            No recovery is pending.
            {recovery && ` The last one was ${recovery.status}.`}
          </p>
        )}
      </section>

      {!pending && (store.role === 'owner' || store.role === 'admin') && (
        <section className="card">
          <h2>Start a recovery</h2>
          <StartRecovery onStarted={() => void status.reload()} />
        </section>
      )}
      {!pending && store.role !== 'owner' && store.role !== 'admin' && (
        <section className="card" data-testid="recovery-start-restricted">
          <h2>Start a recovery</h2>
          <p className="muted">
            Holding the recovery kit is not enough on its own here: starting a recovery chooses the
            new signers from the team, which only an owner or admin can see. Give the kit to the
            store owner or an admin, or ask them to make you an admin first. If nobody on the team
            can sign in any more, the kit holder can use{' '}
            <Link href="/recover">Lost your passkeys?</Link> to get back in.
          </p>
        </section>
      )}
    </div>
  );
}

interface Candidate {
  membershipId: string;
  userId: string;
  email: string;
  keys: MemberKeys['keys'];
}

function StartRecovery({ onStarted }: { onStarted: () => void }) {
  const { store } = useDashboard();
  const people = useLoad<Candidate[]>(async () => {
    const team = await api<Team>('/v1/team', LIVE);
    const eligible = team.members.filter((m) => m.role !== 'viewer');
    const withKeys = await Promise.all(
      eligible.map(async (m) => {
        const k = await api<MemberKeys>(`/v1/team/${m.id}/signer-keys`, LIVE);
        return { membershipId: m.id, userId: m.userId, email: m.email, keys: k.keys };
      }),
    );
    // Only people with a passkey can be signers.
    return withKeys.filter((c) => c.keys.length > 0);
  }, store?.id ?? null);
  const [kit, setKit] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(1);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  if (!store) return null;
  if (people.error) return <Alert tone="danger">{people.error}</Alert>;
  if (!people.data) return <Spinner label="Loading the team" />;

  const selected = people.data.filter((c) => chosen.includes(c.userId));

  async function start(e: React.FormEvent) {
    e.preventDefault();
    const res = await run(async () => {
      if (selected.length === 0) throw new Error('Choose at least one new signer.');
      if (threshold < 1 || threshold > selected.length) {
        throw new Error('The approval rule must be between 1 and the number of new signers.');
      }
      const params = await api<RecoveryParams>('/v1/account/recovery/params', LIVE);
      if (!params.recoveryKeySet) throw new Error('The live account has no recovery kit.');
      const newSigners: RecoverySigner[] = selected.map((c) => ({ id: c.userId, keys: c.keys }));
      const nonce = BigInt(params.lastNonce) + 1n;
      const validUntil = validUntilNs();
      const message = recoveryMessage({
        contractId: params.accountId,
        newSigners,
        newThreshold: threshold,
        nonce,
        recoveryKeyEpoch: BigInt(params.recoveryKeyEpoch),
        validUntil,
      });
      // Signed here; the kit itself is never sent anywhere. Its bytes are wiped after signing.
      const secret = parseRecoveryKit(kit);
      let signature: string;
      try {
        signature = signRecovery(secret, message);
      } finally {
        secret.fill(0);
        setKit('');
      }
      return api<{ recovery: RecoveryRequest | null }>('/v1/account/recovery/start', {
        method: 'POST',
        store: false,
        json: {
          accountId: params.accountId,
          livemode: true,
          newSigners,
          newThreshold: threshold,
          nonce: nonce.toString(),
          validUntil: validUntil.toString(),
          signature,
        },
      });
    });
    if (res) {
      setDone(
        res.recovery
          ? `Recovery started. It completes ${new Date(res.recovery.executesAt).toLocaleString()} unless a signer cancels it.`
          : 'Recovery started.',
      );
      onStarted();
    }
  }

  if (done) return <Alert tone="success">{done}</Alert>;

  return (
    <form className="form" onSubmit={start}>
      <p className="muted">
        Use this only when the current signers can no longer approve (lost every passkey). The
        people you choose become the account’s only signers after 3 days.
      </p>
      <label className="field">
        <span>Your recovery kit</span>
        <textarea
          name="recovery-kit"
          rows={3}
          value={kit}
          onChange={(e) => setKit(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="Type or paste the code from your kit (ABCD-EFGH-…)"
        />
      </label>
      <p className="muted small">
        The kit stays in this browser: it signs the request here and is cleared right after.
      </p>

      <fieldset className="field">
        <legend>New signers</legend>
        {people.data.length === 0 ? (
          <p className="muted small">
            Nobody on the team has a passkey yet. New signers need one: invite them first.
          </p>
        ) : (
          people.data.map((c) => (
            <label key={c.userId}>
              <input
                type="checkbox"
                checked={chosen.includes(c.userId)}
                onChange={(e) =>
                  setChosen((prev) =>
                    e.target.checked ? [...prev, c.userId] : prev.filter((x) => x !== c.userId),
                  )
                }
              />{' '}
              {c.email}{' '}
              <span className="muted small">
                ({c.keys.length} passkey{c.keys.length === 1 ? '' : 's'})
              </span>
            </label>
          ))
        )}
      </fieldset>

      <label className="field">
        <span>Approvals needed afterwards</span>
        <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
          {Array.from({ length: Math.max(selected.length, 1) }, (_, i) => i + 1).map((i) => (
            <option key={i} value={i}>
              {i} of {Math.max(selected.length, 1)}
            </option>
          ))}
        </select>
      </label>

      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy || !kit.trim() || selected.length === 0}>
        {busy ? 'Signing…' : 'Sign with the kit and start recovery'}
      </Button>
    </form>
  );
}
