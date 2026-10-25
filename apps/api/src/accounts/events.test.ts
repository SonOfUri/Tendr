import { describe, expect, it } from 'vitest';
import { eventLog, nsToDate, parseAccountEvents } from './events.js';

describe('parseAccountEvents', () => {
  it('reads the contract events in order and skips everything else', () => {
    const logs = [
      'plain text log',
      eventLog('proposal_created', { proposal_id: 'aa', signer_id: 'per_1' }),
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{}]}',
      'EVENT_JSON:{not json',
      'EVENT_JSON:{"standard":"tendr-merchant-account","version":"1.0.0","event":"made_up","data":{}}',
      'EVENT_JSON:{"standard":"tendr-merchant-account","version":"1.0.0","event":"proposal_approved","data":[{}]}',
      eventLog('timelock_started', { proposal_id: 'aa', ready_at: '86400000000000' }),
    ];
    const events = parseAccountEvents(logs);
    expect(events.map((e) => e.event)).toEqual(['proposal_created', 'timelock_started']);
    expect(events[0]!.data).toEqual({ proposal_id: 'aa', signer_id: 'per_1' });
  });

  it('converts nanosecond timestamps', () => {
    expect(nsToDate('86400000000000')?.toISOString()).toBe('1970-01-02T00:00:00.000Z');
    expect(nsToDate('x')).toBeNull();
  });
});
