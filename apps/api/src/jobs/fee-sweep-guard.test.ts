// The gas-fee signing guard (ruling R12-c): a gas-fee key signs exactly one transfer of the
// planned token and amount to the quote's deposit address, and refuses every deviation.
import {
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { Interface, Transaction, concat, encodeRlp, toBeArray } from 'ethers';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { getKeyVault } from '../keyvault/index.js';
import { EvmRpc } from '../relayer/evm/rpc.js';
import { FakeEvmNode } from '../test/fake-evm-node.js';
import { buildTransaction, functionCallAction, transferAction, TGAS } from '../near/tx.js';
import { decodeSignedTransaction } from '@near-js/transactions';
import { associatedTokenAccount } from '../relayer/solana-tx.js';
import {
  approveData,
  encodeRaw,
  recoverSigner,
  refBlockOf,
  decodeSignedTx,
} from '../relayer/tron-tx.js';
import {
  LiveEvmSweepChain,
  buildEvmSweepTx,
  buildNearSweepTx,
  buildSolanaSweepTx,
  buildTronSweepTx,
} from './fee-sweep-chains.js';
import {
  SweepRefused,
  assertSweepTransaction,
  signSweep,
  sweepKeyAddress,
  sweepMaxFeePerGas,
  transferCalldata,
  type SweepIntent,
  type SweepTx,
} from './fee-sweep-guard.js';

const kv = () => getKeyVault();
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const EVM_DEPOSIT = '0x' + '11'.repeat(20);
const OTHER_EVM = '0x' + '22'.repeat(20);
const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const NEAR_DEPOSIT = 'ab'.repeat(32);
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_DEPOSIT = bs58.encode(new Uint8Array(32).fill(7));
const SOL_OTHER = bs58.encode(new Uint8Array(32).fill(9));
const BLOCK_ID = '00000000000000aa' + 'bb'.repeat(24);
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(3));

const refused = async (intent: SweepIntent, tx: SweepTx, field?: string) => {
  const p = assertSweepTransaction(intent, tx);
  await expect(p).rejects.toBeInstanceOf(SweepRefused);
  if (field) await expect(assertSweepTransaction(intent, tx)).rejects.toThrow(field);
};

describe('EVM sweep guard', () => {
  let from: string;
  let token: SweepIntent;
  let native: SweepIntent;
  const fees = {
    gasLimit: 200_000n,
    maxFeePerGas: 3n * 10n ** 9n,
    maxPriorityFeePerGas: 10n ** 8n,
  };
  beforeAll(async () => {
    from = await sweepKeyAddress(kv(), 'evm');
    token = {
      family: 'evm',
      chain: 'base',
      from,
      token: USDC_BASE,
      decimals: 6,
      amount: 25_000_000n,
      depositAddress: EVM_DEPOSIT,
    };
    native = { ...token, token: null, decimals: 18, amount: 10n ** 16n };
  });
  const tx = (o: Partial<Parameters<typeof buildEvmSweepTx>[0]> = {}) =>
    buildEvmSweepTx({
      chain: 'base',
      nonce: 0,
      token: USDC_BASE,
      to: EVM_DEPOSIT,
      amount: 25_000_000n,
      ...fees,
      ...o,
    });
  const raw = (o: Record<string, unknown>): SweepTx => ({
    family: 'evm',
    unsigned: Transaction.from({
      type: 2,
      chainId: 8453n,
      nonce: 0,
      to: USDC_BASE,
      value: 0n,
      data: transferCalldata(EVM_DEPOSIT, 25_000_000n),
      ...fees,
      ...o,
    }).unsignedSerialized,
  });

  it('signs exactly the planned token transfer, from the gas-fee address', async () => {
    const signed = await signSweep(kv(), token, tx());
    const t = Transaction.from(signed.signed);
    expect(t.from?.toLowerCase()).toBe(from.toLowerCase());
    expect(t.to?.toLowerCase()).toBe(USDC_BASE);
    expect(t.data).toBe(transferCalldata(EVM_DEPOSIT, 25_000_000n));
    expect(signed.txHash).toBe(t.hash);
  });

  it('signs a native transfer of the planned value to the deposit address', async () => {
    const signed = await signSweep(
      kv(),
      native,
      tx({ token: null, amount: 10n ** 16n, gasLimit: 100_000n }),
    );
    const t = Transaction.from(signed.signed);
    expect(t.to?.toLowerCase()).toBe(EVM_DEPOSIT);
    expect(t.value).toBe(10n ** 16n);
    expect(t.data).toBe('0x');
  });

  it('refuses another recipient, amount, token, chain, calldata or value', async () => {
    await refused(token, tx({ to: OTHER_EVM }), 'transaction.data');
    await refused(token, tx({ amount: 25_000_001n }), 'transaction.data');
    await refused(token, raw({ to: OTHER_EVM }), 'transaction.to');
    await refused(token, raw({ chainId: 1n }), 'transaction.chain_id');
    await refused(token, raw({ value: 1n }), 'transaction.value');
    const approve = new Interface(['function approve(address,uint256)']).encodeFunctionData(
      'approve',
      [EVM_DEPOSIT, 25_000_000n],
    );
    await refused(token, raw({ data: approve }), 'transaction.data');
    // Dirty trailing bytes after a valid transfer.
    await refused(token, raw({ data: transferCalldata(EVM_DEPOSIT, 25_000_000n) + '00' }));
    await refused(token, raw({ gasLimit: 10_000_000n }), 'transaction.gas_limit');
    await refused(token, raw({ accessList: [{ address: OTHER_EVM, storageKeys: [] }] }));
    await refused(
      token,
      raw({ type: 0, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }),
    );
  });

  it('refuses a fee per gas above the chain cap, or a tip above the max fee (R12-l)', async () => {
    const gwei = 10n ** 9n;
    // base: the sweep default cap is 5 gwei.
    await assertSweepTransaction(token, raw({ maxFeePerGas: 5n * gwei }));
    await refused(token, raw({ maxFeePerGas: 5n * gwei + 1n }), 'transaction.max_fee_per_gas');
    await refused(token, raw({ maxFeePerGas: 10_000n * gwei }), 'transaction.max_fee_per_gas');
    // ethers will not serialise a tip above the max fee: hand-encode the RLP (a hostile transport).
    const q = (n: bigint) => toBeArray(n);
    const tipAboveMax: SweepTx = {
      family: 'evm',
      unsigned: concat([
        '0x02',
        encodeRlp([
          q(8453n),
          q(0n),
          q(3n * gwei + 1n),
          q(3n * gwei),
          q(200_000n),
          USDC_BASE,
          q(0n),
          transferCalldata(EVM_DEPOSIT, 25_000_000n),
          [],
        ]),
      ]),
    };
    await refused(token, tipAboveMax);
    await refused(token, raw({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }));
    // EVM_MAX_FEE_GWEI_<CHAIN>, when set, is the cap.
    process.env.EVM_MAX_FEE_GWEI_BASE = '2';
    loadEnv();
    try {
      await refused(token, raw({}), 'transaction.max_fee_per_gas');
      await assertSweepTransaction(token, raw({ maxFeePerGas: 2n * gwei }));
      expect(sweepMaxFeePerGas('base')).toBe(2n * gwei);
    } finally {
      delete process.env.EVM_MAX_FEE_GWEI_BASE;
      loadEnv();
    }
    // A legacy transaction (its `gasPrice` unbounded by type-2 fields) is refused outright.
    await refused(
      token,
      raw({
        type: 0,
        gasPrice: 10n ** 18n,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      }),
      'transaction.type',
    );
  });

  it('the live EVM transport clamps fees to the cap and reserves gas for 3 token sweeps', async () => {
    const node = new FakeEvmNode();
    node.baseFee = 100n * 10n ** 9n; // a spike far above the 5 gwei cap
    node.tip = 2n * 10n ** 9n;
    const chain = new LiveEvmSweepChain(() => new EvmRpc('base', 'http://node', node.fetch));
    const usdc = { assetId: 'x', symbol: 'USDC', decimals: 6, contract: USDC_BASE };
    const tx = await chain.build('base', from, usdc, EVM_DEPOSIT, 25_000_000n);
    await assertSweepTransaction(token, tx);
    const t = Transaction.from((tx as { unsigned: string }).unsigned);
    expect(t.maxFeePerGas).toBe(sweepMaxFeePerGas('base'));
    expect(t.maxPriorityFeePerGas).toBe(2n * 10n ** 9n);
    const fee = await chain.transferFee('base', from, usdc);
    expect(await chain.nativeReserve('base')).toBeGreaterThanOrEqual(
      3n * fee + 100_000n * t.maxFeePerGas!,
    );
  });

  it('refuses a native transfer with calldata, another value or recipient', async () => {
    const n = (o: Record<string, unknown>) =>
      raw({ to: EVM_DEPOSIT, value: 10n ** 16n, data: '0x', gasLimit: 100_000n, ...o });
    await assertSweepTransaction(native, n({}));
    await refused(native, n({ data: '0x01' }), 'transaction.data');
    await refused(native, n({ value: 10n ** 16n + 1n }), 'transaction.value');
    await refused(native, n({ to: OTHER_EVM }), 'transaction.to');
  });

  it('refuses a plan whose account is not the key, and a family mismatch', async () => {
    await expect(signSweep(kv(), { ...token, from: OTHER_EVM }, tx())).rejects.toThrow('from');
    await refused(token, { family: 'near', transaction: new Uint8Array() }, 'family');
  });
});

describe('NEAR sweep guard', () => {
  let from: string;
  let pub: Uint8Array;
  let intent: SweepIntent;
  beforeAll(async () => {
    from = await sweepKeyAddress(kv(), 'near');
    pub = (await kv().publicKey('gas-fees-near')).raw;
    intent = {
      family: 'near',
      chain: 'near',
      from,
      token: NEAR_USDC,
      decimals: 6,
      amount: 30_000_000n,
      depositAddress: NEAR_DEPOSIT,
    };
  });
  const custom = (
    actions: ReturnType<typeof transferAction>[],
    receiverId = NEAR_USDC,
  ): SweepTx => ({
    family: 'near',
    transaction: buildTransaction({
      signerId: from,
      publicKey: pub,
      nonce: 5n,
      receiverId,
      blockHash: new Uint8Array(32).fill(1),
      actions,
    }).encode(),
  });
  const ft = (args: object, deposit = 1n, method = 'ft_transfer', gas = 15n * TGAS) =>
    functionCallAction(method, args, gas, deposit);
  const good = { receiver_id: NEAR_DEPOSIT, amount: '30000000' };

  it('signs one ft_transfer of the planned amount to the deposit address', async () => {
    const tx = buildNearSweepTx({
      signerId: from,
      publicKey: pub,
      nonce: 5n,
      blockHash: new Uint8Array(32).fill(1),
      token: NEAR_USDC,
      to: NEAR_DEPOSIT,
      amount: 30_000_000n,
    });
    const signed = await signSweep(kv(), intent, tx);
    const st = decodeSignedTransaction(Buffer.from(signed.signed, 'base64')) as unknown as {
      signature: { ed25519Signature: { data: number[] } };
    };
    const sig = Uint8Array.from(st.signature.ed25519Signature.data);
    expect(ed25519.verify(sig, sha256((tx as { transaction: Uint8Array }).transaction), pub)).toBe(
      true,
    );
    expect(signed.txHash).toBe(
      bs58.encode(sha256((tx as { transaction: Uint8Array }).transaction)),
    );
  });

  it('refuses another method, deposit, recipient, amount, contract or a second action', async () => {
    await assertSweepTransaction(intent, custom([ft(good)]));
    await refused(intent, custom([ft(good, 1n, 'ft_transfer_call')]), 'transaction.method');
    await refused(intent, custom([ft(good, 0n)]), 'transaction.deposit');
    await refused(intent, custom([ft({ ...good, receiver_id: 'evil.near' })]), 'receiver_id');
    await refused(intent, custom([ft({ ...good, amount: '30000001' })]), 'args.amount');
    await refused(intent, custom([ft({ ...good, memo: 'x' })]), 'transaction.args');
    await refused(intent, custom([ft(good)], 'usdt.tether-token.near'), 'transaction.receiver');
    await refused(intent, custom([ft(good), ft(good)]), 'transaction.actions');
    await refused(intent, custom([transferAction(1n)]), 'transaction.actions[0]');
    await refused(intent, custom([ft(good, 1n, 'ft_transfer', 300n * TGAS)]), 'transaction.gas');
    await refused(intent, custom([ft({ receiver_id: NEAR_DEPOSIT, amount: 30_000_000 })]));
  });
});

describe('Tron sweep guard', () => {
  let from: string;
  let intent: SweepIntent;
  let deposit: string;
  beforeAll(async () => {
    from = await sweepKeyAddress(kv(), 'tron');
    deposit = (await import('../relayer/tron-tx.js')).tronAddressOfPublicKey(
      (await kv().publicKey('gas-tron')).raw,
    );
    intent = {
      family: 'tron',
      chain: 'tron',
      from,
      token: TRON_USDT,
      decimals: 6,
      amount: 40_000_000n,
      depositAddress: deposit,
    };
  });
  const tx = (o: Partial<Parameters<typeof buildTronSweepTx>[0]> = {}) =>
    buildTronSweepTx({
      blockId: BLOCK_ID,
      now: 1_700_000_000_000,
      owner: from,
      token: TRON_USDT,
      to: deposit,
      amount: 40_000_000n,
      feeLimit: 50_000_000n,
      ...o,
    });

  it('signs one USDT transfer to the deposit address, recoverable to the gas-fee address', async () => {
    const signed = await signSweep(kv(), intent, tx());
    const { signature } = decodeSignedTx(signed.signed);
    expect(recoverSigner(signed.txHash, signature)).toBe(from);
  });

  it('refuses an approve, another recipient/amount/contract/owner or an unbounded fee', async () => {
    await refused(intent, tx({ to: TRON_USDT }), 'transaction.data');
    await refused(intent, tx({ amount: 1n }), 'transaction.data');
    await refused(intent, tx({ token: deposit }), 'transaction.contract_address');
    await refused(intent, tx({ owner: deposit }), 'transaction.owner');
    await refused(intent, tx({ feeLimit: 10n ** 12n }), 'transaction.fee_limit');
    const approve: SweepTx = {
      family: 'tron',
      raw: encodeRaw({
        ref: refBlockOf(BLOCK_ID),
        expiration: 1n,
        timestamp: 1n,
        feeLimit: 1_000_000n,
        contract: {
          type: 'trigger',
          owner: from,
          contract: TRON_USDT,
          data: approveData(deposit, 40_000_000n),
        },
      }),
    };
    await refused(intent, approve, 'transaction.data');
    const delegate: SweepTx = {
      family: 'tron',
      raw: encodeRaw({
        ref: refBlockOf(BLOCK_ID),
        expiration: 1n,
        timestamp: 1n,
        feeLimit: 0n,
        contract: {
          type: 'delegate',
          owner: from,
          receiver: deposit,
          resource: 'energy',
          balance: 1n,
        },
      }),
    };
    await refused(intent, delegate, 'transaction.contract');
  });
});

describe('Solana sweep guard', () => {
  let from: string;
  let intent: SweepIntent;
  beforeAll(async () => {
    from = await sweepKeyAddress(kv(), 'solana');
    intent = {
      family: 'solana',
      chain: 'sol',
      from,
      token: SOL_USDC,
      decimals: 6,
      amount: 50_000_000n,
      depositAddress: SOL_DEPOSIT,
    };
  });
  const build = (o: Partial<Parameters<typeof buildSolanaSweepTx>[0]> = {}) =>
    buildSolanaSweepTx({
      owner: from,
      mint: SOL_USDC,
      decimals: 6,
      to: SOL_DEPOSIT,
      amount: 50_000_000n,
      blockhash: BLOCKHASH,
      createDeposit: false,
      ...o,
    });

  it('signs the transfer (with or without creating the deposit token account)', async () => {
    const tx = await build();
    const signed = await signSweep(kv(), intent, tx);
    const msg = (tx as { message: Uint8Array }).message;
    const sig = bs58.decode(signed.txHash);
    expect(ed25519.verify(sig, msg, bs58.decode(from))).toBe(true);
    await assertSweepTransaction(intent, await build({ createDeposit: true }));
  });

  it('refuses another destination, amount, decimals or mint', async () => {
    await refused(intent, await build({ to: SOL_OTHER }), 'transfer.destination');
    await refused(intent, await build({ amount: 1n }), 'transfer.amount');
    await refused(intent, await build({ decimals: 9 }), 'transfer.decimals');
    await refused(intent, await build({ mint: SOL_DEPOSIT }));
  });

  it('refuses a second transfer, a compute-budget instruction or a create for another owner', async () => {
    const owner = createNoopSigner(address(from));
    const mint = address(SOL_USDC);
    const src = address(await associatedTokenAccount(from, SOL_USDC));
    const dep = address(await associatedTokenAccount(SOL_DEPOSIT, SOL_USDC));
    const other = address(await associatedTokenAccount(SOL_OTHER, SOL_USDC));
    const transfer = (dest: typeof dep) =>
      getTransferCheckedInstruction({
        source: src,
        mint,
        destination: dest,
        authority: owner,
        amount: 50_000_000n,
        decimals: 6,
      });
    const compile = (ixs: Parameters<typeof appendTransactionMessageInstructions>[0], cu = 0) => {
      const m = pipe(
        createTransactionMessage({ version: 0 }),
        (x) => setTransactionMessageFeePayer(address(from), x),
        (x) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: toBlockhash(BLOCKHASH), lastValidBlockHeight: 0n },
            x,
          ),
        (x) => (cu > 0 ? setTransactionMessageComputeUnitLimit(cu, x) : x),
        (x) => appendTransactionMessageInstructions(ixs, x),
      );
      return {
        family: 'solana' as const,
        message: Uint8Array.from(compileTransaction(m).messageBytes),
      };
    };
    await assertSweepTransaction(intent, compile([transfer(dep)]));
    await refused(intent, compile([transfer(dep), transfer(other)]));
    await refused(intent, compile([transfer(dep)], 100_000));
    await refused(
      intent,
      compile([
        getCreateAssociatedTokenIdempotentInstruction({
          payer: owner,
          ata: other,
          owner: address(SOL_OTHER),
          mint,
        }),
        transfer(dep),
      ]),
      'instructions[0]',
    );
  });
});
