import { env } from '../env.js';
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
      throw new Error('KEYVAULT_DRIVER=gcp is not implemented until Task 7 (GcpKeyVault)');
  }
}
