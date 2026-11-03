// Only the offline console calls this. Production never restores a blockchain from SQL.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { SignerKeySchema } from '@tendr/contracts';
import { env } from '../src/env.js';
import { prisma } from '../src/lib/prisma.js';
import { fakeNearClient, type InitConfigJson } from '../src/near/client.js';

export async function restoreLocalConsoleState(
  path: string,
): Promise<{ restored: number; checkpoint: boolean }> {
  const e = env();
  const database = new URL(e.DATABASE_URL);
  if (
    e.NODE_ENV === 'production' ||
    e.NEAR_CLIENT_DRIVER !== 'fake' ||
    !e.NEAR_FAKE_SIMULATE ||
    !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
  )
    throw new Error('Simulator recovery requires a local database and the development fake driver');
  const identity = `${database.host}${database.pathname}`;
  const client = fakeNearClient(false);
  const checkpoint = existsSync(path);
  if (checkpoint) {
    const saved = deserialize(readFileSync(path));
    if (saved.database !== identity)
      throw new Error('Simulator checkpoint belongs to another database');
    client.restore(saved.state);
  }
  let restored = 0;
  const accounts = await prisma.merchantAccount.findMany({
    where: { livemode: false, kind: 'contract', status: 'active' },
  });
  for (const account of accounts) {
    if (client.accounts.has(account.nearAccountId)) continue;
    const scope = { merchantId: account.merchantId, livemode: false };
    const keys = await prisma.accountKey.findMany({
      where: { ...scope, nearAccountId: account.nearAccountId, kind: 'passkey', revokedAt: null },
    });
    const signers: InitConfigJson['signers'] = [];
    for (const k of keys) {
      if (!k.userId) continue;
      const colon = k.publicKey.indexOf(':');
      const key = SignerKeySchema.parse({
        [k.publicKey.slice(0, colon)]: k.publicKey.slice(colon + 1),
      });
      let signer = signers.find((s) => s.id === k.userId);
      if (!signer) {
        signer = { id: k.userId, keys: [] };
        signers.push(signer);
      }
      signer.keys.push(key);
    }
    if (!signers.length)
      throw new Error(`Cannot recover simulated account ${account.id}: no mirrored signer keys`);
    // Existing accounts predate checkpoints. Refuse to discard unrepresented advanced state.
    const advanced =
      (await prisma.accountProposal.count({
        where: { accountId: account.id, status: { not: 'draft' } },
      })) +
      (await prisma.accountLimit.count({ where: { accountId: account.id } })) +
      (await prisma.recoveryRequest.count({ where: { accountId: account.id } })) +
      (await prisma.accountKey.count({
        where: {
          ...scope,
          nearAccountId: account.nearAccountId,
          kind: 'recovery',
          revokedAt: null,
        },
      }));
    if (advanced)
      throw new Error(
        `Missing checkpoint for ${account.id}: restore its simulator backup before starting`,
      );
    await client.provisionAccount({
      merchantId: account.merchantId,
      livemode: false,
      accountId: account.nearAccountId,
      initialBalanceYocto: e.MERCHANT_ACCOUNT_INITIAL_BALANCE_YOCTO,
      init: {
        signers,
        threshold: account.threshold,
        recovery_key: null,
        rp_id: e.WEBAUTHN_RP_ID,
        origins: [...e.WEBAUTHN_ORIGINS],
        intents_contract: e.INTENTS_CONTRACT_TEST,
        poa_suffix: null,
        testnet_admin: e.NEAR_PARENT_ACCOUNT_TEST,
      },
    });
    const snapshot = client.snapshot();
    const state = snapshot.contracts!.get(account.nearAccountId)!;
    state.epoch = account.signerEpoch;
    const saved = await prisma.payoutAllowlistEntry.findMany({
      where: { ...scope, status: { not: 'revoked' } },
    });
    state.saved = saved.map((s) => ({
      id: s.id,
      chain: s.chain,
      address: s.address,
      active_from: BigInt(s.activeFrom.getTime()) * 1_000_000n,
    }));
    const settlement = await prisma.settlementConfig.findFirst({
      where: { ...scope, isDefault: true },
    });
    if (settlement)
      state.settlement = {
        dest_asset: settlement.destAssetId,
        payout_mode: settlement.payoutMode,
        saved_address_id:
          saved.find(
            (s) => s.address === settlement.payoutAddress && s.chain === settlement.destChain,
          )?.id ?? null,
      };
    // The fake verifier credits deposits and does not debit simulated withdrawals/refunds.
    const claims = await prisma.settlementClaim.findMany({
      where: scope,
      include: { payment: { include: { session: true } } },
    });
    for (const claim of claims) {
      const session = claim.payment.session;
      if (session.recipientType !== 'INTENTS' || session.recipient !== account.nearAccountId)
        continue;
      const key = `${account.nearAccountId}|${session.destAsset}`;
      snapshot.balances.set(
        key,
        (snapshot.balances.get(key) ?? 0n) + BigInt(claim.amount.toFixed(0)),
      );
    }
    client.restore(snapshot);
    restored++;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const save = () => {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, serialize({ database: identity, state: client.snapshot() }), {
      mode: 0o600,
    });
    renameSync(temp, path);
  };
  save();
  client.onStateChange(save);
  return { restored, checkpoint };
}
