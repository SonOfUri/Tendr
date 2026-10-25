/**
 * MANUAL. Checks the merchant-account design's "Assumptions to verify early" on NEAR MAINNET.
 * It SPENDS REAL FUNDS (NEAR for contract storage, about 1 USDC for a swap). Never run by CI.
 *
 *   npm run onchain:verify:mainnet --workspace=@tendr/api -- \
 *     --yes-i-understand-this-spends-mainnet-funds --evm-address 0xYourAddress --phase prepare
 *   (wait 24 hours: the contract delays a new saved address)
 *   npm run onchain:verify:mainnet --workspace=@tendr/api -- \
 *     --yes-i-understand-this-spends-mainnet-funds --evm-address 0xYourAddress --phase finish --cleanup
 *
 * You supply a funded mainnet account (about 15 NEAR and 1+ USDC on NEAR):
 *   VERIFY_FUNDER_ACCOUNT_ID    your mainnet account
 *   VERIFY_FUNDER_PRIVATE_KEY   ed25519:<base58> full-access key of that account
 *   NEAR_RPC_URL_LIVE           default https://rpc.mainnet.near.org
 *   ONECLICK_API_URL            default https://1click.chaindefuser.com
 *   ONECLICK_JWT                optional 1Click API token
 *
 * Build the probe and default wasm first: onchain/scripts/build.sh --features probe merchant-account
 * and onchain/scripts/build.sh merchant-account.
 *
 * Output is PASS / FAIL / INFO per check. The run stops at the first FAIL. INFO lines record
 * observations (verifier return values, RPC error shapes, token account names) for you to act on.
 *
 * `prepare` runs:
 *   INFO  how the RPC reports a stale nonce and an unknown/timed-out transaction
 *   INFO  whether @near-js/providers retries send_tx by itself (against a local fake RPC)
 *   INFO  the omft PoA token account names 1Click lists, vs POA_CHAIN_PREFIXES in money.rs
 *   (4)   a sub-account created without AddKey has zero access keys
 *   (1)   p256_verify works on mainnet (probe build on a throwaway account, then deleted)
 *   (2)   a 1Click quote with recipientType INTENTS and refundType INTENTS to a contract account,
 *         then the swap itself delivers to that contract's intents balance
 *   (5)   NEP-145 storage needs of the tokens involved
 *   then proposes a saved address (threshold 1, passkey generated here)
 * `finish` (24 h later) runs:
 *   (3)   a threshold-approved ft_withdraw with a WITHDRAW_TO memo to your EVM address, recording
 *         what the real verifier returned from mt_transfer / ft_withdraw
 * Everything throwaway lives under your account. State between phases is a local file holding a
 * throwaway passkey (no funds depend on it beyond the swapped dollar).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Action } from '@near-js/transactions';
import { JsonRpcProvider } from '@near-js/providers';
import { p256 } from '@noble/curves/p256';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { approvalChallenge, proposalId, type ActionJson } from '../src/accounts/encoding.js';
import { isInvalidNonce, isInvalidTransaction } from '../src/near/rpc.js';
import {
  RELAY_GAS,
  createAccountAction,
  functionCallAction,
  transferAction,
} from '../src/near/tx.js';
import {
  NEAR,
  ScriptAccount,
  UsageError,
  addFullAccessKeyAction,
  deleteAccountAction,
  deployContractAction,
  describeReceipts,
  firstFailure,
  formatNear,
  parseFlags,
  TGAS,
  type RawOutcome,
} from './lib/near-script.js';

export const CONFIRM_FLAG = 'yes-i-understand-this-spends-mainnet-funds';
const ONCHAIN_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../onchain');
const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const ETH_USDC_OMFT = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const SIGNER_ID = 'per_verify';
const SAVED_ADDRESS_ID = 'addr_verify';
const DAY_MS = 24 * 3_600_000;

export type Phase = 'prepare' | 'finish';

export interface VerifyArgs {
  phase: Phase;
  evmAddress: string;
  statePath: string;
  cleanup: boolean;
  originAsset: string;
  destAsset: string;
  /** Origin-asset smallest units for the swap (1 USDC = 1000000). */
  amount: string;
  funderId: string;
  funderKey: string;
  rpcUrl: string;
  oneClickUrl: string;
  oneClickJwt: string | undefined;
}

export const PLAN_TEXT = [
  'This script spends MAINNET funds from the account you supply:',
  '  - about 4 NEAR per throwaway contract account (probe, merchant) for storage, recoverable by',
  '    deleting the accounts (the probe is deleted automatically, the merchant with --cleanup)',
  '  - a 1Click swap of about 1 USDC (originAsset to destinationAsset), delivered to the throwaway',
  '    merchant contract; most comes back out in the final withdrawal to your EVM address',
  '  - gas for roughly 15 transactions',
].join('\n');

/** Parses argv and env. Throws UsageError (a refusal) unless every safety requirement is explicit. */
export function parseVerifyArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): VerifyArgs {
  const flags = parseFlags(argv, {
    [CONFIRM_FLAG]: 'bool',
    'evm-address': 'value',
    phase: 'value',
    state: 'value',
    cleanup: 'bool',
    'origin-asset': 'value',
    'destination-asset': 'value',
    amount: 'value',
  });
  if (!flags.has(CONFIRM_FLAG)) {
    throw new UsageError(`refusing to run: pass --${CONFIRM_FLAG} to confirm.\n${PLAN_TEXT}`);
  }
  const phase = flags.get('phase') ?? 'prepare';
  if (phase !== 'prepare' && phase !== 'finish') {
    throw new UsageError(`--phase must be "prepare" or "finish", got "${String(phase)}"`);
  }
  const evm = flags.get('evm-address') ?? env.VERIFY_EVM_ADDRESS;
  if (typeof evm !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(evm)) {
    throw new UsageError(
      '--evm-address (or VERIFY_EVM_ADDRESS) must be a 0x… EVM address you control',
    );
  }
  const funderId = env.VERIFY_FUNDER_ACCOUNT_ID;
  const funderKey = env.VERIFY_FUNDER_PRIVATE_KEY;
  if (!funderId || !funderKey) {
    throw new UsageError(
      'VERIFY_FUNDER_ACCOUNT_ID and VERIFY_FUNDER_PRIVATE_KEY (ed25519:<base58>) must be set: a funded mainnet account of yours',
    );
  }
  if (funderId.endsWith('.testnet')) {
    throw new UsageError(`${funderId} is a testnet account; this script is for mainnet`);
  }
  const rpcUrl = env.NEAR_RPC_URL_LIVE ?? 'https://rpc.mainnet.near.org';
  if (/testnet/.test(rpcUrl)) {
    throw new UsageError(`NEAR_RPC_URL_LIVE (${rpcUrl}) looks like testnet`);
  }
  const amount =
    typeof flags.get('amount') === 'string' ? (flags.get('amount') as string) : '1000000';
  if (!/^[1-9]\d{0,17}$/.test(amount)) throw new UsageError('--amount must be a positive integer');
  const asset = (name: string, dflt: string): string => {
    const v = flags.get(name);
    const value = typeof v === 'string' ? v : dflt;
    if (!value.startsWith('nep141:')) throw new UsageError(`--${name} must be a nep141: asset id`);
    return value;
  };
  return {
    phase,
    evmAddress: evm,
    statePath: resolve(
      typeof flags.get('state') === 'string'
        ? (flags.get('state') as string)
        : '.verify-merchant-account-state.json',
    ),
    cleanup: flags.has('cleanup'),
    originAsset: asset('origin-asset', NEAR_USDC),
    destAsset: asset('destination-asset', ETH_USDC_OMFT),
    amount,
    funderId,
    funderKey,
    rpcUrl,
    oneClickUrl: env.ONECLICK_API_URL ?? 'https://1click.chaindefuser.com',
    oneClickJwt: env.ONECLICK_JWT,
  };
}

// ─── reporting ───────────────────────────────────────────────────────────────

/** A FAIL: stops the run. */
export class CheckFailed extends Error {}

const report = {
  pass: (name: string, detail = '') => console.log(`PASS: ${name}${detail ? ` (${detail})` : ''}`),
  info: (name: string, detail = '') => console.log(`INFO: ${name}${detail ? `: ${detail}` : ''}`),
  fail: (name: string, detail: string): never => {
    console.log(`FAIL: ${name}: ${detail}`);
    throw new CheckFailed(`${name}: ${detail}`);
  },
};

/** Runs `fn`; an exception becomes a FAIL and stops the run. */
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    report.pass(name, detail ?? '');
  } catch (err) {
    if (err instanceof CheckFailed) throw err;
    return report.fail(name, (err as Error).message);
  }
}

// ─── local state between phases ──────────────────────────────────────────────

interface State {
  version: 1;
  funderId: string;
  merchantId: string;
  passkeyPrivateHex: string;
  destAsset: string;
  originAsset: string;
  evmAddress: string;
  /** Epoch ms after which the saved address is usable. */
  activeAfterMs: number;
}

function saveState(path: string, s: State): void {
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function loadState(path: string): State {
  if (!existsSync(path)) {
    throw new UsageError(`no state file at ${path}; run --phase prepare first`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as State;
}

// ─── passkey approvals (what a browser authenticator would produce) ──────────

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

export function compressedPublicKey(priv: Uint8Array): Uint8Array {
  return p256.getPublicKey(priv, true);
}

/** The contract's `SignedApproval` JSON for `challenge` (32 bytes), signed by `priv` like a passkey. */
export function signedApproval(priv: Uint8Array, signerId: string, challenge: Uint8Array) {
  const flags = 0x05; // user present + user verified
  const authData = Buffer.concat([sha256(RP_ID), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: Buffer.from(challenge).toString('base64url'),
    origin: ORIGIN,
    crossOrigin: false,
  });
  const digest = sha256(Buffer.concat([authData, sha256(clientData)]));
  const sig = p256.sign(digest, priv, { lowS: true }).toCompactRawBytes();
  return {
    signer_id: signerId,
    key: { p256: b64(compressedPublicKey(priv)) },
    assertion: {
      authenticator_data: b64(authData),
      client_data_json: clientData,
      signature: b64(sig),
    },
  };
}

// ─── context ─────────────────────────────────────────────────────────────────

interface Ctx {
  a: VerifyArgs;
  funder: ScriptAccount;
}

function wasm(name: string): Uint8Array {
  const path = resolve(ONCHAIN_DIR, 'target/near/merchant-account', name);
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; build it with onchain/scripts/build.sh (see the header)`);
  }
  return new Uint8Array(readFileSync(path));
}

const storageCost = (code: Uint8Array): bigint => BigInt(code.length) * 10n ** 19n;

async function view<T>(c: Ctx, contract: string, method: string, args: object): Promise<T> {
  return c.funder.rpc.viewFunction<T>(contract, method, args);
}

async function viewOrNull<T>(
  c: Ctx,
  contract: string,
  method: string,
  args: object,
): Promise<T | null> {
  try {
    return await view<T>(c, contract, method, args);
  } catch {
    return null;
  }
}

async function intentsBalance(c: Ctx, account: string, asset: string): Promise<bigint> {
  const r = await view<string[]>(c, 'intents.near', 'mt_batch_balance_of', {
    account_id: account,
    token_ids: [asset],
  });
  return BigInt(r[0] ?? '0');
}

function tokenAccount(asset: string): string {
  return asset.replace(/^nep141:/, '');
}

// ─── INFO checks (spend nothing) ─────────────────────────────────────────────

async function infoRpcErrorShapes(c: Ctx): Promise<void> {
  // A stale nonce: a transfer of 0 to self signed with nonce 1. The node rejects it before any chunk.
  try {
    await c.funder.sendWithNonce(c.funder.accountId, [transferAction(0n)], 1n);
    report.info('stale-nonce send_tx', 'unexpectedly accepted');
  } catch (err) {
    report.info('stale-nonce send_tx error JSON', JSON.stringify(errShape(err)));
    report.info(
      'classified by src/near/rpc.ts',
      `isInvalidNonce=${isInvalidNonce(err)} isInvalidTransaction=${isInvalidTransaction(err)}`,
    );
  }
  // A lookup of a transaction the node does not know: how a timeout / unknown outcome is reported.
  try {
    await c.funder.transport.request('tx', {
      tx_hash: bs58.encode(randomBytes(32)),
      sender_account_id: c.funder.accountId,
      wait_until: 'FINAL',
    });
    report.info('unknown-transaction lookup', 'unexpectedly answered');
  } catch (err) {
    report.info('unknown-transaction lookup error JSON', JSON.stringify(errShape(err)));
    report.info(
      'classified by src/near/rpc.ts',
      `isInvalidNonce=${isInvalidNonce(err)} isInvalidTransaction=${isInvalidTransaction(err)} (both must be false: the outcome is unknown, not rejected)`,
    );
  }
}

function errShape(err: unknown): object {
  const e = err as {
    name?: unknown;
    type?: unknown;
    message?: unknown;
    cause?: unknown;
    data?: unknown;
  };
  return { name: e.name, type: e.type, message: e.message, cause: e.cause, data: e.data };
}

/**
 * Does @near-js/providers retry a failing request on its own? Points a JsonRpcProvider at a local
 * server that answers 503 `failures` times and then a JSON-RPC result, and counts the requests.
 * `requests > 1` means the provider resent the same send_tx body by itself.
 */
export async function probeProviderRetries(
  failures = 2,
): Promise<{ requests: number; resolved: boolean; method: string }> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      requests += 1;
      if (requests <= failures) {
        res.writeHead(503).end('unavailable');
        return;
      }
      const id = (JSON.parse(body) as { id: number }).id;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const provider = new JsonRpcProvider({ url: `http://127.0.0.1:${port}` });
    let resolved = false;
    try {
      await provider.sendJsonRpc('send_tx', { signed_tx_base64: 'AA==', wait_until: 'FINAL' });
      resolved = true;
    } catch {
      resolved = false;
    }
    return { requests, resolved, method: 'send_tx' };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function infoProviderRetries(): Promise<void> {
  const r = await probeProviderRetries(2);
  report.info(
    '@near-js JsonRpcProvider retries send_tx internally',
    r.requests > 1
      ? `YES: ${r.requests} identical requests for one call after 503s (resolved=${r.resolved}); it also retries 500/408 and network errors, up to 12 attempts with backoff, so a send can take minutes and RpcNearClient may see a late success after its own timeout`
      : 'no retries observed',
  );
}

interface OneClickToken {
  assetId?: string;
  blockchain?: string;
  symbol?: string;
}

async function oneClick<T>(
  c: Ctx,
  path: string,
  init?: { method: string; body?: object },
): Promise<T> {
  const res = await fetch(`${c.a.oneClickUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(c.a.oneClickJwt ? { authorization: `Bearer ${c.a.oneClickJwt}` } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** The (prefix, chain) pairs of money.rs's POA_CHAIN_PREFIXES, read from the Rust source. */
export function readPoaPrefixes(rust: string): string[] {
  const table = /POA_CHAIN_PREFIXES[^=]*=\s*\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '';
  return [...table.matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!);
}

/** Chain label of an omft account: `eth-0x….omft.near` -> `eth`, `btc.omft.near` -> `btc`. */
export function omftLabel(account: string): string | null {
  const m = /^([a-z0-9]+)(?:[-.].*)?\.omft\.near$|^([a-z0-9]+)\.omft\.near$/.exec(account);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

async function infoOmftTokens(c: Ctx): Promise<void> {
  const tokens = await oneClick<OneClickToken[]>(c, '/v0/tokens');
  const omft = tokens
    .map((t) => t.assetId ?? '')
    .filter((id) => id.startsWith('nep141:') && id.endsWith('.omft.near'));
  const byLabel = new Map<string, string[]>();
  for (const id of omft) {
    const label = omftLabel(tokenAccount(id)) ?? '?';
    byLabel.set(label, [...(byLabel.get(label) ?? []), tokenAccount(id)]);
  }
  for (const [label, accounts] of byLabel) {
    report.info(
      `omft chain label "${label}"`,
      `${accounts.length} tokens, e.g. ${accounts.slice(0, 3).join(', ')}`,
    );
  }
  const rust = readFileSync(resolve(ONCHAIN_DIR, 'merchant-account/src/money.rs'), 'utf8');
  const known = new Set(readPoaPrefixes(rust));
  const unseen = [...byLabel.keys()].filter((l) => !known.has(l));
  const missing = [...known].filter((l) => !byLabel.has(l));
  report.info(
    'POA_CHAIN_PREFIXES vs observed omft labels',
    `in listing but not in the table: [${unseen.join(', ')}]; in the table but not seen: [${missing.join(', ')}]`,
  );
  report.info(
    'poa_suffix',
    'every observed omft account ends in .omft.near (the default poa_suffix)',
  );
}

// ─── on-chain steps ──────────────────────────────────────────────────────────

async function createAccountWithKey(
  c: Ctx,
  id: string,
  code: Uint8Array,
  extra: Action[] = [],
  keep: boolean,
): Promise<void> {
  const funding = storageCost(code) + (keep ? 1n : 0n) * NEAR;
  await c.funder.sendOk(
    id,
    [
      createAccountAction(),
      transferAction(funding),
      addFullAccessKeyAction(c.funder.publicKey.publicKey),
      deployContractAction(code),
      ...extra,
    ],
    `create ${id}`,
  );
}

async function check4ZeroKeys(c: Ctx, ts: string): Promise<void> {
  await check('(4) sub-account created without AddKey has zero access keys', async () => {
    const id = `zk-${ts}.${c.a.funderId}`;
    await c.funder.sendOk(id, [createAccountAction(), transferAction(NEAR / 100n)], 'create zk');
    const keys = await c.funder.rpc.accessKeyList(id);
    if (keys.length !== 0) throw new Error(`${id} has ${keys.length} keys: ${keys.join(', ')}`);
    return id;
  });
}

async function check1P256(c: Ctx, ts: string): Promise<void> {
  await check('(1) p256_verify works on mainnet', async () => {
    const id = `p256-${ts}.${c.a.funderId}`;
    await createAccountWithKey(c, id, wasm('merchant-account-probe.wasm'), [], false);
    const priv = p256.utils.randomPrivateKey();
    const hash = sha256('tendr mainnet p256 probe');
    const sig = p256.sign(hash, priv, { lowS: true }).toCompactRawBytes();
    const pk = compressedPublicKey(priv);
    const good = await view<boolean>(c, id, 'probe_p256', {
      signature: b64(sig),
      prehash: b64(hash),
      public_key: b64(pk),
    });
    const bad = await view<boolean>(c, id, 'probe_p256', {
      signature: b64(sig),
      prehash: b64(sha256('another message')),
      public_key: b64(pk),
    });
    // Best effort: take the storage deposit back.
    try {
      const probe = new ScriptAccount(id, c.funder.publicKey, c.funder.transport);
      await probe.sendOk(id, [deleteAccountAction(c.a.funderId)], 'delete probe');
    } catch (err) {
      report.info('probe account not deleted', (err as Error).message);
    }
    if (good !== true) throw new Error('a valid P-256 signature did not verify');
    if (bad !== false) throw new Error('a signature over a different message verified');
    return `valid=true, wrong message=false`;
  });
}

interface Quote {
  quote: { depositAddress: string; amountIn?: string; amountOut?: string; minAmountOut?: string };
}
interface Status {
  status: string;
  swapDetails?: unknown;
}

async function check2Quote(c: Ctx, merchantId: string): Promise<void> {
  let depositAddress = '';
  await check(
    '(2a) 1Click quote with recipientType INTENTS and refundType INTENTS to a contract account',
    async () => {
      const q = await oneClick<Quote>(c, '/v0/quote', {
        method: 'POST',
        body: {
          dry: false,
          swapType: 'EXACT_INPUT',
          slippageTolerance: 100,
          originAsset: c.a.originAsset,
          depositType: 'ORIGIN_CHAIN',
          destinationAsset: c.a.destAsset,
          amount: c.a.amount,
          refundTo: merchantId,
          refundType: 'INTENTS',
          recipient: merchantId,
          recipientType: 'INTENTS',
          deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      });
      if (!q.quote?.depositAddress)
        throw new Error(`no depositAddress in ${JSON.stringify(q).slice(0, 300)}`);
      depositAddress = q.quote.depositAddress;
      report.info(
        'quote',
        `in ${q.quote.amountIn} -> out ${q.quote.amountOut} (min ${q.quote.minAmountOut}), deposit ${depositAddress}`,
      );
      return merchantId;
    },
  );

  const token = tokenAccount(c.a.originAsset);
  await check(
    '(2b) fund the quote: ft_transfer of the origin asset to the deposit address',
    async () => {
      const bal = BigInt(
        await view<string>(c, token, 'ft_balance_of', { account_id: c.a.funderId }),
      );
      if (bal < BigInt(c.a.amount))
        throw new Error(`funder holds ${bal} of ${token}, needs ${c.a.amount}`);
      // NEP-145: the deposit address must be registered on the origin token before it can receive.
      const registered = await viewOrNull<object>(c, token, 'storage_balance_of', {
        account_id: depositAddress,
      });
      if (!registered) {
        const bounds = await viewOrNull<{ min: string }>(c, token, 'storage_balance_bounds', {});
        const min = BigInt(bounds?.min ?? '1250000000000000000000');
        report.info(
          '(5) origin token storage',
          `deposit address not registered; registering costs ${formatNear(min)}`,
        );
        await c.funder.sendOk(
          token,
          [
            functionCallAction(
              'storage_deposit',
              { account_id: depositAddress, registration_only: true },
              30n * TGAS,
              min,
            ),
          ],
          'storage_deposit for the deposit address',
        );
      } else {
        report.info('(5) origin token storage', 'deposit address already registered');
      }
      const o = await c.funder.sendOk(
        token,
        [
          functionCallAction(
            'ft_transfer',
            { receiver_id: depositAddress, amount: c.a.amount },
            30n * TGAS,
            1n,
          ),
        ],
        'ft_transfer to deposit address',
      );
      try {
        await oneClick(c, '/v0/deposit/submit', {
          method: 'POST',
          body: { txHash: o.transaction?.hash ?? o.transaction_outcome?.id, depositAddress },
        });
      } catch (err) {
        report.info('deposit/submit (optional)', (err as Error).message);
      }
      return o.transaction?.hash ?? '';
    },
  );

  await check("(2c) the swap delivers to the contract account's intents balance", async () => {
    const deadline = Date.now() + 20 * 60_000;
    let last = '';
    for (;;) {
      const s = await oneClick<Status>(
        c,
        `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      );
      if (s.status !== last) {
        report.info('1Click status', s.status);
        last = s.status;
      }
      if (s.status === 'SUCCESS') break;
      if (s.status === 'REFUNDED' || s.status === 'FAILED') {
        const back = await intentsBalance(c, merchantId, c.a.originAsset);
        report.info(
          'refund landed in the contract intents balance (refundType INTENTS)',
          `${back} of ${c.a.originAsset}`,
        );
        throw new Error(`swap ended ${s.status}: ${JSON.stringify(s).slice(0, 400)}`);
      }
      if (Date.now() > deadline) throw new Error(`still ${s.status} after 20 minutes`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const bal = await intentsBalance(c, merchantId, c.a.destAsset);
    if (bal <= 0n) throw new Error(`status SUCCESS but intents balance of ${c.a.destAsset} is 0`);
    return `${bal} of ${c.a.destAsset}`;
  });
  report.info(
    'refund path',
    'refundType INTENTS to a contract was accepted by the quote; an actual refund is only exercised if the swap above had been refunded',
  );
}

async function check5Storage(c: Ctx, merchantId: string): Promise<void> {
  const omft = tokenAccount(c.a.destAsset);
  for (const token of [tokenAccount(c.a.originAsset), omft]) {
    const bounds = await viewOrNull<{ min: string; max: string | null }>(
      c,
      token,
      'storage_balance_bounds',
      {},
    );
    const mine = await viewOrNull<object>(c, token, 'storage_balance_of', {
      account_id: merchantId,
    });
    const intents = await viewOrNull<object>(c, token, 'storage_balance_of', {
      account_id: 'intents.near',
    });
    report.info(
      `(5) NEP-145 on ${token}`,
      `bounds=${JSON.stringify(bounds)} merchant=${JSON.stringify(mine)} intents.near=${JSON.stringify(intents)}`,
    );
  }
  report.info(
    '(5) conclusion',
    'a withdrawal to a non-NEAR chain burns the omft balance held by the verifier and needs no NEP-145 entry for the merchant; a `near` chain withdrawal needs the receiver registered on that token. Confirm against the finish phase result.',
  );
}

function merchantInit(priv: Uint8Array) {
  return {
    config: {
      signers: [{ id: SIGNER_ID, keys: [{ p256: b64(compressedPublicKey(priv)) }] }],
      threshold: 1,
      recovery_key: null,
      rp_id: RP_ID,
      origins: [ORIGIN],
      intents_contract: 'intents.near',
      poa_suffix: null,
      testnet_admin: null,
    },
  };
}

interface ConfigView {
  signer_epoch: string;
}

/** Proposes `action` on `merchantId` with a threshold-1 passkey approval; returns the outcome and id. */
async function propose(
  c: Ctx,
  merchantId: string,
  priv: Uint8Array,
  action: ActionJson,
): Promise<{ id: string; outcome: RawOutcome }> {
  const cfg = await view<ConfigView>(c, merchantId, 'get_config', {});
  const salt = randomBytes(32);
  const id = proposalId(action, salt);
  const challenge = approvalChallenge({
    contractId: merchantId,
    proposalId: id,
    signerEpoch: BigInt(cfg.signer_epoch),
    intent: 'approve',
  });
  const outcome = await c.funder.send(merchantId, [
    functionCallAction(
      'propose',
      { action, salt: b64(salt), approval: signedApproval(priv, SIGNER_ID, challenge) },
      RELAY_GAS,
      0n,
    ),
  ]);
  return { id, outcome };
}

async function prepare(c: Ctx): Promise<void> {
  const ts = Date.now().toString(36);
  await check('preflight: funder account and key', async () => {
    const bal = await c.funder.accountBalance(c.a.funderId);
    if (bal < 15n * NEAR)
      throw new Error(`${c.a.funderId} holds ${formatNear(bal)}; need about 15 NEAR`);
    const keys = await c.funder.rpc.accessKeyList(c.a.funderId);
    if (!keys.includes(c.funder.publicKey.nearPublicKey)) {
      throw new Error('VERIFY_FUNDER_PRIVATE_KEY is not an access key of the funder account');
    }
    return formatNear(bal);
  });
  wasm('merchant-account-probe.wasm');
  wasm('merchant-account.wasm');

  await infoRpcErrorShapes(c);
  await infoProviderRetries();
  try {
    await infoOmftTokens(c);
  } catch (err) {
    report.info('1Click token listing unavailable', (err as Error).message);
  }

  await check4ZeroKeys(c, ts);
  await check1P256(c, ts);

  const merchantId = `acct-${ts}.${c.a.funderId}`;
  const priv = p256.utils.randomPrivateKey();
  const merchantCode = wasm('merchant-account.wasm');
  await check(
    'deploy the default build to a throwaway merchant account and run `new`',
    async () => {
      await createAccountWithKey(
        c,
        merchantId,
        merchantCode,
        [functionCallAction('new', merchantInit(priv), 100n * TGAS, 0n)],
        true,
      );
      return merchantId;
    },
  );
  saveState(c.a.statePath, {
    version: 1,
    funderId: c.a.funderId,
    merchantId,
    passkeyPrivateHex: bytesToHex(priv),
    destAsset: c.a.destAsset,
    originAsset: c.a.originAsset,
    evmAddress: c.a.evmAddress,
    activeAfterMs: 0,
  });

  await check2Quote(c, merchantId);
  await check5Storage(c, merchantId);

  await check('propose the saved address (threshold-1 passkey approval)', async () => {
    const action: ActionJson = {
      add_saved_address: { id: SAVED_ADDRESS_ID, chain: 'eth', address: c.a.evmAddress },
    };
    const { id, outcome } = await propose(c, merchantId, priv, action);
    const failure = firstFailure(outcome);
    if (failure) throw new Error(failure);
    const p = await view<{ status: string }>(c, merchantId, 'get_proposal', { id });
    if (p.status !== 'executed') throw new Error(`saved-address proposal is ${p.status}`);
    return id;
  });
  saveState(c.a.statePath, {
    version: 1,
    funderId: c.a.funderId,
    merchantId,
    passkeyPrivateHex: bytesToHex(priv),
    destAsset: c.a.destAsset,
    originAsset: c.a.originAsset,
    evmAddress: c.a.evmAddress,
    activeAfterMs: Date.now() + DAY_MS + 15 * 60_000,
  });
  console.log(
    `\nprepare done. The saved address is usable after ${new Date(Date.now() + DAY_MS + 15 * 60_000).toISOString()}.\n` +
      `Then run: --phase finish${' '}--evm-address ${c.a.evmAddress} --cleanup\nState: ${c.a.statePath}`,
  );
}

async function finish(c: Ctx): Promise<void> {
  const st = loadState(c.a.statePath);
  if (st.funderId !== c.a.funderId)
    throw new UsageError('state file belongs to another funder account');
  if (st.evmAddress.toLowerCase() !== c.a.evmAddress.toLowerCase()) {
    throw new UsageError('--evm-address differs from the one used in prepare');
  }
  if (Date.now() < st.activeAfterMs) {
    throw new UsageError(
      `the saved address is not usable yet; run finish after ${new Date(st.activeAfterMs).toISOString()}`,
    );
  }
  const priv = hexToBytes(st.passkeyPrivateHex);
  const omft = tokenAccount(st.destAsset);
  const before = await intentsBalance(c, st.merchantId, st.destAsset);
  report.info('intents balance before the withdrawal', `${before} of ${st.destAsset}`);
  if (before === 0n) report.fail('withdrawal precondition', 'the merchant has nothing to withdraw');

  await check(
    '(3) threshold-approved ft_withdraw with a WITHDRAW_TO memo to the EVM address',
    async () => {
      const action: ActionJson = {
        withdraw: {
          asset: st.destAsset,
          amount: before.toString(),
          saved_address_id: SAVED_ADDRESS_ID,
          route: { poa: { token_contract: omft } },
        },
      };
      const { id, outcome } = await propose(c, st.merchantId, priv, action);
      const receipts = describeReceipts(outcome);
      for (const r of receipts) {
        report.info(
          `receipt on ${r.executor}`,
          `value=${r.value === null ? '(none)' : JSON.stringify(r.value)} failed=${r.failed ?? 'no'} logs=${JSON.stringify(r.logs)}`,
        );
      }
      const verifier = receipts.filter((r) => r.executor === 'intents.near');
      report.info(
        'real verifier return values (mt_transfer / ft_withdraw)',
        verifier.length === 0
          ? 'no receipt executed on intents.near'
          : verifier.map((r) => (r.value === null ? 'null' : r.value)).join(' | '),
      );
      report.info(
        'contract treats an unparseable mt_transfer result as success (money.rs map_or(true))',
        'compare the values above: if the verifier returns anything but a JSON amount, review that branch',
      );
      const failure = firstFailure(outcome);
      if (failure) throw new Error(`transaction failed: ${failure}`);
      const p = await view<{ status: string }>(c, st.merchantId, 'get_proposal', { id });
      if (p.status !== 'executed')
        throw new Error(`withdraw proposal is ${p.status}, not executed`);
      const after = await intentsBalance(c, st.merchantId, st.destAsset);
      if (after >= before) throw new Error(`intents balance did not drop (${before} -> ${after})`);
      return `balance ${before} -> ${after}; memo WITHDRAW_TO:${c.a.evmAddress} sent to ${omft}`;
    },
  );
  report.info(
    'delivery',
    `confirm on the EVM chain that ${c.a.evmAddress} received the bridged USDC (the omft bridge pays out within minutes)`,
  );
  await check5Storage(c, st.merchantId);

  if (c.a.cleanup) {
    const rest = await intentsBalance(c, st.merchantId, st.destAsset);
    report.info(
      'cleanup',
      `deleting ${st.merchantId}; ${rest} of ${st.destAsset} left in its intents balance is abandoned`,
    );
    const acct = new ScriptAccount(st.merchantId, c.funder.publicKey, c.funder.transport);
    await acct.sendOk(st.merchantId, [deleteAccountAction(st.funderId)], 'delete merchant account');
    report.pass('cleanup: throwaway merchant account deleted, NEAR returned');
  }
}

async function run(a: VerifyArgs): Promise<void> {
  console.log(PLAN_TEXT);
  console.log(`phase: ${a.phase}   funder: ${a.funderId}   rpc: ${a.rpcUrl}\n`);
  const c: Ctx = { a, funder: ScriptAccount.open(a.funderId, a.funderKey, a.rpcUrl) };
  if (a.phase === 'prepare') await prepare(c);
  else await finish(c);
  console.log('\nALL CHECKS PASSED');
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  run(args).then(
    () => process.exit(0),
    (err: unknown) => {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exit(2);
      }
      console.error(`STOPPED: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
