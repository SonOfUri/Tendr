// The WooCommerce plugin download (spec §9). The zip and its manifest are written by the release
// build into public/downloads/woocommerce/; until then the manifest is the 0.0.0 placeholder and
// no download is offered.
import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@tendr/ui';
import manifest from '../../../../public/downloads/woocommerce/manifest.json';
import { downloadPath, type PluginManifest } from '@/lib/plugin-update';

export const metadata: Metadata = {
  title: 'tendr for WooCommerce · Download',
  description: 'Accept crypto payments in your WooCommerce store with tendr.',
};

export default function WooCommerceDownloadPage() {
  const m = manifest as PluginManifest;
  const href = downloadPath(m);
  return (
    <section className="section">
      <h1>tendr for WooCommerce</h1>
      <p className="lead muted">
        Take crypto payments in your WooCommerce store. Shoppers pay with the token and chain they
        already hold; you receive stablecoins in your tendr account.
      </p>
      {href ? (
        <div className="stack">
          <div className="cta-row">
            <a href={href} download>
              <Button>Download the plugin (version {m.version})</Button>
            </a>
          </div>
          <p className="muted small">
            SHA-256: <code className="address">{m.sha256}</code>
          </p>
        </div>
      ) : (
        <p className="muted">The plugin is not published yet. Check back soon.</p>
      )}
      <p className="muted small">
        Needs WordPress {m.requires} or later, WooCommerce 8.5 or later and PHP {m.requires_php} or
        later. Licensed GPL-2.0-or-later.
      </p>

      <h2>Install</h2>
      <ol>
        <li>Download the zip above.</li>
        <li>
          In your WordPress admin, open <strong>Plugins → Add New → Upload Plugin</strong>, choose
          the zip and select <strong>Install Now</strong>, then <strong>Activate</strong>.
        </li>
        <li>
          Open <strong>WooCommerce → Settings → Payments → tendr</strong> and select{' '}
          <strong>Connect to tendr</strong>.
        </li>
        <li>
          In the window that opens, sign in or create your tendr account, choose your store and
          approve the connection with your passkey.
        </li>
        <li>
          Use <strong>Make a test purchase</strong> to try a payment in test mode. When you are
          ready, switch to Live mode.
        </li>
      </ol>
      <p className="muted small">
        Updates arrive through the normal WordPress <em>Update now</em> button. New to tendr?{' '}
        <Link href="/signup">Create an account</Link>.
      </p>
    </section>
  );
}
