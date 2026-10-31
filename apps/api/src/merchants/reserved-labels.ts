// NEAR labels a store may never take under Tendr's parent accounts (C-1, ruling C37/C38).
//
// A store's slug becomes its NEAR sub-account label in both modes (`<slug>.tendr.testnet` at
// signup, `<slug>.tendr.near` at go-live). A store named "Fees" must never take Tendr's fee account
// (the 1Click `appFees` recipient), and no store may take any other account Tendr owns or may own:
// the intents mock, relayers, funding, gas payers, the simulator's tokens, or a name that reads as
// Tendr itself. Labels Tendr configures are derived from env at runtime, so a renamed account
// cannot slip through.
import { env, type Env } from '../env.js';

/** Static labels: Tendr's accounts and names that would read as Tendr or as a system role. */
const STATIC: ReadonlySet<string> = new Set([
  // Tendr's own accounts (keyvault names, the mock verifier, the simulator's tokens).
  'intents-mock',
  'intents',
  'relayer',
  'relayer-near',
  'relayer-evm',
  'relayer-accounts',
  'funding',
  'funding-near',
  'solver',
  'solver-hot',
  'gas',
  'gas-tron',
  'gas-evm',
  'usdc',
  'usdt',
  'fees',
  'fee',
  'revenue',
  'treasury',
  // Names that read as Tendr, an operator or a system role.
  'tendr',
  'admin',
  'api',
  'www',
  'app',
  'dashboard',
  'pay',
  'checkout',
  'mock',
  'test',
  'ops',
  'operator',
  'operators',
  'support',
  'help',
  'billing',
  'refund',
  'refunds',
  'security',
  'status',
  'docs',
  'mail',
  'email',
  'webhooks',
  'hooks',
  'relay',
  'sponsor',
  'paymaster',
  'settlement',
  'settlements',
  'escrow',
  'vault',
  'root',
  'system',
  'internal',
  'staging',
  'sandbox',
  'dev',
  'near',
  'testnet',
  'tendrpay',
  'merchant',
  'merchants',
  'wallet',
  'wallets',
  'oneclick',
  '1click',
  'swap',
  'bridge',
  // Top-level routes and folders of the web app: the pay host serves `/<merchant>/<link>` at its
  // root, so a store slug must not shadow them.
  'preview',
  'v1',
  'downloads',
  'privacy',
  'terms',
  'demo',
  'connect',
  'login',
  'signup',
  'verify',
  'invite',
  'recover',
  'settings',
  'icons',
]);

/** Prefixes Tendr keeps for families of system accounts (`gas-tron`, `fee-usdc`, `intents-…`) and session ids (`ses_…`, `ses-…`, which route under /pay/[id]). */
const PREFIXES = ['gas-', 'fee-', 'fees-', 'intents', 'tendr', 'ses_', 'ses-'] as const;

/**
 * The direct sub-account labels of Tendr's parents named by the env's account ids: the fee
 * accounts, the intents contracts, and anything else under `.<parent>`.
 */
export function envReservedLabels(e: Env = env()): Set<string> {
  const parents = [e.NEAR_PARENT_ACCOUNT_LIVE, e.NEAR_PARENT_ACCOUNT_TEST];
  const ids = [
    e.FEE_ACCOUNT_LIVE,
    e.FEE_ACCOUNT_TEST,
    e.INTENTS_CONTRACT_LIVE,
    e.INTENTS_CONTRACT_TEST,
  ];
  const labels = new Set<string>();
  for (const id of ids) {
    for (const parent of parents) {
      const suffix = `.${parent}`;
      if (!id.endsWith(suffix)) continue;
      const head = id.slice(0, -suffix.length).split('.');
      const label = head[head.length - 1];
      if (label) labels.add(label);
    }
  }
  return labels;
}

/** Whether a store may not take `label` as its NEAR sub-account label. */
export function isReservedLabel(label: string, e: Env = env()): boolean {
  // No suffix exemption (C40): `fees-store` or `tendr-store` still read as Tendr's. A reserved
  // name is mapped to `store-<name>` instead (signup.ts `slugBase`), which no rule reserves.
  if (STATIC.has(label)) return true;
  if (PREFIXES.some((p) => label.startsWith(p))) return true;
  if (envReservedLabels(e).has(label)) return true;
  // `<reserved>-store` (and `-store-N`), the old mapped form, is reserved too.
  const base = /^(.+)-store(?:-\d+)?$/.exec(label)?.[1];
  return base !== undefined && isReservedLabel(base, e);
}
