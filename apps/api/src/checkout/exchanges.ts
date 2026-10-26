// Known exchange deposit / hot-wallet addresses (spec §6 "Sender is a known exchange"). Money sent
// from an exchange cannot go back to the sending address (it belongs to the exchange, not the
// shopper), so a return is held as `needs_address` until the shopper says where to send it.
//
// The list is a maintained data file, `data/exchange-addresses.json`, loaded at startup (never
// fetched over the network). Format: `{ "<chain>": ["<address>", …] }` where `<chain>` is a
// 1Click `blockchain` id (`eth`, `sol`, `tron`, `btc`, `near`, …). EVM addresses are matched
// case-insensitively and across every EVM chain (an exchange's EOA is the same account on each);
// bech32 addresses (`bc1…`, `tb1…`: case-insensitive by BIP-173) are compared lower-cased; other
// formats (base58, …) are matched exactly, on the chain they are listed under. It is a seed list: add
// addresses as support reports them (one PR per change, with the source in the PR description).
import exchangeAddresses from './data/exchange-addresses.json' with { type: 'json' };
import { chainFamily } from './address-format.js';

type ExchangeList = Readonly<Record<string, readonly string[]>>;

/** `{chain: Set<address>}`, plus one family-wide set for EVM. */
interface Index {
  byChain: Map<string, Set<string>>;
  evm: Set<string>;
}

/** bech32 / bech32m (BIP-173/350): one case only, so it is compared lower-cased. */
const BECH32 = /^(bc|tb|bcrt)1[02-9ac-hj-np-z]+$/i;
/** The comparison form of a non-EVM address: bech32 lower-cased, anything else exact. */
const normal = (a: string) => (BECH32.test(a) ? a.toLowerCase() : a);

function build(list: ExchangeList): Index {
  const byChain = new Map<string, Set<string>>();
  const evm = new Set<string>();
  for (const [chain, addresses] of Object.entries(list)) {
    if (!Array.isArray(addresses)) throw new Error(`exchange list: ${chain} must be an array`);
    const c = chain.toLowerCase();
    const set = byChain.get(c) ?? new Set<string>();
    for (const a of addresses) {
      if (typeof a !== 'string' || a.trim() === '') {
        throw new Error(`exchange list: bad address under ${chain}`);
      }
      if (chainFamily(c) === 'evm') evm.add(a.trim().toLowerCase());
      else set.add(normal(a.trim()));
    }
    byChain.set(c, set);
  }
  return { byChain, evm };
}

let index = build(exchangeAddresses as ExchangeList);

/** Whether `address` on `chain` (a 1Click `blockchain` id) is a known exchange address. */
export function isExchangeAddress(chain: string, address: string): boolean {
  const a = address.trim();
  if (chainFamily(chain) === 'evm') return index.evm.has(a.toLowerCase());
  return index.byChain.get(chain.toLowerCase())?.has(normal(a)) ?? false;
}

/** Test hook: replaces the list; null reloads the data file. */
export function setExchangeAddresses(list: ExchangeList | null): void {
  index = build(list ?? (exchangeAddresses as ExchangeList));
}
