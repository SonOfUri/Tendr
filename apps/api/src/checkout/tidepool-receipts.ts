import type { NativePayout } from '@prisma/client';
import { id } from 'ethers';
import { nearClient } from '../near/client.js';
import { matchingCredits, parseEventLog } from '../near/events.js';
import {
  TIDEPOOL_TOKENS,
  TIDEPOOL_VERIFIER,
  tidepoolNearSettlementHashes,
} from './oneclick/tidepool.js';
import type { StatusResponse } from './oneclick/types.js';

const transferTopic = id('Transfer(address,address,uint256)');
const BASE_RPC = 'https://sepolia.base.org';
const SOL_RPC = 'https://api.devnet.solana.com';

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { result: T; error?: unknown };
  if (!response.ok || body.error) throw new Error('Testnet receipt RPC unavailable');
  return body.result;
}

/** SUCCESS is not sufficient: independently verify the token, recipient, amount and finality. */
export async function verifyTidepoolPayout(
  payout: Pick<
    NativePayout,
    | 'livemode'
    | 'destinationAsset'
    | 'destinationChain'
    | 'destination'
    | 'asset'
    | 'amount'
    | 'depositAddress'
    | 'quote'
    | 'payload'
    | 'intentHash'
  >,
  status: StatusResponse,
): Promise<boolean> {
  if (payout.livemode || status.status !== 'SUCCESS') return false;
  const token = Object.values(TIDEPOOL_TOKENS).find((t) => t.assetId === payout.destinationAsset);
  if (!token || token.blockchain !== payout.destinationChain) return false;
  const quote = payout.quote as unknown as { quote: { minAmountOut?: string; amountOut: string } };
  const minimum = quote.quote.minAmountOut ?? quote.quote.amountOut;
  if (!/^[1-9]\d*$/.test(minimum)) return false;
  let delivered = 0n;
  if (token.blockchain === 'near') {
    for (const hash of tidepoolNearSettlementHashes(status)) {
      const tx = await nearClient(false).txStatus(hash, token.contract);
      if (!tx?.finalized || !tx.topLevelOk) continue;
      delivered += matchingCredits(tx.receipts, {
        assetId: token.assetId,
        receiver: payout.destination,
      }).reduce((sum, credit) => sum + credit.amount, 0n);
    }
  } else if (token.blockchain === 'base') {
    if ((await rpc<string>(BASE_RPC, 'eth_chainId', [])) !== '0x14a34') return false;
    const head = BigInt(await rpc<string>(BASE_RPC, 'eth_blockNumber', []));
    for (const hash of new Set(status.swapDetails.destinationChainTxHashes.map((t) => t.hash))) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) continue;
      const tx = await rpc<{
        status: string;
        blockNumber: string;
        logs: { address: string; topics: string[]; data: string; removed?: boolean }[];
      } | null>(BASE_RPC, 'eth_getTransactionReceipt', [hash]);
      if (!tx || tx.status !== '0x1' || head < BigInt(tx.blockNumber) + 1n) continue;
      for (const log of tx.logs) {
        if (
          log.removed ||
          log.address.toLowerCase() !== token.contract.toLowerCase() ||
          log.topics[0] !== transferTopic ||
          log.topics.length !== 3 ||
          !/^0x[0-9a-fA-F]{64}$/.test(log.data)
        )
          continue;
        if (
          log.topics[2]!.toLowerCase() ===
          `0x${payout.destination.slice(2).toLowerCase().padStart(64, '0')}`
        )
          delivered += BigInt(log.data);
      }
    }
  } else {
    if (
      (await rpc<string>(SOL_RPC, 'getGenesisHash', [])) !==
      'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    )
      return false;
    type Balance = {
      accountIndex: number;
      mint: string;
      owner: string;
      uiTokenAmount: { amount: string };
    };
    for (const hash of new Set(status.swapDetails.destinationChainTxHashes.map((t) => t.hash))) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash)) continue;
      const tx = await rpc<{
        meta: { err: unknown; preTokenBalances: Balance[]; postTokenBalances: Balance[] };
      } | null>(SOL_RPC, 'getTransaction', [
        hash,
        { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      ]);
      if (!tx?.meta || tx.meta.err) continue;
      for (const post of tx.meta.postTokenBalances) {
        if (post.mint !== token.contract || post.owner !== payout.destination) continue;
        const pre = tx.meta.preTokenBalances.find(
          (b) =>
            b.accountIndex === post.accountIndex && b.mint === post.mint && b.owner === post.owner,
        );
        const delta = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0');
        if (delta > 0n) delivered += delta;
      }
    }
  }
  // Also require a successful verifier debit to this payout's unique deposit account.
  if (delivered < BigInt(minimum)) return false;
  const payload = JSON.parse(payout.payload) as { signer_id: string; nonce: string };
  const originStatus = {
    ...status,
    swapDetails: {
      ...status.swapDetails,
      destinationChainTxHashes: status.swapDetails.originChainTxHashes,
    },
  };
  for (const hash of tidepoolNearSettlementHashes(originStatus)) {
    const tx = await nearClient(false).txStatus(hash, TIDEPOOL_VERIFIER);
    if (!tx?.finalized || !tx.topLevelOk) continue;
    const credited = matchingCredits(tx.receipts, {
      assetId: payout.asset,
      receiver: payout.depositAddress,
      intentsContract: TIDEPOOL_VERIFIER,
    }).reduce((sum, c) => sum + c.amount, 0n);
    const events = tx.receipts
      .filter((r) => r.ok && r.executorId === TIDEPOOL_VERIFIER)
      .flatMap((r) => r.logs.map(parseEventLog))
      .filter((e) => e?.standard === 'dip4');
    const executed = events.some(
      (e) =>
        e?.event === 'intents_executed' &&
        Array.isArray(e.data) &&
        e.data.some(
          (d: Record<string, unknown>) =>
            d.account_id === payload.signer_id &&
            d.nonce === payload.nonce &&
            (!payout.intentHash || d.intent_hash === payout.intentHash),
        ),
    );
    const transferred = events.some(
      (e) =>
        e?.event === 'transfer' &&
        Array.isArray(e.data) &&
        e.data.some(
          (d: Record<string, unknown>) =>
            d.account_id === payload.signer_id &&
            d.receiver_id === payout.depositAddress &&
            (d.tokens as Record<string, unknown> | undefined)?.[payout.asset] === payout.amount &&
            (!payout.intentHash || d.intent_hash === payout.intentHash),
        ),
    );
    if (credited >= BigInt(payout.amount) && executed && transferred) return true;
  }
  return false;
}
