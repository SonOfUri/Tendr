import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';

describe('newId', () => {
  it('prefixed ULIDs sort by creation time', async () => {
    const a = newId('evt');
    await sleep(2);
    const b = newId('evt');
    expect(a).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
