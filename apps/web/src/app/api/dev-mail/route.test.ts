import { afterEach, describe, expect, it, vi } from 'vitest';
const read = vi.fn(async () => [{ to: 'test@example.com', data: { url: 'local-test-link' } }]);
vi.mock('@/lib/local-mail.server', () => ({ readLocalMail: () => read() }));
const { GET } = await import('./route');
const flags = {
  NODE_ENV: 'development',
  API_CONSOLE_ENABLED: 'true',
  MAIL_DRIVER: 'log',
  WEB_URL: 'http://localhost:3300',
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:4300',
};
afterEach(() => {
  vi.unstubAllEnvs();
  read.mockClear();
});

describe('local inbox route', () => {
  it('does not read the mail directory in production even with the console enabled', async () => {
    for (const [key, value] of Object.entries(flags)) vi.stubEnv(key, value);
    vi.stubEnv('NODE_ENV', 'production');
    const response = await GET(new Request('http://localhost:3300/api/dev-mail'));
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('serves messages only to the local app, without cache or CORS permission', async () => {
    for (const [key, value] of Object.entries(flags)) vi.stubEnv(key, value);
    const denied = await GET(
      new Request('http://localhost:3300/api/dev-mail', {
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(denied.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    const allowed = await GET(new Request('http://localhost:3300/api/dev-mail'));
    expect(allowed.status).toBe(200);
    expect(read).toHaveBeenCalledOnce();
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(allowed.headers.get('access-control-allow-origin')).toBeNull();
    expect((await allowed.json()).messages).toHaveLength(1);
  });
});
