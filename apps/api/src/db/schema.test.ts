import { Prisma } from '@prisma/client';
import {
  AccountKeyKindValues,
  EmailTokenPurposeValues,
  HeldReasonValues,
  MerchantAccountStatusValues,
  MerchantUserRoleValues,
  PaymentStatusValues,
  ProposalKindValues,
  ProposalStatusValues,
  RecoveryStatusValues,
  RefundReasonValues,
  SessionExpiredReasonValues,
  SessionStatusValues,
  SponsorshipMethodValues,
  type SessionStatus,
} from '@tendr/contracts';
import { ulid } from 'ulid';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { IDENTITY_MODELS, PER_MODE_MODELS, SHARED_MODELS } from './models.js';
import { scopedDb } from './scoped.js';
import {
  MERCHANT_OWNED_MODELS,
  createApiKey,
  createCredential,
  createMerchant,
  createRow,
  createUser,
  minimalSession,
  resetDb,
} from '../test/helpers.js';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function insertEvent(): Promise<string> {
  const id = `evt_${ulid()}`;
  await prisma.$executeRaw`INSERT INTO events (id, aggregate_type, aggregate_id, type, payload) VALUES (${id}, 'session', 'ses_x', 't', '{}')`;
  return id;
}

describe('foundation schema', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('events rows cannot be updated', async () => {
    const id = await insertEvent();
    await expect(prisma.$executeRaw`UPDATE events SET type = 'x' WHERE id = ${id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('events rows cannot be deleted', async () => {
    const id = await insertEvent();
    await expect(prisma.$executeRaw`DELETE FROM events WHERE id = ${id}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('events cannot be truncated', async () => {
    await insertEvent();
    await expect(prisma.$executeRawUnsafe('TRUNCATE events CASCADE')).rejects.toThrow(
      /append-only/,
    );
  });

  it("a payment cannot use another session's quote", async () => {
    const m = await createMerchant();
    const quoteB = await createRow('Quote', m.id, false);
    const sessionA = await createRow('Session', m.id, false);
    const payment = (quoteId: string, sessionId: string) =>
      prisma.payment.create({
        data: {
          id: `pay_${ulid()}`,
          merchantId: m.id,
          livemode: false,
          sessionId,
          quoteId,
          amountReceived: '1',
        },
      });
    await expect(payment(quoteB.id, sessionA.id)).rejects.toThrow(/Foreign key constraint/);
    await expect(payment(quoteB.id, quoteB.sessionId as string)).resolves.toMatchObject({
      quoteId: quoteB.id,
    });
  });

  it('sessions.external_ref is unique per merchant and mode', async () => {
    const m = await createMerchant();
    await prisma.session.create({
      data: minimalSession({ merchantId: m.id, livemode: false, externalRef: 'order-1' }),
    });
    const dup = prisma.session.create({
      data: minimalSession({ merchantId: m.id, livemode: false, externalRef: 'order-1' }),
    });
    await expect(dup).rejects.toSatisfy(isUniqueViolation);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: m.id, livemode: true, externalRef: 'order-1' }),
      }),
    ).resolves.toMatchObject({ externalRef: 'order-1', livemode: true });
  });

  it("a session cannot reference another merchant's theme or payment link", async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const themeB = await createRow('CheckoutTheme', b.id, false);
    const linkB = await createRow('PaymentLink', b.id, false);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: a.id, livemode: false, themeId: themeB.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: a.id, livemode: false, paymentLinkId: linkB.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
  });

  it('only one default theme per merchant', async () => {
    const m = await createMerchant();
    const other = await createMerchant();
    await createRow('CheckoutTheme', m.id, false, { isDefault: true });
    await expect(createRow('CheckoutTheme', m.id, false, { isDefault: true })).rejects.toSatisfy(
      isUniqueViolation,
    );
    await expect(createRow('CheckoutTheme', m.id, false, { isDefault: false })).resolves.toBeTruthy();
    await expect(
      createRow('CheckoutTheme', other.id, false, { isDefault: true }),
    ).resolves.toBeTruthy();
  });

  it('theme asset may exist without a theme', async () => {
    const m = await createMerchant();
    const asset = await createRow('ThemeAsset', m.id, false);
    expect(asset.themeId).toBeNull();
    expect(asset.key).toBe(`assets/${asset.id}`);
  });

  it('product_images unique per merchant and url hash', async () => {
    const m = await createMerchant();
    const other = await createMerchant();
    await createRow('ProductImage', m.id, false, { urlHash: 'h1' });
    await expect(createRow('ProductImage', m.id, false, { urlHash: 'h1' })).rejects.toSatisfy(
      isUniqueViolation,
    );
    await expect(createRow('ProductImage', other.id, false, { urlHash: 'h1' })).resolves.toBeTruthy();
  });

  it('cross-merchant session theme still rejected', async () => {
    const a = await createMerchant();
    const b = await createMerchant();
    const themeB = await createRow('CheckoutTheme', b.id, false);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: a.id, livemode: false, themeId: themeB.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
  });

  it('a live session cannot reference a test-mode payment link', async () => {
    const m = await createMerchant();
    const testLink = await createRow('PaymentLink', m.id, false);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: m.id, livemode: true, paymentLinkId: testLink.id }),
      }),
    ).rejects.toThrow(/Foreign key constraint/);
    await expect(
      prisma.session.create({
        data: minimalSession({ merchantId: m.id, livemode: false, paymentLinkId: testLink.id }),
      }),
    ).resolves.toMatchObject({ paymentLinkId: testLink.id });
  });

  it('payment link slugs are unique per merchant and mode', async () => {
    const m = await createMerchant();
    await createRow('PaymentLink', m.id, false, { slug: 'classic-tote' });
    await createRow('PaymentLink', m.id, true, { slug: 'classic-tote' });
    await expect(createRow('PaymentLink', m.id, false, { slug: 'classic-tote' })).rejects.toSatisfy(
      isUniqueViolation,
    );
  });

  it('payment_links has no dest_asset column', async () => {
    const cols = await prisma.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_name='payment_links'`;
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('dest_asset');
    expect(names).not.toContain('dest_chain');
    expect(names).toEqual(expect.arrayContaining(['description', 'min_amount', 'note_mode', 'fee_payer', 'archived_at']));
  });

  it('sessions.payer_note is varchar(280)', async () => {
    const rows = await prisma.$queryRaw<
      { data_type: string; character_maximum_length: number }[]
    >`SELECT data_type, character_maximum_length FROM information_schema.columns WHERE table_name='sessions' AND column_name='payer_note'`;
    expect(rows).toEqual([{ data_type: 'character varying', character_maximum_length: 280 }]);
  });

  it('no column stores private keys', async () => {
    const cols = await prisma.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_schema='public'`;
    expect(
      cols.map((c) => c.column_name).filter((c) => /private|secret_key|mnemonic|seed/.test(c)),
    ).toEqual([]);
  });

  it('createRow builds a valid row for every merchant-owned model in both modes', async () => {
    const m = await createMerchant();
    for (const model of MERCHANT_OWNED_MODELS) {
      for (const livemode of [false, true]) {
        const row = await createRow(model, m.id, livemode);
        expect(row.id, model).toMatch(/^[a-z]+_[0-9A-Z]{26}$/);
        expect(row.merchantId, model).toBe(m.id);
      }
    }
  });

  it('createApiKey stores a sha256 hash and a mode-specific prefix', async () => {
    const m = await createMerchant();
    const live = await createApiKey(m.id, { livemode: true });
    expect(live.raw.startsWith('tdr_live_')).toBe(true);
    expect(live.record.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(live.record.livemode).toBe(true);
    const pk = await createApiKey(m.id, { livemode: false, kind: 'publishable' });
    expect(pk.raw.startsWith('tdr_pk_test_')).toBe(true);
    expect(pk.record.kind).toBe('publishable');
  });

  describe('merchant accounts', () => {
    it('Postgres enums match the @tendr/contracts value lists', () => {
      const values = (name: string) =>
        Prisma.dmmf.datamodel.enums.find((e) => e.name === name)?.values.map((v) => v.name);
      expect(values('ProposalKind')).toEqual([...ProposalKindValues]);
      expect(values('SponsorshipMethod')).toEqual([...SponsorshipMethodValues]);
      expect(values('ProposalStatus')).toEqual([...ProposalStatusValues]);
      expect(values('MerchantAccountStatus')).toEqual([...MerchantAccountStatusValues]);
      expect(values('RecoveryStatus')).toEqual([...RecoveryStatusValues]);
      expect(values('EmailTokenPurpose')).toEqual([...EmailTokenPurposeValues]);
      expect(values('AccountKeyKind')).toEqual([...AccountKeyKindValues]);
      expect(values('MerchantUserRole')).toEqual([...MerchantUserRoleValues]);
    });

    it('lists the new tables by tenancy', () => {
      expect(PER_MODE_MODELS).toEqual(
        expect.arrayContaining([
          'AccountKey',
          'MerchantAccount',
          'AccountProposal',
          'AccountApproval',
          'RecoveryRequest',
        ]),
      );
      expect(SHARED_MODELS).toEqual(expect.arrayContaining(['MerchantUser', 'MerchantInvite']));
      expect(SHARED_MODELS).not.toContain('AccountKey');
      expect(IDENTITY_MODELS).toEqual([
        'User',
        'WebauthnCredential',
        'DashboardSession',
        'EmailToken',
        'WebauthnChallenge',
      ]);
    });

    it('a person has one membership per merchant', async () => {
      const m = await createMerchant();
      const user = await createUser();
      await createRow('MerchantUser', m.id, false, { userId: user.id });
      await expect(
        createRow('MerchantUser', m.id, false, { userId: user.id, role: 'viewer' }),
      ).rejects.toSatisfy(isUniqueViolation);
      const other = await createMerchant();
      await expect(
        createRow('MerchantUser', other.id, false, { userId: user.id }),
      ).resolves.toMatchObject({
        userId: user.id,
      });
    });

    it('users.email is unique and stored lower-cased', async () => {
      await createUser({ email: 'ada@example.com' });
      await expect(createUser({ email: 'ada@example.com' })).rejects.toSatisfy(isUniqueViolation);
      await expect(createUser({ email: 'Grace@Example.com' })).rejects.toThrow(
        /users_email_lowercase/,
      );
    });

    it('one merchant account per merchant and mode', async () => {
      const m = await createMerchant();
      await createRow('MerchantAccount', m.id, false);
      await createRow('MerchantAccount', m.id, true);
      await expect(createRow('MerchantAccount', m.id, false)).rejects.toSatisfy(isUniqueViolation);
    });

    it("a proposal cannot reference another merchant's or the other mode's account", async () => {
      const a = await createMerchant();
      const b = await createMerchant();
      const accountB = await createRow('MerchantAccount', b.id, false);
      const testAccountA = await createRow('MerchantAccount', a.id, false);
      await expect(
        createRow('AccountProposal', a.id, false, { accountId: accountB.id }),
      ).rejects.toThrow(/Foreign key constraint/);
      await expect(
        createRow('AccountProposal', a.id, true, { accountId: testAccountA.id }),
      ).rejects.toThrow(/Foreign key constraint/);
    });

    it('onchain proposal ids are unique per account', async () => {
      const m = await createMerchant();
      const first = await createRow('AccountProposal', m.id, false);
      await expect(
        createRow('AccountProposal', m.id, false, { onchainId: first.onchainId }),
      ).rejects.toSatisfy(isUniqueViolation);
      await expect(
        createRow('AccountProposal', m.id, true, { onchainId: first.onchainId }),
      ).resolves.toMatchObject({ onchainId: first.onchainId });
    });

    it("an approval cannot reference another merchant's or the other mode's proposal", async () => {
      const a = await createMerchant();
      const b = await createMerchant();
      const proposalB = await createRow('AccountProposal', b.id, false);
      const testProposalA = await createRow('AccountProposal', a.id, false);
      await expect(
        createRow('AccountApproval', a.id, false, { proposalId: proposalB.id }),
      ).rejects.toThrow(/Foreign key constraint/);
      await expect(
        createRow('AccountApproval', a.id, true, { proposalId: testProposalA.id }),
      ).rejects.toThrow(/Foreign key constraint/);
      await expect(
        createRow('AccountApproval', a.id, false, { proposalId: testProposalA.id }),
      ).resolves.toMatchObject({ proposalId: testProposalA.id });
    });

    it("an approval's passkey must belong to the approving person", async () => {
      const m = await createMerchant();
      const alice = await createUser();
      const bob = await createUser();
      const bobKey = await createCredential(bob.id);
      await expect(
        createRow('AccountApproval', m.id, false, { userId: alice.id, credentialId: bobKey.id }),
      ).rejects.toThrow(/Foreign key constraint/);
    });

    it('a person approves a proposal once', async () => {
      const m = await createMerchant();
      const first = await createRow('AccountApproval', m.id, false);
      const again = createRow('AccountApproval', m.id, false, {
        proposalId: first.proposalId,
        userId: first.userId,
        credentialId: first.credentialId,
        signerEpoch: 1n,
      });
      await expect(again).rejects.toSatisfy(isUniqueViolation);
    });

    it("a recovery request cannot reference another merchant's account", async () => {
      const a = await createMerchant();
      const b = await createMerchant();
      const accountB = await createRow('MerchantAccount', b.id, true);
      await expect(
        createRow('RecoveryRequest', a.id, true, { accountId: accountB.id }),
      ).rejects.toThrow(/Foreign key constraint/);
    });

    it('stores a passkey public key as the contract SignerKey JSON', async () => {
      const user = await createUser();
      const p256 = Buffer.alloc(33, 2).toString('base64');
      const cred = await createCredential(user.id, { publicKey: { p256 } });
      expect(cred.publicKey).toEqual({ p256 });
      expect(cred.signCount).toBe(0n);
    });

    it('account keys accept the recovery kind with no person', async () => {
      const m = await createMerchant();
      await expect(
        createRow('AccountKey', m.id, true, { kind: 'recovery', userId: null }),
      ).resolves.toMatchObject({ kind: 'recovery', userId: null, livemode: true });
    });

    it("an account key's passkey must belong to its person, who must be named", async () => {
      const m = await createMerchant();
      const alice = await createUser();
      const bob = await createUser();
      const bobKey = await createCredential(bob.id);
      await expect(
        createRow('AccountKey', m.id, true, { userId: alice.id, credentialId: bobKey.id }),
      ).rejects.toThrow(/Foreign key constraint/);
      await expect(
        createRow('AccountKey', m.id, true, { userId: null, credentialId: bobKey.id }),
      ).rejects.toThrow(/account_keys_credential_has_user/);
      await expect(
        createRow('AccountKey', m.id, true, { userId: bob.id, credentialId: bobKey.id }),
      ).resolves.toMatchObject({ credentialId: bobKey.id });
    });
  });

  describe('checkout core', () => {
    it('Postgres enums match the @tendr/contracts value lists', () => {
      const values = (name: string) =>
        Prisma.dmmf.datamodel.enums.find((e) => e.name === name)?.values.map((v) => v.name);
      expect(values('SessionStatus')).toEqual([...SessionStatusValues]);
      expect(values('PaymentStatus')).toEqual([...PaymentStatusValues]);
      expect(values('RefundReason')).toEqual([...RefundReasonValues]);
      expect(values('HeldReason')).toEqual([...HeldReasonValues]);
      expect(values('SessionExpiredReason')).toEqual([...SessionExpiredReasonValues]);
    });

    it('external_ref is unique only among pending, processing, screening and settled sessions', async () => {
      const m = await createMerchant();
      const session = (status: SessionStatus, livemode = false) =>
        prisma.session.create({
          data: minimalSession({ merchantId: m.id, livemode, externalRef: 'order-9', status }),
        });
      for (const status of ['EXPIRED', 'LATE_DEPOSIT', 'HELD', 'REFUNDED'] as const) {
        await expect(session(status)).resolves.toMatchObject({ status });
      }
      const live = await session('PENDING_DEPOSIT');
      for (const status of [
        'PENDING_DEPOSIT',
        'PROCESSING',
        'SCREENING_PENDING',
        'SETTLED',
      ] as const) {
        await expect(session(status), status).rejects.toSatisfy(isUniqueViolation);
      }
      // The other mode has its own namespace.
      await expect(session('PENDING_DEPOSIT', true)).resolves.toMatchObject({ livemode: true });
      // Once the active session expires, the reference is free again.
      await prisma.session.update({ where: { id: live.id }, data: { status: 'EXPIRED' } });
      await expect(session('PROCESSING')).resolves.toMatchObject({ status: 'PROCESSING' });
    });

    it('sessions.customer_email is stored lower-cased', async () => {
      const m = await createMerchant();
      await expect(
        prisma.session.create({
          data: minimalSession({ merchantId: m.id, livemode: false, customerEmail: 'Ada@X.com' }),
        }),
      ).rejects.toThrow(/sessions_customer_email_lowercase/);
      await expect(
        prisma.session.create({
          data: minimalSession({ merchantId: m.id, livemode: false, customerEmail: 'ada@x.com' }),
        }),
      ).resolves.toMatchObject({ customerEmail: 'ada@x.com' });
    });

    it('new checkout columns stay within their mode', async () => {
      const m = await createMerchant();
      const testSession = await createRow('Session', m.id, false, {
        successUrl: 'https://shop.test/ok',
        cancelUrl: 'https://shop.test/cancel',
        customerEmail: 'ada@x.com',
        expiredReason: 'canceled',
      });
      const testPayment = await createRow('Payment', m.id, false, {
        senderAddress: '0xabc',
        senderChain: 'eth',
        overpaidAmount: '5',
        heldReason: 'sanctions',
        keptSmallOverpayment: true,
      });
      const testRefund = await createRow('Refund', m.id, false, { needsAddress: true });
      const live = scopedDb({ merchantId: m.id, livemode: true });
      const test = scopedDb({ merchantId: m.id, livemode: false });
      expect(await live.session.findFirst({ where: { id: testSession.id } })).toBeNull();
      expect(await live.payment.findFirst({ where: { id: testPayment.id } })).toBeNull();
      expect(await live.refund.findFirst({ where: { id: testRefund.id } })).toBeNull();
      expect(await live.session.findMany({ where: { customerEmail: 'ada@x.com' } })).toEqual([]);
      expect(await live.payment.findMany({ where: { heldReason: 'sanctions' } })).toEqual([]);
      await expect(
        test.session.findFirst({ where: { id: testSession.id } }),
      ).resolves.toMatchObject({ successUrl: 'https://shop.test/ok', expiredReason: 'canceled' });
      await expect(
        test.payment.findFirst({ where: { id: testPayment.id } }),
      ).resolves.toMatchObject({ senderAddress: '0xabc', keptSmallOverpayment: true });
    });

    it('merchant checkout defaults', async () => {
      const m = await createMerchant();
      const row = await prisma.merchant.findUniqueOrThrow({ where: { id: m.id } });
      expect(row.checkoutDomains).toEqual([]);
      expect(row.defaultFeePayer).toBe('merchant');
      expect(row.defaultGasPayer).toBe('buyer');
    });

    it("a refund cannot reference another merchant's or the other mode's proposal", async () => {
      const a = await createMerchant();
      const b = await createMerchant();
      const proposalB = await createRow('AccountProposal', b.id, false);
      const liveProposalA = await createRow('AccountProposal', a.id, true);
      const testProposalA = await createRow('AccountProposal', a.id, false);
      await expect(createRow('Refund', a.id, false, { proposalId: proposalB.id })).rejects.toThrow(
        /Foreign key constraint/,
      );
      await expect(
        createRow('Refund', a.id, false, { proposalId: liveProposalA.id }),
      ).rejects.toThrow(/Foreign key constraint/);
      await expect(
        createRow('Refund', a.id, false, { proposalId: testProposalA.id }),
      ).resolves.toMatchObject({ proposalId: testProposalA.id, needsAddress: false });
    });

    it('amounts on payments, refunds and quotes are non-negative', async () => {
      const m = await createMerchant();
      await expect(createRow('Payment', m.id, false, { overpaidAmount: '-1' })).rejects.toThrow(
        /payments_checkout_amounts_nonnegative/,
      );
      await expect(createRow('Refund', m.id, false, { amount: '-1' })).rejects.toThrow(
        /refunds_amount_nonnegative/,
      );
    });

    it('quotes record supersession and a USD value', async () => {
      const m = await createMerchant();
      const at = new Date();
      await expect(
        createRow('Quote', m.id, false, { supersededAt: at, amountInUsd: '49.123456' }),
      ).resolves.toMatchObject({ supersededAt: at });
    });
  });

  it('resetDb clears events despite the append-only trigger', async () => {
    await insertEvent();
    await resetDb();
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM events`;
    expect(rows[0]?.n).toBe(0n);
  });
});
