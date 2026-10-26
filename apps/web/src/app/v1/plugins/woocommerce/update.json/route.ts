// `GET /v1/plugins/woocommerce/update.json` — the plugin's update feed (spec §9). The manifest is
// imported, so it is fixed at build time: the release build writes it before `next build`. The
// download URL is built from WEB_URL at request time.
import manifest from '../../../../../../public/downloads/woocommerce/manifest.json';
import { serverEnv } from '@/lib/env';
import { updateFeedResponse, type PluginManifest } from '@/lib/plugin-update';

export function GET(): Response {
  return updateFeedResponse(manifest as PluginManifest, serverEnv().webUrl);
}
