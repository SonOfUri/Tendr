// Loads a family's adapter (and through it the wallet SDK). Imported on demand only, from
// `adapterFor(...).load()` in ./index.ts, so its dynamic imports stay out of the first load.
import { publicEnv } from '@/lib/env';
import { WalletError } from './errors';
import { needsReown, type PayTarget, type WalletAdapter, type WalletEnv } from './index';

/** Whether this page connects EVM wallets without Reown (end-to-end tests only). */
const injectedEvm = (family: PayTarget['family']) =>
  family === 'evm' &&
  publicEnv.e2eInjectedWallet &&
  typeof window !== 'undefined' &&
  'ethereum' in window;

export async function loadAdapter(target: PayTarget, env: WalletEnv): Promise<WalletAdapter> {
  if (injectedEvm(target.family)) {
    const { createEvmAdapter, injectedEvmSession } = await import('./evm');
    return createEvmAdapter(
      target,
      injectedEvmSession(window as never),
      target.network === 'testnet' ? undefined : evmGasless(),
    );
  }
  if (needsReown(target.family) && !env.reownProjectId) {
    throw new WalletError('unavailable', { detail: 'no Reown project id' });
  }
  switch (target.family) {
    case 'evm': {
      const [{ createEvmAdapter }, { appKitSession }] = await Promise.all([
        import('./evm'),
        import('./appkit'),
      ]);
      return createEvmAdapter(
        target,
        appKitSession('eip155', env.reownProjectId!),
        target.network === 'testnet' ? undefined : evmGasless(),
      );
    }
    case 'solana': {
      const [{ createSolanaAdapter, solanaConnection }, { appKitSession }] = await Promise.all([
        import('./solana'),
        import('./appkit'),
      ]);
      return createSolanaAdapter(target, {
        session: appKitSession('solana', env.reownProjectId!, target.network === 'testnet'),
        connection: () => solanaConnection(env.reownProjectId!, target.network === 'testnet'),
      });
    }
    case 'bitcoin': {
      const [{ createBitcoinAdapter }, { appKitSession }] = await Promise.all([
        import('./bitcoin'),
        import('./appkit'),
      ]);
      return createBitcoinAdapter(target, {
        session: appKitSession('bip122', env.reownProjectId!),
      });
    }
    case 'tron': {
      const { createTronAdapter } = await import('./tron');
      return createTronAdapter(target, {
        win: window as never,
        forwarder: publicEnv.tronForwarderAddress,
      });
    }
    case 'near': {
      const { createNearAdapter, nearSelectorDeps } = await import('./near');
      return createNearAdapter(
        target,
        nearSelectorDeps(env.pickNearWallet, target.network === 'testnet'),
      );
    }
  }
}

function evmGasless() {
  return {
    forwarder: publicEnv.evmForwarderAddress,
    paymasterUrlPrefix: `${publicEnv.apiBaseUrl}/v1/checkout/paymaster/`,
  };
}
