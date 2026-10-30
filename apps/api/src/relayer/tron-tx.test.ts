// Tron transaction encoding, the shopper's approve check helpers and the gas-tron signing guard.
import { secp256k1 } from '@noble/curves/secp256k1';
import { describe, expect, it } from 'vitest';
import { getKeyVault } from '../keyvault/index.js';
import { TronCallReverted, TronHttp } from './tron-rpc.js';
import {
  approveData,
  assertGasTronTransaction,
  decodeApprove,
  decodeRaw,
  encodeRaw,
  evmToTron,
  FORWARDER,
  rawDataJson,
  recoverSigner,
  refBlockOf,
  signGasTron,
  tronAddress,
  tronAddressOfPublicKey,
  tronBytes,
  tronToEvm,
  txIdOf,
  type GasTronPolicy,
  type TronRaw,
} from './tron-tx.js';

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const REF = refBlockOf('0000000003b3a6d1' + 'ab'.repeat(8) + 'cd'.repeat(16));

describe('Tron addresses', () => {
  it('reads the USDT contract address', () => {
    expect(Buffer.from(tronBytes(USDT)!).toString('hex')).toBe(
      '41a614f803b6fd780986a42c78ec9c7f77e6ded13c',
    );
    expect(tronToEvm(USDT)).toBe('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(evmToTron('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe(USDT);
  });

  it('refuses a bad checksum or a non-41 prefix', () => {
    expect(tronBytes('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBeNull();
    expect(tronBytes('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBeNull();
  });
});

describe('Tron transactions', () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const wallet = tronAddressOfPublicKey(secp256k1.getPublicKey(priv, false));
  const forwarder = evmToTron('0x' + '11'.repeat(20));
  const approve: TronRaw = {
    ref: REF,
    expiration: 1_800_000_000_000n,
    timestamp: 1_799_999_000_000n,
    feeLimit: 30_000_000n,
    contract: {
      type: 'trigger',
      owner: wallet,
      contract: USDT,
      data: approveData(forwarder, 1234n),
    },
  };

  it('round-trips and takes the ref block from the block id', () => {
    expect(Buffer.from(REF.bytes).toString('hex')).toBe('a6d1');
    expect(Buffer.from(REF.hash).toString('hex')).toBe('ab'.repeat(8));
    const bytes = encodeRaw(approve);
    expect(decodeRaw(bytes)).toEqual(approve);
    expect(decodeApprove((decodeRaw(bytes).contract as { data: Uint8Array }).data)).toEqual({
      spender: forwarder,
      value: 1234n,
    });
  });

  it('hands wallets the same transaction as TronGrid JSON (hex addresses)', () => {
    const j = rawDataJson(approve);
    const v = j.contract[0]!.parameter.value;
    const back: TronRaw = {
      ref: {
        bytes: Uint8Array.from(Buffer.from(j.ref_block_bytes, 'hex')),
        hash: Uint8Array.from(Buffer.from(j.ref_block_hash, 'hex')),
      },
      expiration: BigInt(j.expiration),
      timestamp: BigInt(j.timestamp),
      feeLimit: BigInt(j.fee_limit),
      contract: {
        type: 'trigger',
        owner: tronAddress(Buffer.from(v.owner_address, 'hex')),
        contract: tronAddress(Buffer.from(v.contract_address, 'hex')),
        data: Uint8Array.from(Buffer.from(v.data, 'hex')),
      },
    };
    expect(Buffer.from(encodeRaw(back)).equals(Buffer.from(encodeRaw(approve)))).toBe(true);
    expect(j.contract[0]!.type).toBe('TriggerSmartContract');
    expect(v.contract_address).toBe('41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
  });

  it('refuses extra fields, a second contract and trailing calldata', () => {
    const bytes = encodeRaw(approve);
    // A memo (field 10).
    expect(() => decodeRaw(Uint8Array.from([...bytes, 0x52, 0x01, 0x41]))).toThrow();
    // A permission id inside the contract cannot be added without changing field 11 → refused
    // through re-encoding; a repeated field 11 is refused outright.
    const contract = bytes.slice(bytes.indexOf(0x5a));
    expect(() => decodeRaw(Uint8Array.from([...bytes, ...contract]))).toThrow();
    const data = approveData(forwarder, 1n);
    expect(decodeApprove(Uint8Array.from([...data, 0]))).toBeNull();
    expect(
      decodeApprove(Uint8Array.from([0xa9, 0x05, 0x9c, 0xbb, ...data.subarray(4)])),
    ).toBeNull();
  });

  it('recovers the signer of a txid (v 27/28 or 0/1)', () => {
    const id = txIdOf(encodeRaw(approve));
    const sig = secp256k1.sign(Buffer.from(id, 'hex'), priv);
    const compact = sig.toCompactRawBytes();
    expect(recoverSigner(id, Uint8Array.from([...compact, sig.recovery + 27]))).toBe(wallet);
    expect(recoverSigner(id, Uint8Array.from([...compact, sig.recovery]))).toBe(wallet);
    expect(recoverSigner(id, Uint8Array.from([...compact, (sig.recovery ^ 1) + 27]))).not.toBe(
      wallet,
    );
    expect(recoverSigner(id, compact)).toBeNull();
  });
});

describe('gas-tron signing guard', () => {
  async function policy(): Promise<GasTronPolicy> {
    const gasTron = tronAddressOfPublicKey((await getKeyVault().publicKey('gas-tron')).raw);
    return {
      gasTron,
      forwarder: evmToTron('0x' + '22'.repeat(20)),
      maxFeeLimitSun: 150_000_000n,
      maxDelegationSun: 100_000_000_000n,
    };
  }
  const shopper = evmToTron('0x' + '33'.repeat(20));
  const payData = () =>
    Buffer.from(
      FORWARDER.encodeFunctionData('payWithApproval', [
        {
          token: tronToEvm(USDT),
          from: '0x' + '33'.repeat(20),
          to: '0x' + '44'.repeat(20),
          amount: 1n,
          fee: 0n,
          feeTo: '0x' + '55'.repeat(20),
          deadline: 1n,
          nonce: '0x' + '00'.repeat(32),
        },
        '0x',
      ]).slice(2),
      'hex',
    );

  it('signs payWithApproval and bounded delegations, and the signature recovers to gas-tron', async () => {
    const p = await policy();
    const raw: TronRaw = {
      ref: REF,
      expiration: 2n,
      timestamp: 1n,
      feeLimit: 100_000_000n,
      contract: { type: 'trigger', owner: p.gasTron, contract: p.forwarder, data: payData() },
    };
    const s = await signGasTron(getKeyVault(), raw, p);
    const signed = Buffer.from(s.signedHex, 'hex');
    expect(recoverSigner(s.txId, Uint8Array.from(signed.subarray(signed.length - 65)))).toBe(
      p.gasTron,
    );
    const del: TronRaw = {
      ...raw,
      feeLimit: 0n,
      contract: {
        type: 'delegate',
        owner: p.gasTron,
        receiver: shopper,
        resource: 'energy',
        balance: 5_000_000_000n,
      },
    };
    await expect(signGasTron(getKeyVault(), del, p)).resolves.toBeTruthy();
    expect(decodeRaw(encodeRaw(del))).toEqual(del);
  });

  it('refuses anything else', async () => {
    const p = await policy();
    const base: TronRaw = {
      ref: REF,
      expiration: 2n,
      timestamp: 1n,
      feeLimit: 100_000_000n,
      contract: { type: 'trigger', owner: p.gasTron, contract: p.forwarder, data: payData() },
    };
    const bad: TronRaw[] = [
      { ...base, contract: { ...base.contract, contract: USDT } as TronRaw['contract'] },
      {
        ...base,
        contract: {
          ...base.contract,
          data: approveData(shopper, 1n),
        } as TronRaw['contract'],
      },
      { ...base, feeLimit: 200_000_000n },
      { ...base, contract: { ...base.contract, owner: shopper } as TronRaw['contract'] },
      {
        ...base,
        feeLimit: 0n,
        contract: {
          type: 'delegate',
          owner: p.gasTron,
          receiver: shopper,
          resource: 'energy',
          balance: 100_000_000_001n,
        },
      },
    ];
    for (const raw of bad) expect(() => assertGasTronTransaction(raw, p)).toThrow();
  });
});

describe('TronHttp constant calls', () => {
  const answer = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const call = (body: unknown) =>
    new TronHttp({ url: 'https://tron.example', fetch: answer(body) }).constantCall(
      USDT,
      USDT,
      'approve(address,uint256)',
      '00',
    );

  it('returns the result and energy of a call that ran', async () => {
    await expect(
      call({
        result: { result: true },
        energy_used: 31_000,
        constant_result: ['01'],
        transaction: { ret: [{}] },
      }),
    ).resolves.toEqual({ result: '01', energyUsed: 31_000n });
  });

  it('surfaces a revert, which TronGrid still answers with result: true', async () => {
    await expect(
      call({
        result: { result: true },
        energy_used: 2_000,
        constant_result: [''],
        transaction: { ret: [{ ret: 'FAILED' }] },
      }),
    ).rejects.toBeInstanceOf(TronCallReverted);
    await expect(
      call({
        result: { code: 'CONTRACT_EXE_ERROR', message: Buffer.from('REVERT').toString('hex') },
      }),
    ).rejects.toThrow(/REVERT/);
  });
});
