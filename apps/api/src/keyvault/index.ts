import { KeyManagementServiceClient } from '@google-cloud/kms';
import { env } from '../env.js';
import { GcpKeyVault } from './gcp.js';
import { LocalKeyVault } from './local.js';
import type { KeyVault } from './types.js';

export type { Curve, Envelope, KeyName, KeyVault, Signature } from './types.js';
export { KEY_NAMES, curveOf, nearPublicKey } from './keys.js';
export { derToRsv, evmAddress } from './secp256k1.js';

let vault: KeyVault | null = null;

/** The process-wide key vault, chosen by `KEYVAULT_DRIVER`. */
export function getKeyVault(): KeyVault {
  if (vault) return vault;
  const e = env();
  switch (e.KEYVAULT_DRIVER) {
    case 'local':
      vault = new LocalKeyVault(e.LOCAL_KEYVAULT_PATH);
      return vault;
    case 'gcp':
      // env() has already required these when KEYVAULT_DRIVER=gcp.
      vault = new GcpKeyVault({
        client: new KeyManagementServiceClient({
          projectId: e.GCP_PROJECT_ID!,
          credentials: JSON.parse(e.GCP_CREDENTIALS_JSON!) as Record<string, string>,
        }),
        projectId: e.GCP_PROJECT_ID!,
        location: e.GCP_KMS_LOCATION!,
        keyRing: e.GCP_KMS_KEYRING!,
        kekKey: e.GCP_KMS_KEK,
      });
      return vault;
  }
}
