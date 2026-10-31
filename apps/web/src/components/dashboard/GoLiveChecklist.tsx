import Link from 'next/link';
import type { GoLiveStatus } from '@/lib/api';

/** What going live needs, from GET /v1/account/go-live. */
export function GoLiveChecklist({ checklist }: { checklist: GoLiveStatus['checklist'] }) {
  return (
    <ul className="checklist">
      {checklist.missing.includes('live_mode_unavailable') && (
        <ChecklistItem done={false} label="Live payments">
          Live payments are not open yet. Test mode works as usual.
        </ChecklistItem>
      )}
      <ChecklistItem done label="Your passkey">
        You sign in and approve with it.
      </ChecklistItem>
      <ChecklistItem done={!checklist.missing.includes('second_key')} label="A second key">
        {checklist.signerCount} signer{checklist.signerCount === 1 ? '' : 's'}
        {checklist.recoveryKeySet ? ' and a recovery kit' : ', no recovery kit yet'}.{' '}
        {checklist.missing.includes('second_key') && (
          <Link href="/dashboard/onboarding/second-key">Add one</Link>
        )}
      </ChecklistItem>
      <ChecklistItem done={!checklist.missing.includes('threshold')} label="Approval rule">
        One signer’s approval moves money to start with; you can require more later.
      </ChecklistItem>
    </ul>
  );
}

function ChecklistItem({
  done,
  label,
  children,
}: {
  done: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className={done ? 'done' : 'todo'}>
      <span aria-hidden>{done ? '✓' : '○'}</span>
      <div>
        <strong>{label}</strong>
        <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
        <p className="muted small">{children}</p>
      </div>
    </li>
  );
}
