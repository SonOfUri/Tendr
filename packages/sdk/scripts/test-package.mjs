// Install the real packed artifact outside the monorepo, then check both JS and TS consumers.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const sdk = fileURLToPath(new URL('..', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'tendr-sdk-consumer-'));
try {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
      cwd: sdk,
      encoding: 'utf8',
    }),
  )[0];
  assert(
    packed.files.every((file) =>
      /^(package\.json|README\.md|LICENSE|dist\/|examples\/)/.test(file.path),
    ),
  );
  assert(!packed.files.some((file) => /\.test\.|\.env|keyvault|node_modules/.test(file.path)));
  await writeFile(join(dir, 'package.json'), '{"private":true}');
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      join(dir, packed.filename),
    ],
    { cwd: dir, stdio: 'pipe' },
  );
  const pkg = JSON.parse(await readFile(join(dir, 'node_modules/tendr-sdk/package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  assert.equal(pkg.license, 'MIT');
  assert.notEqual(pkg.private, true);
  assert(packed.files.some((file) => file.path === 'LICENSE'));
  assert(
    (await readFile(join(dir, 'node_modules/tendr-sdk/LICENSE'), 'utf8')).startsWith('MIT License'),
  );
  assert.deepEqual(await readdir(join(dir, 'node_modules')), ['.package-lock.json', 'tendr-sdk']);
  for (const kind of ['esm', 'cjs']) {
    const code =
      (kind === 'esm'
        ? `import { TendrClient } from 'tendr-sdk'; import { constructWebhookEvent, signWebhookPayload } from 'tendr-sdk/webhook';`
        : `const { TendrClient } = require('tendr-sdk'); const { constructWebhookEvent, signWebhookPayload } = require('tendr-sdk/webhook');`) +
      `\n(async () => {
        const client = new TendrClient({ apiKey: 'tdr_test_package_fixture', fetch: async () => Response.json({ merchantId: 'mer_1' }) });
        if ((await client.ping()).merchantId !== 'mer_1') throw Error('Request failed');
        const payload = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', created: 1, livemode: false, data: {} });
        const { header } = signWebhookPayload({ payload, secret: 'whsec_fixture' });
        if (constructWebhookEvent({ payload, secret: 'whsec_fixture', signatureHeader: header }).id !== 'evt_1') throw Error('Webhook failed');
      })().catch(e => { console.error(e); process.exitCode = 1; });`;
    const file = join(dir, `consumer.${kind === 'esm' ? 'mjs' : 'cjs'}`);
    await writeFile(file, code);
    execFileSync(process.execPath, [file], { cwd: dir, stdio: 'inherit' });
  }
  const types = `import { TendrClient, type CheckoutSession, type RefundCreateInput } from 'tendr-sdk';
    import { constructWebhookEvent } from 'tendr-sdk/webhook';
    const client = new TendrClient({ apiKey: 'tdr_test_fixture' });
    async function check() {
      const created = await client.checkoutSessions.create({ amount: '1.00', amount_currency: 'USD', external_ref: 'o1', success_url: 'https://shop.example/success', cancel_url: 'https://shop.example/cancel' });
      const url: string = created.url;
      const session: CheckoutSession = await client.checkoutSessions.retrieve(created.id);
      // @ts-expect-error Retrieval does not expose the creation secret.
      session.client_secret;
      // @ts-expect-error Monetary values must be strings.
      const invalid: RefundCreateInput = { payment: 'pay_1', amount: 1, external_ref: 'r1' };
      // @ts-expect-error A refund cannot name both a session and a payment.
      const ambiguous: RefundCreateInput = { payment: 'pay_1', session: 'ses_1', amount: '1.00', external_ref: 'r1' };
      // @ts-expect-error PATCH does not participate in POST idempotency replay.
      client.paymentLinks.update('plink_1', { status: 'inactive' }, { idempotencyKey: 'x' });
      return [url, constructWebhookEvent, invalid, ambiguous];
    }
    void check;`;
  for (const extension of ['mts', 'cts']) await writeFile(join(dir, `types.${extension}`), types);
  await cp(join(sdk, 'examples'), join(dir, 'examples'), { recursive: true });
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        lib: ['ES2022', 'DOM'],
        types: [],
      },
      include: ['types.mts', 'types.cts', 'examples/*.ts'],
    }),
  );
  execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')],
    { cwd: dir, stdio: 'inherit' },
  );
  console.log(
    `Packed ${packed.filename}: standalone ESM, CommonJS, both declaration entry points, and examples passed (${packed.size} bytes).`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
