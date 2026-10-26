// The WooCommerce plugin's update feed (spec §9): `GET /v1/plugins/woocommerce/update.json`, read
// by the plugin through the standard WordPress update hooks. It comes from the build-time manifest
// `public/downloads/woocommerce/manifest.json`, which the release build writes next to the zip.
// The committed placeholder is version `0.0.0` with no zip: no feed (404) until a real release.

export interface PluginManifest {
  version: string;
  /** The zip's file name in `public/downloads/woocommerce/`, or null before the first release. */
  file: string | null;
  /** The zip's sha256 (hex), or null before the first release. */
  sha256: string | null;
  /** Minimum WordPress version. */
  requires: string;
  /** WordPress version tested up to. */
  tested: string;
  requires_php: string;
}

export interface UpdateFeed {
  version: string;
  download_url: string;
  sha256: string;
  requires: string;
  tested: string;
  requires_php: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ZIP_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The zip's path on this site, or null when there is no published release. */
export function downloadPath(m: PluginManifest): string | null {
  if (!VERSION.test(m.version) || m.version === '0.0.0') return null;
  if (!m.file || !ZIP_FILE.test(m.file) || m.file.includes('..')) return null;
  if (!m.sha256 || !SHA256.test(m.sha256)) return null;
  return `/downloads/woocommerce/${m.file}`;
}

export function updateFeed(m: PluginManifest, webUrl: string): UpdateFeed | null {
  const path = downloadPath(m);
  if (!path) return null;
  return {
    version: m.version,
    download_url: new URL(path, webUrl).toString(),
    sha256: m.sha256!,
    requires: m.requires,
    tested: m.tested,
    requires_php: m.requires_php,
  };
}

export function updateFeedResponse(m: PluginManifest, webUrl: string): Response {
  const feed = updateFeed(m, webUrl);
  if (!feed) {
    return Response.json(
      { error: { code: 'NOT_FOUND', message: 'No plugin release is published yet' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }
  return Response.json(feed, {
    headers: { 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' },
  });
}
