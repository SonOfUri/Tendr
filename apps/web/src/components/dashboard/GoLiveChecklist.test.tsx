import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GoLiveStatus } from '@/lib/api';
import { GoLiveChecklist } from './GoLiveChecklist';

function items(missing: GoLiveStatus['checklist']['missing']): string[] {
  const html = renderToStaticMarkup(
    <GoLiveChecklist
      checklist={{ ok: missing.length === 0, missing, signerCount: 2, recoveryKeySet: true }}
    />,
  );
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!);
}

const MESSAGE = 'Live payments are not open yet. Test mode works as usual.';

describe('GoLiveChecklist', () => {
  it('lists live payments not being open first, with the API message, when the status says so', () => {
    const list = items(['live_mode_unavailable', 'second_key']);
    expect(list).toHaveLength(4);
    expect(list[0]).toContain(MESSAGE);
    expect(list[0]).toContain('(to do)');
    expect(list.slice(1).join('')).not.toContain(MESSAGE);
  });

  it('leaves it out when live payments are open', () => {
    const list = items([]);
    expect(list).toHaveLength(3);
    expect(list.join('')).not.toContain(MESSAGE);
    expect(list[0]).toContain('Your passkey');
  });
});
