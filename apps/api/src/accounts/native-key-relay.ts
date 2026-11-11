import { z } from 'zod';
import { env } from '../env.js';

/** A single FINAL block anchors all reads: expiry cannot be inferred from the API clock. */
export interface KeyChainState {
  blockTimeMs: number;
  nonceUsed: boolean;
  keys: Record<string, boolean>;
}
export interface NativeKeyRelay {
  salt(): Promise<string>;
  state(accountId: string, publicKeys: string[], nonce?: string): Promise<KeyChainState>;
  publish(signed: object): Promise<string>;
}

async function rpc(url: string, method: string, params: object, apiKey?: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'wallet-keys', method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  // Never surface provider bodies (which can echo signed messages or credentials).
  if (!response.ok || body.error || body.result === undefined)
    throw new Error('Wallet key provider unavailable');
  return body.result;
}

async function view(method: string, args: object, blockHash?: string): Promise<unknown> {
  const result = z.object({ result: z.array(z.number().int().min(0).max(255)) }).parse(
    await rpc(env().NEAR_RPC_URL_LIVE, 'query', {
      request_type: 'call_function',
      ...(blockHash ? { block_id: blockHash } : { finality: 'final' }),
      account_id: env().INTENTS_CONTRACT_LIVE,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    }),
  );
  return JSON.parse(Buffer.from(result.result).toString('utf8')) as unknown;
}

export class HttpNativeKeyRelay implements NativeKeyRelay {
  async salt() {
    return z
      .string()
      .regex(/^[0-9a-f]{8}$/)
      .parse(await view('current_salt', {}));
  }
  async state(accountId: string, publicKeys: string[], nonce?: string): Promise<KeyChainState> {
    const block = z
      .object({
        header: z.object({ hash: z.string().min(1), timestamp_nanosec: z.string().regex(/^\d+$/) }),
      })
      .parse(await rpc(env().NEAR_RPC_URL_LIVE, 'block', { finality: 'final' }));
    const keys = [...new Set(publicKeys)];
    const [nonceUsed, entries] = await Promise.all([
      nonce
        ? view('is_nonce_used', { account_id: accountId, nonce }, block.header.hash).then((v) =>
            z.boolean().parse(v),
          )
        : false,
      Promise.all(
        keys.map(
          async (publicKey) =>
            [
              publicKey,
              z.boolean().parse(
                await view(
                  'has_public_key',
                  {
                    account_id: accountId,
                    public_key: publicKey,
                  },
                  block.header.hash,
                ),
              ),
            ] as const,
        ),
      ),
    ]);
    return {
      blockTimeMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n),
      nonceUsed,
      keys: Object.fromEntries(entries),
    };
  }
  async publish(signed: object) {
    const result = z
      .object({ status: z.literal('OK'), intent_hash: z.string().min(1).max(128) })
      .parse(
        await rpc(
          env().INTENTS_RELAY_URL,
          'publish_intent',
          [{ quote_hashes: [], signed_data: signed }],
          env().INTENTS_RELAY_API_KEY,
        ),
      );
    return result.intent_hash;
  }
}

let relay: NativeKeyRelay = new HttpNativeKeyRelay();
export const nativeKeyRelay = () => relay;
/** Tests inject a chain model; production always uses the final-block RPC and generic relay. */
export function setNativeKeyRelay(value: NativeKeyRelay | null) {
  relay = value ?? new HttpNativeKeyRelay();
}
