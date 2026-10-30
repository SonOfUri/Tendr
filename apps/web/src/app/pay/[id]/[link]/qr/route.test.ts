import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchPublicLink = vi.fn();
vi.mock('@/lib/payment-links', () => ({
  fetchPublicLink: (...a: unknown[]) => fetchPublicLink(...a),
  payerIpFrom: () => '203.0.113.7',
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { GET } from './route';

const VIEW = { merchant: { name: 'Acme', logo_url: null }, title: 'T' };
const ctx = (id = 'acme', link = 'tee') => ({ params: Promise.resolve({ id, link }) });
const req = (qs = '') => new Request(`http://localhost:3000/pay/acme/tee/qr${qs}`);

beforeEach(() => {
  vi.stubEnv('WEB_URL', 'https://usetendr.tech');
  fetchPublicLink.mockResolvedValue(VIEW);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fetchPublicLink.mockReset();
});

describe('qr route', () => {
  it('qr route returns png and svg encoding the link url', async () => {
    const url = 'https://usetendr.tech/pay/acme/tee';
    const png = await GET(req(), ctx());
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('public, max-age=300');
    const body = Buffer.from(await png.arrayBuffer());
    expect(body.subarray(1, 4).toString()).toBe('PNG');
    expect(body.readUInt32BE(16)).toBe(1024); // IHDR width
    const expected = await QRCode.toBuffer(url, {
      type: 'png',
      width: 1024,
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    expect(body.equals(expected)).toBe(true);

    const svg = await GET(req('?format=svg'), ctx());
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe('public, max-age=300');
    const expectedSvg = await QRCode.toString(url, {
      type: 'svg',
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    expect(await svg.text()).toBe(expectedSvg);
    expect(fetchPublicLink).toHaveBeenCalledWith('acme', 'tee', false, '203.0.113.7');
  });

  it('qr for a test link encodes ?mode=test', async () => {
    const res = await GET(req('?mode=test&format=svg'), ctx());
    const expected = await QRCode.toString('https://usetendr.tech/pay/acme/tee?mode=test', {
      type: 'svg',
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    expect(await res.text()).toBe(expected);
    expect(fetchPublicLink).toHaveBeenCalledWith('acme', 'tee', true, '203.0.113.7');
  });

  it('qr encodes the CHECKOUT_BASE_URL link when it differs from WEB_URL', async () => {
    vi.stubEnv('CHECKOUT_BASE_URL', 'https://pay.example.com/');
    const res = await GET(req('?format=svg'), ctx());
    const expected = await QRCode.toString('https://pay.example.com/pay/acme/tee', {
      type: 'svg',
      margin: 4,
      errorCorrectionLevel: 'M',
    });
    expect(await res.text()).toBe(expected);
  });

  it('qr 404 for unknown link', async () => {
    fetchPublicLink.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(404);
  });

  it('qr 404 without calling the API for a malformed slug', async () => {
    expect((await GET(req(), ctx('acme', 'Bad_Slug'))).status).toBe(404);
    expect(fetchPublicLink).not.toHaveBeenCalled();
  });
});
