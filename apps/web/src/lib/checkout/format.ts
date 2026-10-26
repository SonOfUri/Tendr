// Display helpers for the checkout. Amounts are formatted from base-unit integers (bigint) and
// decimal strings with integer arithmetic: never through floating point.

const UINT = /^\d+$/;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Base units → a decimal string ("0.02841"), trailing zeros trimmed. Null for non-integers. */
export function formatUnits(units: string | bigint, decimals: number): string | null {
  const raw = typeof units === 'bigint' ? units.toString() : units.trim();
  if (!UINT.test(raw) || !Number.isInteger(decimals) || decimals < 0) return null;
  if (decimals === 0) return BigInt(raw).toString();
  const s = BigInt(raw)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A USD decimal string → "$1,234.57", rounded up to the cent. Null when not a decimal. */
export function formatUsd(amount: string): string | null {
  const m = DECIMAL.exec(amount.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  let cents = BigInt(m[1]!) * 100n + BigInt((frac + '00').slice(0, 2));
  if (/[1-9]/.test(frac.slice(2))) cents += 1n;
  const whole = (cents / 100n).toString();
  const rest = (cents % 100n).toString().padStart(2, '0');
  return `$${groupThousands(whole)}.${rest}`;
}

/** The order total: dollars for USD, else the amount and the settlement token's symbol. */
export function formatOrderAmount(amount: string, currency: string, symbol: string | null): string {
  if (currency === 'USD') return formatUsd(amount) ?? amount;
  return symbol ? `${amount} ${symbol}` : amount;
}

/** Milliseconds left → "m:ss" (never negative). */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const NETWORKS: Readonly<Record<string, { name: string; tx?: string }>> = {
  eth: { name: 'Ethereum', tx: 'https://etherscan.io/tx/' },
  base: { name: 'Base', tx: 'https://basescan.org/tx/' },
  arb: { name: 'Arbitrum', tx: 'https://arbiscan.io/tx/' },
  op: { name: 'Optimism', tx: 'https://optimistic.etherscan.io/tx/' },
  pol: { name: 'Polygon', tx: 'https://polygonscan.com/tx/' },
  bsc: { name: 'BNB Chain', tx: 'https://bscscan.com/tx/' },
  avax: { name: 'Avalanche', tx: 'https://snowtrace.io/tx/' },
  gnosis: { name: 'Gnosis', tx: 'https://gnosisscan.io/tx/' },
  bera: { name: 'Berachain' },
  sol: { name: 'Solana', tx: 'https://solscan.io/tx/' },
  tron: { name: 'Tron', tx: 'https://tronscan.org/#/transaction/' },
  btc: { name: 'Bitcoin', tx: 'https://mempool.space/tx/' },
  near: { name: 'NEAR', tx: 'https://nearblocks.io/txns/' },
  ton: { name: 'TON' },
  doge: { name: 'Dogecoin' },
  xrp: { name: 'XRP Ledger' },
  zec: { name: 'Zcash' },
  sui: { name: 'Sui' },
  aptos: { name: 'Aptos' },
  stellar: { name: 'Stellar' },
};

/** A plain network name for a 1Click `blockchain` id ("arb" → "Arbitrum"). */
export function networkName(blockchain: string): string {
  return NETWORKS[blockchain.toLowerCase()]?.name ?? blockchain.toUpperCase();
}

/** A block explorer link for a transaction, or null when unknown. */
export function explorerTxUrl(blockchain: string, hash: string): string | null {
  const prefix = NETWORKS[blockchain.toLowerCase()]?.tx;
  if (!prefix || !/^[A-Za-z0-9]+$/.test(hash)) return null;
  return prefix + hash;
}

/** `url` when it is an http(s) URL (never `javascript:` or `data:`), else null. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Shortens a long address for headings: "0x7a3f…c91e". The full address is shown elsewhere. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
