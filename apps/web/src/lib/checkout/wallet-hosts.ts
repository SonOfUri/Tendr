// The hosts the checkout page's wallet providers talk to. This is the ONE list: the `/pay/*` CSP
// (lib/csp.ts, via middleware.ts) adds WALLET_CONNECT_HOSTS to connect-src and WALLET_FRAME_HOSTS
// to frame-src. Entries are `https://host` or `wss://host` (a leading `*.` subdomain wildcard is
// allowed); anything else is dropped by the CSP builder. No wallet host is ever a script source:
// every wallet SDK is bundled and loaded on demand (lib/wallets).
//
// Third-party wallet code is allowed on the checkout page only, never on dashboard pages.
export const WALLET_CONNECT_HOSTS: readonly string[] = [
  // Reown AppKit / WalletConnect (EVM, Solana, Bitcoin): relay, RPC + blockchain API, wallet
  // list and project config, origin verification.
  'wss://relay.walletconnect.org',
  'wss://relay.walletconnect.com',
  'https://rpc.walletconnect.org',
  'https://rpc.walletconnect.com',
  'https://api.web3modal.org',
  'https://pulse.walletconnect.org',
  'https://verify.walletconnect.org',
  'https://verify.walletconnect.com',
  // AppKit's Bitcoin adapter (UTXO lookups).
  'https://mempool.space',
  // TronLink's TronWeb (mainnet full node).
  'https://api.trongrid.io',
  // NEAR: contract views (storage registration, wNEAR balance) and the Wallet Selector's RPC.
  'https://free.rpc.fastnear.com',
  'https://rpc.mainnet.near.org',
  // Intear wallet's session bridge (Meteor talks through its popup only).
  'wss://logout-bridge-service.intear.tech',
  'https://logout-bridge-service.intear.tech',
];

// Frames a wallet provider truly needs: WalletConnect's Verify API attests the page's origin in a
// hidden iframe (@walletconnect/core). Nothing else: the embedded email/social wallet frame
// (secure.walletconnect.org) is turned off in lib/wallets/appkit.ts.
export const WALLET_FRAME_HOSTS: readonly string[] = [
  'https://verify.walletconnect.org',
  'https://verify.walletconnect.com',
];
