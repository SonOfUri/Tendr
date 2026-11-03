import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/env.js';
import { fakeNearClient, resetNearClients } from '../src/near/client.js';
import { createMerchant, createRow, createUser, resetDb } from '../src/test/helpers.js';
import { prisma } from '../src/lib/prisma.js';
import { restoreLocalConsoleState } from './local-console-state.js';

let directory: string;
beforeEach(async () => {
  await resetDb();
  resetNearClients();
  vi.stubEnv('NEAR_FAKE_SIMULATE', '1');
  vi.stubEnv('NEAR_CLIENT_DRIVER', 'fake');
  loadEnv();
  directory = mkdtempSync(join(tmpdir(), 'tendr-console-state-'));
});
afterEach(() => {
  resetNearClients();
  vi.unstubAllEnvs();
  loadEnv();
  rmSync(directory, { recursive: true, force: true });
});

it('repairs old accounts and verified balances, then preserves new contract state and credits across restarts', async () => {
  const m = await createMerchant();
  const user = await createUser();
  const accountId = 'restore.tendr.testnet';
  const asset = 'nep141:usdc.test';
  const account = await createRow('MerchantAccount', m.id, false, {
    nearAccountId: accountId,
    status: 'active',
    signerEpoch: 3n,
  });
  const key = Buffer.alloc(32, 1).toString('base64');
  await createRow('AccountKey', m.id, false, {
    nearAccountId: accountId,
    userId: user.id,
    credentialId: null,
    publicKey: `ed25519:${key}`,
  });
  const payment = await createRow('Payment', m.id, false, { status: 'SETTLED' });
  await prisma.session.update({
    where: { id: payment.sessionId as string },
    data: { recipient: accountId, recipientType: 'INTENTS', destAsset: asset },
  });
  await prisma.settlementClaim.create({
    data: {
      id: 'claim',
      merchantId: m.id,
      livemode: false,
      paymentId: payment.id,
      txHash: 'tx',
      receiptId: 'receipt',
      eventKey: '0.0.0',
      amount: '500',
    },
  });
  const path = join(directory, 'state.bin');
  expect(await restoreLocalConsoleState(path)).toEqual({ restored: 1, checkpoint: false });
  const f = fakeNearClient(false);
  expect(await f.view(accountId, 'get_config', {})).toMatchObject({
    signer_epoch: '3',
    signers: [{ id: user.id }],
  });
  await f.call('relayer-accounts', f.scope.intentsContractId, 'deposit', {
    account_id: accountId,
    token_id: asset,
    amount: '7',
  });
  const result = await f.call('relayer-accounts', accountId, 'propose', {
    action: { add_saved_address: { id: 'saved', chain: 'near', address: 'receiver.testnet' } },
    salt: Buffer.alloc(32, 2).toString('base64'),
    approval: { signer_id: user.id, key: { ed25519: key } },
  });
  expect(result.topLevelStatus).toBe('success');
  const proposals = await f.view(accountId, 'list_proposals', {});
  resetNearClients();
  expect(await restoreLocalConsoleState(path)).toEqual({ restored: 0, checkpoint: true });
  const restored = fakeNearClient(false);
  expect(
    await restored.view(restored.scope.intentsContractId, 'mt_batch_balance_of', {
      account_id: accountId,
      token_ids: [asset],
    }),
  ).toEqual(['507']);
  expect(await restored.view(accountId, 'list_proposals', {})).toEqual(proposals);
  expect(await restored.view(accountId, 'list_saved_addresses', {})).toMatchObject([
    { id: 'saved', address: 'receiver.testnet' },
  ]);
  expect(await prisma.merchantAccount.findUnique({ where: { id: account.id } })).toMatchObject({
    status: 'active',
    signerEpoch: 3n,
  });
});

it('rejects recovery outside the development simulator', async () => {
  vi.stubEnv('NEAR_FAKE_SIMULATE', '0');
  loadEnv();
  await expect(restoreLocalConsoleState(join(directory, 'state.bin'))).rejects.toThrow(
    /development fake driver/,
  );
});
