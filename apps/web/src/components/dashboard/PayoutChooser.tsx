'use client';

// Choose where a store's payments settle (lib/payout.ts): in the Connect popup (an explicit store,
// test mode, `onDone` moves on to approving the site) and on the dashboard's Payout page (the
// tab's store and mode). Choosing drafts a `set_settlement` proposal and approves it with this
// person's passkey. With one signer it executes at once; with more, it waits for the others, and
// the popup still lets the site connect (its status then reports the missing payout).
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@tendr/ui';
import { api, errorMessage, type StoreContext } from '@/lib/api';
import {
  afterApproval,
  defaultChoice,
  payoutAttempt,
  payoutStep,
  settlementAction,
  type OwnDraft,
  type SettlementView,
} from '@/lib/payout';
import { approveProposal, cancelProposal, draftProposal } from '@/lib/proposals';

const POLL_MS = 3000;

type Outcome = { k: 'done'; symbol: string } | { k: 'needs-signers' } | null;

export function PayoutChooser({
  store,
  storeName,
  onDone,
}: {
  /** The store and mode; the tab's store when omitted (dashboard). */
  store?: StoreContext;
  storeName: string;
  /** The Connect popup: called to move on (set, waiting, skipped). */
  onDone?: () => void;
}) {
  const [view, setView] = useState<SettlementView | null>(null);
  const [chosen, setChosen] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  // A draft an earlier attempt made whose passkey prompt failed: approved on the retry (C14).
  const [ownDraft, setOwnDraft] = useState<OwnDraft | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api<SettlementView>('/v1/account/settlement', { store });
      setView(v);
      setChosen((c) => c || defaultChoice(v)?.asset || '');
      return v;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [store]);

  useEffect(() => {
    void load().then((v) => {
      // The popup skips this step for a store whose payout is already set.
      if (v && onDone && payoutStep(v) === 'set') onDone();
    });
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new store's account is created by a job: wait for it.
  const step = view ? payoutStep(view) : null;
  useEffect(() => {
    if (step !== 'account-pending') return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [step, load]);

  async function approve() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = payoutAttempt(ownDraft, chosen);
      let id: string;
      if (attempt.k === 'reuse') {
        id = attempt.id;
      } else {
        if (attempt.k === 'replace') {
          await cancelProposal({ id: attempt.cancel, status: 'draft' }, store);
          setOwnDraft(null);
        }
        id = (await draftProposal(settlementAction(chosen), store)).id;
        setOwnDraft({ id, asset: chosen });
      }
      const p = await approveProposal(id, store);
      setOwnDraft(null);
      const next = afterApproval(p.status);
      if (next === 'failed') {
        setError('The payout change did not go through. Try again.');
      } else {
        const symbol = view?.choices.find((c) => c.asset === chosen)?.symbol ?? chosen;
        setOutcome(next === 'done' ? { k: 'done', symbol } : { k: 'needs-signers' });
      }
      void load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const later = onDone ? (
    <p className="muted small">
      Not now?{' '}
      <button type="button" className="link-button" onClick={onDone}>
        Set up payout later
      </button>{' '}
      — the site still connects, but it can’t take payments until a payout is set under Payout on
      your dashboard.
    </p>
  ) : null;
  const next = onDone ? <Button onClick={onDone}>Continue</Button> : null;
  const modeWord = view?.livemode ? 'live' : 'test';

  if (outcome?.k === 'done') {
    return (
      <>
        <Alert tone="success">
          Payout set: {storeName}’s {modeWord} payments settle in {outcome.symbol} into its tendr
          account.
        </Alert>
        {next}
      </>
    );
  }
  if (outcome?.k === 'needs-signers') {
    return (
      <>
        <Alert tone="warning">
          Your approval is in. {storeName} needs more of its signers to approve this payout before
          it takes effect; until then payments can’t be taken.
          {onDone ? ' The site can still connect now.' : ''}
        </Alert>
        {onDone ? next : <Link href="/dashboard/approvals">See approvals</Link>}
      </>
    );
  }
  if (!view) {
    return error ? (
      <>
        <Alert tone="danger">{error}</Alert>
        {later}
      </>
    ) : (
      <Spinner label="Loading payout" />
    );
  }

  if (step === 'set') {
    const s = view.settlement!;
    return (
      <>
        <p>
          {storeName}’s {modeWord} payments settle in <strong>{s.symbol ?? s.asset}</strong> into
          its tendr account. Changing it is a proposal your signers approve.
        </p>
        {next}
      </>
    );
  }
  if (step === 'waiting') {
    const pendingId = view.pending!.id;
    const approvalHref = `/dashboard/approvals/${pendingId}`;
    async function approvePending() {
      setBusy(true);
      setError(null);
      try {
        const p = await approveProposal(pendingId, store);
        const nextOutcome = afterApproval(p.status);
        if (nextOutcome === 'failed') {
          setError('The payout change did not go through. Try again.');
        } else if (nextOutcome === 'done') {
          const refreshed = await load();
          setOutcome({
            k: 'done',
            symbol: refreshed?.settlement?.symbol ?? 'your settlement token',
          });
        } else {
          setOutcome({ k: 'needs-signers' });
          void load();
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    }
    return (
      <>
        <Alert tone="warning">
          A payout change for {storeName} is waiting for a passkey approval
          {view.pending?.status === 'pending' ? ' from every required signer' : ''}. Payments can’t
          be taken until it finishes.
        </Alert>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {onDone ? (
          next
        ) : (
          <div className="actions">
            <Button disabled={busy} onClick={() => void approvePending()}>
              {busy ? 'Waiting for your passkey…' : 'Approve with passkey'}
            </Button>
            <Link href={approvalHref}>View proposal</Link>
          </div>
        )}
      </>
    );
  }
  if (step === 'not-live') {
    return (
      <>
        <Alert tone="info">
          Available after you go live: {storeName} has no live account yet. Set where live payments
          settle once it is live.
        </Alert>
        {onDone ? next : <Link href="/dashboard/account">Go live</Link>}
      </>
    );
  }
  if (step === 'account-pending') {
    return (
      <>
        <Spinner label={`Setting up ${storeName}’s ${modeWord} account`} />
        <p className="muted small">This usually takes a few seconds.</p>
        {later}
      </>
    );
  }
  if (step === 'account-failed') {
    return (
      <>
        <Alert tone="danger">
          {storeName}’s {modeWord} account could not be created. Retry it from your dashboard, then
          set the payout.
        </Alert>
        {later}
      </>
    );
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void approve();
      }}
    >
      <fieldset>
        <legend>Settle {modeWord} payments in</legend>
        <ul className="choices">
          {view.choices.map((c) => (
            <li key={c.asset}>
              <label>
                <input
                  type="radio"
                  name="settlement"
                  value={c.asset}
                  checked={chosen === c.asset}
                  onChange={() => setChosen(c.asset)}
                />
                <span className="grow">
                  <strong>{c.symbol}</strong>{' '}
                  <span className="muted small">on NEAR{c.default ? ' · recommended' : ''}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="muted small">
        Shoppers pay with any token they like; {storeName} receives this one in its own tendr
        account. Approving needs your passkey.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" disabled={busy || !chosen}>
        {busy ? 'Waiting for your passkey…' : 'Approve payout'}
      </Button>
      {later}
    </form>
  );
}
