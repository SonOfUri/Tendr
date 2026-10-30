// The preview card's merchant logo (spec §4.1). `logo_url` is merchant-supplied free text, so the
// renderer never fetches an arbitrary URL: only an https URL on Tendr's own asset origin
// (`TENDR_ASSET_ORIGIN`), with a short timeout, no redirects, an image content type and a size cap.
// Anything else yields null and the card draws the merchant's initial.

export const LOGO_MAX_BYTES = 1_000_000;
const LOGO_TIMEOUT_MS = 3000;

/** The logo's bytes, or null when it must not (or cannot) be fetched. */
export async function safeLogo(url: string | null): Promise<ArrayBuffer | null> {
  const origin = process.env.TENDR_ASSET_ORIGIN;
  if (!url || !origin) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) return null;

  try {
    const res = await fetch(parsed, {
      signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok || !res.body) return null;
    if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) return null;

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LOGO_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out.buffer;
  } catch {
    return null;
  }
}
