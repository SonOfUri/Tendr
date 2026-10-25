/**
 * MANUAL. Publishes the merchant-account contract to TESTNET. Never run by CI.
 *
 *   npm run onchain:publish:testnet --workspace=@tendr/api -- --network testnet
 *
 * What it does, in order (it prints the plan first):
 *   1. builds onchain/ in Docker with onchain/scripts/build.sh: merchant-account WITH the
 *      `testnet-admin` feature, and mock-intents (skip with --skip-build to reuse the last build);
 *   2. publishes the testnet-admin merchant-account build as a global contract (NEP-591, by code
 *      hash) from the publisher account;
 *   3. creates `intents-mock.tendr.testnet` (or redeploys it) with the mock-intents contract;
 *   4. prints the code hash to put in MERCHANT_ACCOUNT_CODE_HASH_TEST;
 *   5. checks the testnet asset ids that apps/web/src/lib/asset-registry.ts lists against the real
 *      token contracts (the mock keeps balances for any token id string, so the ids are only as
 *      right as the registry).
 *
 * Refuses to run without `--network testnet`; any other network, including mainnet, is refused.
 * The publisher account must be the testnet parent account (default tendr.testnet), funded, with a
 * full-access key supplied by you:
 *
 *   NEAR_PUBLISH_PRIVATE_KEY   ed25519:<base58>   (required)
 *   NEAR_PUBLISH_ACCOUNT_ID    default tendr.testnet
 *   NEAR_RPC_URL_TEST          default https://rpc.testnet.near.org
 *   MOCK_INTENTS_ACCOUNT_ID    default intents-mock.tendr.testnet (must be a sub-account of the publisher)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAccountAction, transferAction } from '../src/near/tx.js';
import {
  NEAR,
  ScriptAccount,
  UsageError,
  addFullAccessKeyAction,
  codeHashB58,
  deployContractAction,
  deployGlobalByHashAction,
  formatNear,
  parseFlags,
} from './lib/near-script.js';

const ONCHAIN_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../onchain');
const MERCHANT_WASM = 'target/near/merchant-account/merchant-account-testnet-admin.wasm';
const MOCK_WASM = 'target/near/mock-intents/mock-intents.wasm';

/** Candidates from apps/web/src/lib/asset-registry.ts (TEST table); confirmed against testnet below. */
export const TESTNET_REGISTRY_ASSETS: readonly { id: string; symbol: string; decimals: number }[] =
  [
    { id: 'nep141:usdc.fakes.testnet', symbol: 'USDC', decimals: 6 },
    { id: 'nep141:wrap.testnet', symbol: 'wNEAR', decimals: 24 },
  ];

export interface PublishArgs {
  skipBuild: boolean;
  publisherId: string;
  mockId: string;
  rpcUrl: string;
  privateKey: string;
}

/** Parses argv and env; throws UsageError (refusal) on anything but an explicit testnet run. */
export function parsePublishArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): PublishArgs {
  const flags = parseFlags(argv, { network: 'value', 'skip-build': 'bool' });
  const network = flags.get('network');
  if (network === undefined) {
    throw new UsageError(
      'refusing to run: pass --network testnet (this script only publishes to testnet)',
    );
  }
  if (network !== 'testnet') {
    throw new UsageError(
      `refusing to run: --network must be exactly "testnet", got "${String(network)}"`,
    );
  }
  const publisherId = env.NEAR_PUBLISH_ACCOUNT_ID ?? 'tendr.testnet';
  if (!publisherId.endsWith('.testnet')) {
    throw new UsageError(`refusing to run: publisher ${publisherId} is not a .testnet account`);
  }
  const mockId = env.MOCK_INTENTS_ACCOUNT_ID ?? 'intents-mock.tendr.testnet';
  if (!mockId.endsWith(`.${publisherId}`)) {
    throw new UsageError(`${mockId} must be a sub-account of the publisher ${publisherId}`);
  }
  const rpcUrl = env.NEAR_RPC_URL_TEST ?? 'https://rpc.testnet.near.org';
  if (!/testnet|localhost|127\.0\.0\.1/.test(rpcUrl)) {
    throw new UsageError(
      `refusing to run: NEAR_RPC_URL_TEST (${rpcUrl}) does not look like testnet`,
    );
  }
  const privateKey = env.NEAR_PUBLISH_PRIVATE_KEY;
  if (!privateKey) throw new UsageError('NEAR_PUBLISH_PRIVATE_KEY (ed25519:<base58>) is not set');
  return { skipBuild: flags.has('skip-build'), publisherId, mockId, rpcUrl, privateKey };
}

function plan(a: PublishArgs): string {
  return [
    'This will, on TESTNET only:',
    `  1. ${a.skipBuild ? 'reuse the existing builds in onchain/target/near (--skip-build)' : 'build onchain/ in Docker (merchant-account --features testnet-admin, mock-intents)'}`,
    `  2. publish the testnet-admin merchant-account as a global contract from ${a.publisherId}`,
    `  3. create or redeploy ${a.mockId} with the mock-intents contract (the mock mints balances for anyone: testnet only)`,
    '  4. print MERCHANT_ACCOUNT_CODE_HASH_TEST',
    '  5. check the testnet asset ids in apps/web/src/lib/asset-registry.ts',
    `RPC: ${a.rpcUrl}`,
  ].join('\n');
}

function build(): void {
  for (const argv of [['--features', 'testnet-admin', 'merchant-account'], ['mock-intents']]) {
    const r = spawnSync(resolve(ONCHAIN_DIR, 'scripts/build.sh'), argv, {
      cwd: ONCHAIN_DIR,
      stdio: 'inherit',
    });
    if (r.status !== 0) throw new Error(`build.sh ${argv.join(' ')} failed`);
  }
}

async function ftMetadata(
  acct: ScriptAccount,
  token: string,
): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const r = await acct.transport.request<{ result: number[]; error?: string }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: token,
      method_name: 'ft_metadata',
      args_base64: Buffer.from('{}').toString('base64'),
    });
    if (r.error) return null;
    return JSON.parse(Buffer.from(r.result).toString('utf8')) as {
      symbol: string;
      decimals: number;
    };
  } catch {
    return null;
  }
}

async function run(a: PublishArgs): Promise<void> {
  console.log(plan(a));
  if (!a.skipBuild) build();

  const merchant = new Uint8Array(readFileSync(resolve(ONCHAIN_DIR, MERCHANT_WASM)));
  const mock = new Uint8Array(readFileSync(resolve(ONCHAIN_DIR, MOCK_WASM)));
  const codeHash = codeHashB58(merchant);
  console.log(`merchant-account (testnet-admin): ${merchant.length} bytes, code hash ${codeHash}`);

  const acct = ScriptAccount.open(a.publisherId, a.privateKey, a.rpcUrl);
  const balance = await acct.accountBalance(a.publisherId);
  console.log(`publisher ${a.publisherId}: ${formatNear(balance)}`);
  // Global contract storage is paid by the publisher (about 1e19 yocto per byte), plus the mock.
  const need = BigInt(merchant.length + mock.length) * 10n ** 19n * 2n + 5n * NEAR;
  if (balance < need) {
    throw new Error(`publisher needs about ${formatNear(need)} (has ${formatNear(balance)})`);
  }

  await acct.sendOk(a.publisherId, [deployGlobalByHashAction(merchant)], 'DeployGlobalContract');
  console.log(`PASS: global contract published, code hash ${codeHash}`);

  const keyAction = addFullAccessKeyAction(acct.publicKey.publicKey);
  if (await acct.accountExists(a.mockId)) {
    // Redeploy with the same key; only works if the publisher key is on the mock account.
    const keys = await acct.rpc.accessKeyList(a.mockId);
    if (!keys.includes(acct.publicKey.nearPublicKey)) {
      throw new Error(`${a.mockId} exists and the publisher key is not on it, cannot redeploy`);
    }
    const mockAcct = new ScriptAccount(a.mockId, acct.publicKey, acct.transport);
    await mockAcct.sendOk(a.mockId, [deployContractAction(mock)], 'redeploy mock-intents');
    console.log(`PASS: ${a.mockId} redeployed (state kept)`);
  } else {
    const funding = BigInt(mock.length) * 10n ** 19n + 2n * NEAR;
    await acct.sendOk(
      a.mockId,
      [createAccountAction(), transferAction(funding), keyAction, deployContractAction(mock)],
      'create mock-intents account',
    );
    console.log(`PASS: ${a.mockId} created and mock-intents deployed (${formatNear(funding)})`);
  }

  console.log('\nTestnet asset ids (asset-registry.ts) against the token contracts:');
  for (const asset of TESTNET_REGISTRY_ASSETS) {
    const token = asset.id.replace(/^nep141:/, '');
    const meta = await ftMetadata(acct, token);
    if (!meta) {
      console.log(`  FAIL: ${asset.id}: no ft_metadata on ${token}; fix asset-registry.ts`);
    } else if (meta.decimals !== asset.decimals) {
      console.log(
        `  FAIL: ${asset.id}: registry says ${asset.decimals} decimals, token says ${meta.decimals}`,
      );
    } else {
      console.log(`  PASS: ${asset.id}: ${meta.symbol}, ${meta.decimals} decimals`);
    }
  }

  console.log('\nSet in your .env (testnet):');
  console.log(`  MERCHANT_ACCOUNT_CODE_HASH_TEST=${codeHash}`);
  console.log(`  INTENTS_CONTRACT_TEST=${a.mockId}`);
  console.log('The mock accepts any token id; seed balances with its `deposit` method.');
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let args: PublishArgs;
  try {
    args = parsePublishArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`${(err as Error).message}`);
    process.exit(2);
  }
  run(args).then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`FAILED: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
