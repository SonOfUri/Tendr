// The hosts the checkout page's wallet providers talk to (WalletConnect relays, RPCs, wallet
// APIs). This is the ONE list: the `/pay/*` CSP adds every entry to connect-src. Task 12 extends it
// when it adds the wallets. Entries are `https://host` or `wss://host` (a leading `*.` subdomain
// wildcard is allowed); anything else is dropped by the CSP builder.
//
// Third-party wallet code is allowed on the checkout page only, never on dashboard pages.
export const WALLET_CONNECT_HOSTS: readonly string[] = [];
