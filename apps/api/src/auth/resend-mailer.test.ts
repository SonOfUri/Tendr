import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../env.js';
import { getMailer, setMailer } from './mailer.js';
import { ResendMailer } from './resend-mailer.js';

const KEY = 're_secret_key_123';
const msg = {
  to: 'a@b.co',
  template: 'login_link' as const,
  data: { url: 'https://app.usetendr.tech/verify?token=a' },
};

function stubFetch(status: number, body = '{"id":"em_1"}') {
  return vi.fn(async (_url: unknown, _init?: unknown) => new Response(body, { status }));
}

afterEach(() => {
  setMailer(null);
  vi.restoreAllMocks();
  loadEnv(); // the suite's own environment, back in the cache
});

describe('ResendMailer', () => {
  it('posts one email to Resend with the key only in the Authorization header', async () => {
    const f = stubFetch(200);
    await new ResendMailer({
      apiKey: KEY,
      from: 'Tendr <no-reply@usetendr.tech>',
      fetch: f as never,
    }).send(msg);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(body.from).toBe('Tendr <no-reply@usetendr.tech>');
    expect(body.to).toEqual(['a@b.co']);
    expect(body.text).toContain(msg.data.url);
    expect(init.body as string).not.toContain(KEY);
    expect(init.signal).toBeDefined();
  });

  it.each([422, 500])('throws on a %i without leaking the key', async (status) => {
    const f = stubFetch(status, '{"message":"bad"}');
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    }
    const err = await new ResendMailer({ apiKey: KEY, from: 'T <t@x.co>', fetch: f as never })
      .send(msg)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(String(status));
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err as object))).not.toContain(KEY);
    expect(logs.join('')).not.toContain(KEY);
  });

  it('throws without the key when fetch itself fails', async () => {
    const f = vi.fn(async () => {
      throw new Error(`network down (Bearer ${KEY})`);
    });
    const err = await new ResendMailer({ apiKey: KEY, from: 'T <t@x.co>', fetch: f as never })
      .send(msg)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err as object))).not.toContain(KEY);
  });
});

describe('mail driver selection', () => {
  const prodBase = {
    DATABASE_URL: 'postgresql://x/y',
    REDIS_URL: 'redis://localhost:6380',
    NODE_ENV: 'production',
  };

  it('production with no driver and no RESEND_API_KEY fails naming RESEND_API_KEY', () => {
    expect(() => loadEnv(prodBase)).toThrow(/RESEND_API_KEY/);
  });

  it('defaults MAIL_FROM', () => {
    expect(loadEnv({ DATABASE_URL: 'postgresql://x/y', REDIS_URL: 'redis://l:1' }).MAIL_FROM).toBe(
      'Tendr <no-reply@usetendr.tech>',
    );
  });

  it('getMailer returns a ResendMailer when the driver is resend', () => {
    loadEnv({
      DATABASE_URL: 'postgresql://x/y',
      REDIS_URL: 'redis://l:1',
      MAIL_DRIVER: 'resend',
      RESEND_API_KEY: KEY,
    });
    setMailer(null);
    expect(getMailer()).toBeInstanceOf(ResendMailer);
  });
});
