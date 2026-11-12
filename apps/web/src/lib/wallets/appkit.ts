// Reown AppKit (WalletConnect plus injected wallets) for EVM, Solana and Bitcoin. Loaded only when
// the shopper clicks "Connect wallet": this module is itself imported on demand (wallets/index.ts)
// and imports the SDK with dynamic import(), so none of it is in the checkout's first load.
//
// One AppKit instance per page, created on first use, with mainnets and Tidepool test networks.
// Its extras are off:
// analytics, email and social logins (the embedded wallet frame), swaps, on-ramp, send, history,
// Coinbase's SDK. Fonts: the checkout's own, so no font is fetched from Reown.
import type { AppKit } from '@reown/appkit';
import { setWalletModalOpen } from './modal-state';

export type AppKitNamespace = 'eip155' | 'solana' | 'bip122';

/** A family's view of the shared AppKit: connect, the connected wallet's provider, network. */
export interface AppKitSession<P> {
  connect(): Promise<{ address: string }>;
  provider(): P | undefined;
  /** Solana / Bitcoin: switches to the requested network; false if the wallet cannot do so. */
  ensureNetwork(): Promise<boolean>;
  disconnect(): Promise<void>;
}

const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dKmFq';
const BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93';

let instance: Promise<AppKit> | null = null;

async function loadAppKit(projectId: string): Promise<AppKit> {
  if (!instance) {
    instance = (async () => {
      const [{ createAppKit }, n, { EthersAdapter }, { SolanaAdapter }, { BitcoinAdapter }] =
        await Promise.all([
          import('@reown/appkit'),
          import('@reown/appkit/networks'),
          import('@reown/appkit-adapter-ethers'),
          import('@reown/appkit-adapter-solana'),
          import('@reown/appkit-adapter-bitcoin'),
        ]);
      const kit = createAppKit({
        projectId,
        // EVM through the ethers adapter (injected EIP-6963 wallets and WalletConnect). The wagmi
        // adapter pulls in Coinbase's CDP SDK, whose optional x402 modules break the build.
        adapters: [new EthersAdapter(), new SolanaAdapter(), new BitcoinAdapter()],
        networks: [
          n.mainnet,
          n.base,
          n.baseSepolia,
          n.arbitrum,
          n.optimism,
          n.polygon,
          n.bsc,
          n.avalanche,
          n.gnosis,
          n.berachain,
          n.solana,
          n.solanaDevnet,
          n.bitcoin,
        ],
        metadata: {
          name: 'Tendr checkout',
          description: 'Pay from your wallet',
          url: window.location.origin,
          icons: [],
        },
        themeMode: 'light',
        themeVariables: { '--w3m-font-family': 'inherit', '--w3m-z-index': 1000 },
        enableCoinbase: false,
        enableReconnect: false,
        allowUnsupportedChain: false,
        features: {
          analytics: false,
          email: false,
          socials: false,
          swaps: false,
          onramp: false,
          send: false,
          receive: false,
          history: false,
          pay: false,
          smartSessions: false,
          reownAuthentication: false,
        },
      });
      // The checkout leaves Esc to this modal while it is open (lib/checkout/escape.ts).
      kit.subscribeState((st) => setWalletModalOpen(st.open));
      return kit;
    })().catch((err: unknown) => {
      instance = null;
      throw err;
    });
  }
  return instance;
}

/** Waits for the namespace's account to connect; rejects if the modal closes first. */
function waitForConnection(kit: AppKit, namespace: AppKitNamespace): Promise<{ address: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const unsubs: (() => void)[] = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => unsubs.forEach((u) => u()));
      fn();
    };
    const connected = () => {
      const a = kit.getAccount(namespace);
      return a?.isConnected && a.address ? a.address : null;
    };
    unsubs.push(
      kit.subscribeAccount((a) => {
        if (a.isConnected && a.address) finish(() => resolve({ address: a.address! }));
      }, namespace),
    );
    let opened = false;
    unsubs.push(
      kit.subscribeState((s) => {
        if (s.open) {
          opened = true;
          return;
        }
        if (!opened) return;
        // Closed: a connection that just landed wins; otherwise the shopper closed the list.
        setTimeout(() => {
          const address = connected();
          if (address) finish(() => resolve({ address }));
          else
            finish(() => reject(Object.assign(new Error('User closed the modal'), { code: 4001 })));
        }, 300);
      }),
    );
  });
}

export function appKitSession<P>(
  namespace: AppKitNamespace,
  projectId: string,
  testnet = false,
): AppKitSession<P> {
  let kit: AppKit | null = null;
  return {
    async connect() {
      kit = await loadAppKit(projectId);
      const a = kit.getAccount(namespace);
      if (a?.isConnected && a.address) return { address: a.address };
      const done = waitForConnection(kit, namespace);
      await kit.open({ view: 'Connect', namespace });
      return done;
    },
    provider() {
      return kit?.getProvider<P>(namespace);
    },
    async ensureNetwork() {
      if (!kit) return false;
      if (namespace === 'eip155') return true;
      const want =
        namespace === 'solana'
          ? testnet
            ? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
            : SOLANA_MAINNET
          : BITCOIN_MAINNET;
      if (kit.getCaipNetwork(namespace)?.caipNetworkId === want) return true;
      try {
        const { solana, solanaDevnet, bitcoin } = await import('@reown/appkit/networks');
        await kit.switchNetwork(
          namespace === 'solana' ? (testnet ? solanaDevnet : solana) : bitcoin,
          {
            throwOnFailure: true,
          },
        );
      } catch {
        return false;
      }
      return kit.getCaipNetwork(namespace)?.caipNetworkId === want;
    },
    async disconnect() {
      if (kit) await kit.disconnect(namespace).catch(() => {});
    },
  };
}
