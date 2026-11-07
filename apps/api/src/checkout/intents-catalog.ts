// Chains a saved address may name. The list is the live 1Click catalog, plus the chains that
// catalog already serves, so a new Intents network shows up without a code change. Test runs do
// not call 1Click: they use the fixture catalog and the fallback below.
import { tokenList } from './tokens.js';

/** Contract chain names that differ from the 1Click `blockchain` id. */
const LEGACY_TO_ONECLICK: Readonly<Record<string, string>> = {
  arbitrum: 'arb',
  polygon: 'pol',
  optimism: 'op',
  avalanche: 'avax',
};

const ONECLICK_TO_STORED: Readonly<Record<string, string>> = {
  arb: 'arbitrum',
  pol: 'polygon',
  op: 'optimism',
  avax: 'avalanche',
};

/**
 * 1Click chain ids. Used when the live list cannot be read (tests, a provider blip) so a known
 * network is still accepted. The live catalog is unioned in whenever it loads.
 */
export const INTENTS_CHAIN_FALLBACK: readonly string[] = [
  'abs',
  'adi',
  'aleo',
  'aptos',
  'arb',
  'avax',
  'base',
  'bch',
  'bera',
  'bsc',
  'btc',
  'cardano',
  'dash',
  'doge',
  'eth',
  'fogo',
  'gnosis',
  'hood',
  'hypercore',
  'ltc',
  'miden',
  'monad',
  'movement',
  'near',
  'op',
  'plasma',
  'pol',
  'prl',
  'qtc',
  'scroll',
  'sol',
  'starknet',
  'stellar',
  'sui',
  'ton',
  'tron',
  'xlayer',
  'xrp',
  'zec',
];

const SLUG = /^[a-z0-9]{1,16}$/;

/** The 1Click id for a stored or legacy chain name (`arbitrum` → `arb`). */
export function oneclickChainId(chain: string): string {
  const id = chain.trim().toLowerCase();
  return LEGACY_TO_ONECLICK[id] ?? id;
}

/** Every chain id this mode, and the live catalog, will accept. */
export async function knownIntentsChains(livemode: boolean): Promise<Set<string>> {
  const chains = new Set<string>(INTENTS_CHAIN_FALLBACK);
  const lists = [tokenList(livemode)];
  // Test mode's fixture is a small stand-in. The live catalog is what the pickers show.
  if (!livemode && process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    lists.push(tokenList(true));
  }
  const loaded = await Promise.all(lists.map((list) => list.catch(() => null)));
  for (const list of loaded) {
    if (!list) continue;
    for (const token of list.values()) {
      if (SLUG.test(token.blockchain)) chains.add(token.blockchain);
    }
  }
  return chains;
}

/**
 * The chain stored on a saved address, or null when 1Click does not list it.
 * `arb` and `arbitrum` both become `arbitrum`, which is the name withdrawals already match.
 */
export async function canonicalIntentsChain(
  livemode: boolean,
  chain: string,
): Promise<string | null> {
  const oneclick = oneclickChainId(chain);
  if (!SLUG.test(oneclick)) return null;
  const known = await knownIntentsChains(livemode);
  if (!known.has(oneclick)) return null;
  return ONECLICK_TO_STORED[oneclick] ?? oneclick;
}
