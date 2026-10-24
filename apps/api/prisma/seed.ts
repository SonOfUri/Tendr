// Local demo data. Idempotent on `merchants.name = 'Demo Merchant'`:
//
//   npm run db:seed
//
// Creates the Demo Merchant with an owner user, secret + publishable keys for test and live
// mode (raw keys are printed once and never stored), a test-mode settlement config, the
// default published checkout theme and a fee plan. A live-mode settlement config is created
// only when SEED_PAYOUT_ADDRESS holds a valid, non-zero EVM address; live payments stay
// disabled until one exists. A zero address is refused.
//
// Merchant creation uses the unscoped client (there is no tenant to scope to yet); every
// merchant-owned row goes through a client scoped to the merchant and mode.
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { ALL_SCOPES } from '@tendr/contracts';
import { scopedDb } from '../src/db/scoped.js';
import { generateApiKey } from '../src/lib/crypto.js';
import { newId } from '../src/lib/ids.js';
import { loadDotenvFile } from '../src/lib/load-dotenv.js';
import { prisma } from '../src/lib/prisma.js';

export const DEMO_MERCHANT_NAME = 'Demo Merchant';
export const DEMO_MERCHANT_SLUG = 'demo-merchant';
export const DEMO_OWNER_EMAIL = 'owner@demo.tendr.local';

/** USDC on Base, as a NEAR Intents asset id. Placeholder until settlement is built. */
const USDC_BASE_ASSET_ID = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const USDC_BASE_CHAIN = 'base';
/** Test mode moves no funds, so any well-formed address will do. Never used in live mode. */
const TEST_PAYOUT_ADDRESS = '0x0000000000000000000000000000000000000001';

const KEY_SPECS = [
  { kind: 'secret', livemode: false, label: 'Secret test key' },
  { kind: 'secret', livemode: true, label: 'Secret live key' },
  { kind: 'publishable', livemode: false, label: 'Publishable test key' },
  { kind: 'publishable', livemode: true, label: 'Publishable live key' },
] as const;

/**
 * Whether `address` is a 20-byte hex EVM address. All-lowercase and all-uppercase forms are
 * accepted as-is; mixed case must carry a valid EIP-55 checksum.
 */
export function isValidEvmAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex.toLowerCase())));
  return [...hex].every((c, i) =>
    /[0-9]/.test(c)
      ? true
      : parseInt(hash[i]!, 16) >= 8
        ? c === c.toUpperCase()
        : c === c.toLowerCase(),
  );
}

/** The live payout address from SEED_PAYOUT_ADDRESS, or null when unset. Throws when invalid. */
export function livePayoutAddress(value: string | undefined): string | null {
  const address = value?.trim();
  if (!address) return null;
  if (!isValidEvmAddress(address)) {
    throw new Error(`SEED_PAYOUT_ADDRESS is not a valid EVM address: ${address}`);
  }
  if (/^0x0{40}$/i.test(address)) {
    throw new Error('SEED_PAYOUT_ADDRESS must not be the zero address');
  }
  return address;
}

export type SeedOptions = {
  /** Defaults to `process.env.SEED_PAYOUT_ADDRESS`. */
  payoutAddress?: string;
  /** Output sink; defaults to `console.log`. */
  out?: (line: string) => void;
};

export type SeedResult = {
  merchantId: string;
  alreadySeeded: boolean;
  /** Raw keys created by this run, by label. Empty when the keys already existed. */
  rawKeys: Record<string, string>;
  liveSettlementConfigured: boolean;
};

export async function seed(opts: SeedOptions = {}): Promise<SeedResult> {
  const out = opts.out ?? ((line: string) => console.log(line));
  // Validate before writing anything: a bad address must not leave a half-seeded merchant.
  const payoutAddress = livePayoutAddress(
    'payoutAddress' in opts ? opts.payoutAddress : process.env.SEED_PAYOUT_ADDRESS,
  );

  const existing = await prisma.merchant.findFirst({ where: { name: DEMO_MERCHANT_NAME } });
  const merchant =
    existing ??
    (await prisma.merchant.create({
      data: {
        id: newId('mer'),
        name: DEMO_MERCHANT_NAME,
        slug: DEMO_MERCHANT_SLUG,
        kind: 'merchant',
        status: 'active',
      },
    }));
  const merchantId = merchant.id;
  const testDb = scopedDb({ merchantId, livemode: false });
  const liveDb = scopedDb({ merchantId, livemode: true });
  const dbFor = (livemode: boolean) => (livemode ? liveDb : testDb);

  // Each step only fills in what is missing, so a run interrupted halfway completes on rerun.
  await testDb.merchantUser.upsert({
    where: { merchantId_email: { merchantId, email: DEMO_OWNER_EMAIL } },
    create: { id: newId('usr'), merchantId, email: DEMO_OWNER_EMAIL, role: 'owner' },
    update: {},
  });

  const rawKeys: Record<string, string> = {};
  for (const spec of KEY_SPECS) {
    const db = dbFor(spec.livemode);
    const has = await db.apiKey.count({ where: { kind: spec.kind, revokedAt: null } });
    if (has > 0) continue;
    const key = generateApiKey(spec.kind, spec.livemode);
    await db.apiKey.create({
      data: {
        id: newId('key'),
        merchantId,
        livemode: spec.livemode,
        name: spec.label,
        kind: spec.kind,
        keyPrefix: key.prefix,
        keyHash: key.hash,
        scopes: [...ALL_SCOPES],
      },
    });
    rawKeys[spec.label] = key.raw;
  }

  if ((await testDb.settlementConfig.count()) === 0) {
    await testDb.settlementConfig.create({
      data: {
        id: newId('stc'),
        merchantId,
        livemode: false,
        destAssetId: USDC_BASE_ASSET_ID,
        destChain: USDC_BASE_CHAIN,
        payoutMode: 'wallet',
        payoutAddress: TEST_PAYOUT_ADDRESS,
        isDefault: true,
      },
    });
  }

  let liveSettlementConfigured = (await liveDb.settlementConfig.count()) > 0;
  if (!liveSettlementConfigured && payoutAddress) {
    await liveDb.settlementConfig.create({
      data: {
        id: newId('stc'),
        merchantId,
        livemode: true,
        destAssetId: USDC_BASE_ASSET_ID,
        destChain: USDC_BASE_CHAIN,
        payoutMode: 'wallet',
        payoutAddress,
        isDefault: true,
      },
    });
    liveSettlementConfigured = true;
  }

  if ((await testDb.checkoutTheme.count({ where: { isDefault: true } })) === 0) {
    await testDb.checkoutTheme.create({
      data: {
        id: newId('thm'),
        merchantId,
        name: 'Default',
        isDefault: true,
        status: 'published',
        displayName: DEMO_MERCHANT_NAME,
        accent: '#4f46e5',
        background: '#ffffff',
        text: '#111827',
        mode: 'auto',
        font: 'Inter',
        cornerRadius: 12,
        layout: 'modal',
        blocks: [],
        schemaVersion: 1,
        tokenPreferences: {},
      },
    });
  }

  // fee_bps 50 is a placeholder; real pricing comes with the checkout project.
  if ((await testDb.feePlan.count()) === 0) {
    await testDb.feePlan.create({
      data: {
        id: newId('fplan'),
        merchantId,
        feeBps: 50,
        defaultFeePayer: 'merchant',
        volumeTiers: [],
        effectiveFrom: new Date(),
      },
    });
  }

  out(
    existing
      ? `${DEMO_MERCHANT_NAME} already seeded (${merchantId}).`
      : `Seeded ${DEMO_MERCHANT_NAME} (${merchantId}).`,
  );
  const labels = Object.keys(rawKeys);
  if (labels.length > 0) {
    out('API keys (shown once, store them now):');
    for (const label of labels) out(`  ${label.padEnd(22)} ${rawKeys[label]}`);
  }
  out(
    liveSettlementConfigured
      ? 'Live settlement config present.'
      : 'Live payments are disabled until a live settlement config exists: set SEED_PAYOUT_ADDRESS to a payout address and rerun.',
  );

  return { merchantId, alreadySeeded: existing !== null, rawKeys, liveSettlementConfigured };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  loadDotenvFile(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../.env'));
  seed()
    .catch((err: unknown) => {
      console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
