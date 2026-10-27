import { describe, expect, it } from 'vitest';
import { ConnectReplaceRequestSchema, ConnectReplaceResponseSchema } from './connect.js';

describe('ConnectReplaceRequestSchema', () => {
  it('takes the successor connection id only', () => {
    expect(ConnectReplaceRequestSchema.parse({ successor_connection_id: 'con_1' })).toEqual({
      successor_connection_id: 'con_1',
    });
  });

  it('refuses an empty id, a missing id and extra keys', () => {
    expect(ConnectReplaceRequestSchema.safeParse({ successor_connection_id: '' }).success).toBe(
      false,
    );
    expect(ConnectReplaceRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ConnectReplaceRequestSchema.safeParse({ successor_connection_id: 'con_1', site_url: 'x' })
        .success,
    ).toBe(false);
  });

  it('response names the old connection and its successor', () => {
    expect(
      ConnectReplaceResponseSchema.parse({ connection_id: 'con_a', replaced_by: 'con_b' }),
    ).toEqual({ connection_id: 'con_a', replaced_by: 'con_b' });
  });
});
