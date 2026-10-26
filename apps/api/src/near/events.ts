// NEP-297 event logs (`EVENT_JSON:{…}`) and the token-transfer events settlement verification
// reads from them: NEP-245 (multi-token, the intents contract) `mt_transfer` / `mt_mint`, and
// NEP-141 (fungible token) `ft_transfer`. One parser, used by the payment watcher.
//
// A log line is only as trustworthy as the account that emitted it: any contract can log an
// `EVENT_JSON` line claiming a transfer. Callers must therefore only count events from receipts
// executed by the token's own contract (the intents contract for NEP-245 intents balances, the
// token contract for NEP-141), and only from receipts that succeeded.

export const EVENT_PREFIX = 'EVENT_JSON:';

export interface Nep297Event {
  standard: string;
  version: string;
  event: string;
  data: unknown;
}

/** Parses one log line; null when it is not a well-formed NEP-297 event. */
export function parseEventLog(line: string): Nep297Event | null {
  if (!line.startsWith(EVENT_PREFIX)) return null;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (typeof e.standard !== 'string' || typeof e.event !== 'string') return null;
  return {
    standard: e.standard,
    version: typeof e.version === 'string' ? e.version : '',
    event: e.event,
    data: e.data,
  };
}

/** One credit of `amount` of `tokenId` to `receiver` found in an event. */
export interface TokenCredit {
  standard: 'nep245' | 'nep141';
  event: 'mt_transfer' | 'mt_mint' | 'ft_transfer';
  receiver: string;
  /** NEP-245: the multi-token id (e.g. `nep141:usdc.near`). NEP-141: the emitting contract. */
  tokenId: string;
  amount: bigint;
}

const isAmount = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);

/**
 * The credits an event describes. NEP-245 `mt_transfer` (`new_owner_id`, `token_ids[]`,
 * `amounts[]`) and `mt_mint` (`owner_id`, …); NEP-141 `ft_transfer` (`new_owner_id`, `amount`),
 * whose token is `contractId` (the emitting contract). Malformed entries are skipped.
 */
export function creditsOf(e: Nep297Event, contractId: string): TokenCredit[] {
  if (!Array.isArray(e.data)) return [];
  const out: TokenCredit[] = [];
  for (const raw of e.data as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    if (e.standard === 'nep245' && (e.event === 'mt_transfer' || e.event === 'mt_mint')) {
      const receiver = e.event === 'mt_transfer' ? d.new_owner_id : d.owner_id;
      const ids = d.token_ids;
      const amounts = d.amounts;
      if (typeof receiver !== 'string' || !Array.isArray(ids) || !Array.isArray(amounts)) continue;
      if (ids.length !== amounts.length) continue;
      ids.forEach((id, i) => {
        const amount = amounts[i];
        if (typeof id === 'string' && isAmount(amount)) {
          out.push({
            standard: 'nep245',
            event: e.event as 'mt_transfer' | 'mt_mint',
            receiver,
            tokenId: id,
            amount: BigInt(amount),
          });
        }
      });
    } else if (e.standard === 'nep141' && e.event === 'ft_transfer') {
      if (typeof d.new_owner_id === 'string' && isAmount(d.amount)) {
        out.push({
          standard: 'nep141',
          event: 'ft_transfer',
          receiver: d.new_owner_id,
          tokenId: contractId,
          amount: BigInt(d.amount),
        });
      }
    }
  }
  return out;
}

/** A receipt of a transaction, as `NearClient.txStatus` reports it. */
export interface TxReceipt {
  receiptId: string;
  /** The account whose code ran (and emitted the logs). */
  executorId: string;
  logs: string[];
  /** False when the receipt failed: its logs describe rolled-back changes. */
  ok: boolean;
  /** The account that created the receipt (when the RPC reports it). */
  predecessorId?: string;
}

/**
 * Sum credited to `receiver` in `assetId` by the successful receipts of a transaction.
 * `assetId` is a 1Click / intents asset id:
 * - `intentsContract` given (INTENTS recipient): NEP-245 `mt_transfer` / `mt_mint` events emitted
 *   by the intents contract whose token id is `assetId`;
 * - otherwise (a NEAR payout address): NEP-141 `ft_transfer` emitted by the token contract named
 *   by a `nep141:<contract>` asset id.
 */
export function creditedAmount(
  receipts: readonly TxReceipt[],
  opts: { assetId: string; receiver: string; intentsContract?: string },
): bigint {
  const tokenContract = opts.assetId.startsWith('nep141:') ? opts.assetId.slice(7) : null;
  let total = 0n;
  for (const r of receipts) {
    if (!r.ok) continue;
    const expectedEmitter = opts.intentsContract ?? tokenContract;
    if (!expectedEmitter || r.executorId !== expectedEmitter) continue;
    for (const line of r.logs) {
      const e = parseEventLog(line);
      if (!e) continue;
      for (const c of creditsOf(e, r.executorId)) {
        if (c.receiver !== opts.receiver) continue;
        if (opts.intentsContract) {
          if (c.standard === 'nep245' && c.tokenId === opts.assetId) total += c.amount;
        } else if (c.standard === 'nep141') {
          total += c.amount;
        }
      }
    }
  }
  return total;
}

/** One matching credit, identified within its transaction (a settlement claim's key). */
export interface MatchedCredit {
  receiptId: string;
  /** `<log index>.<data entry>.<token index>` within the receipt. */
  eventKey: string;
  amount: bigint;
}

/**
 * Every credit to `receiver` in `assetId` in the successful receipts of a transaction, each
 * identified by receipt and event position, so distinct events of one (batched) transaction can
 * settle distinct payments while one event never settles two. Same emitter rules as
 * `creditedAmount`.
 */
export function matchingCredits(
  receipts: readonly TxReceipt[],
  opts: { assetId: string; receiver: string; intentsContract?: string },
): MatchedCredit[] {
  const tokenContract = opts.assetId.startsWith('nep141:') ? opts.assetId.slice(7) : null;
  const expectedEmitter = opts.intentsContract ?? tokenContract;
  const out: MatchedCredit[] = [];
  for (const r of receipts) {
    if (!r.ok || !expectedEmitter || r.executorId !== expectedEmitter) continue;
    r.logs.forEach((line, logIndex) => {
      const e = parseEventLog(line);
      if (!e || !Array.isArray(e.data)) return;
      (e.data as unknown[]).forEach((entry, dataIndex) => {
        const single = { ...e, data: [entry] };
        creditsOf(single, r.executorId).forEach((c, tokenIndex) => {
          if (c.receiver !== opts.receiver) return;
          const ok = opts.intentsContract
            ? c.standard === 'nep245' && c.tokenId === opts.assetId
            : c.standard === 'nep141';
          if (!ok) return;
          out.push({
            receiptId: r.receiptId,
            eventKey: `${logIndex}.${dataIndex}.${tokenIndex}`,
            amount: c.amount,
          });
        });
      });
    });
  }
  return out;
}

/** Builds an `EVENT_JSON:` log line (fakes and the simulated provider). */
export function eventLog(standard: string, version: string, event: string, data: unknown): string {
  return `${EVENT_PREFIX}${JSON.stringify({ standard, version, event, data })}`;
}
