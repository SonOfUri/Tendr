# Tendr Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sandbox scaffold with the platform layer every later Tendr service builds on: the full data model, shared states, API Gateway, append-only event log with reliable dispatch, Redis/BullMQ worker, KMS-backed KeyVault and Stripe-style test mode, all working locally.

**Architecture:** One Fastify `api` process and one BullMQ `worker` process from `apps/api`, sharing a Prisma schema on Postgres 16 and Redis. Every `/v1` request resolves to a typed *principal* and reaches the database only through a data-access client scoped to that principal's `(merchantId, livemode)`. State changes go through transition functions that write an `events` row and an `event_outbox` row in the same transaction; the worker drains the outbox into BullMQ jobs. Secrets and signing keys go through a `KeyVault` interface (local fake for dev, GCP Cloud KMS for prod).

**Tech Stack:** Node 22, TypeScript (strict, NodeNext ESM), Fastify 5, Prisma 6, Postgres 16, Redis 7, BullMQ + ioredis, Zod 3, Vitest 3, `ulid`, `@noble/curves` + `@noble/hashes`, `bs58`, `@google-cloud/kms`, Terraform (written, not applied).

**Spec:** `docs/superpowers/specs/2026-10-23-foundation-design.md` — read it alongside this plan.

## Global Constraints

- Node `>=22`; ESM with `.js` import suffixes (existing `@tendr/config-typescript/base.json`, `module: NodeNext`, `noUncheckedIndexedAccess`).
- Package manager: **npm workspaces** (the repo already has `package-lock.json`, CI and README use npm). Remove the pnpm `packageManager`/`engines.pnpm` fields, `pnpm-workspace.yaml` and the pnpm-only `.npmrc` lines.
- Local Postgres stays on host port **5433**; Redis on host port **6380** (avoids clashing with a local 6379).
- No column anywhere holds a private key, a merchant full-access key, or a plaintext secret.
- A test-mode principal can never read or write a live row, and vice versa.
- Cross-merchant (and cross-mode) references are rejected by composite foreign keys, not by application code alone.
- Raw SQL is never available on scoped or read-only clients.
- EVM and Solana gas sponsorship is Pimlico; the only self-run gas key is `gas-tron`.
- No API route lets a client set a session or payment status.
- `events` rows are never updated or deleted (DB trigger enforces).
- IDs: `<prefix>_<ULID>`; prefixes in Task 5.
- On-chain amounts: `Decimal @db.Decimal(78,0)` smallest unit. USD values: `@db.Decimal(18,6)`. Prices (`sessions.amount`, `payment_links.amount`): `@db.Decimal(38,18)` in human units of `amount_currency` (`USD` or an asset id). All Decimals serialize to JSON **strings**.
- Error envelope unchanged: `{ error: { code, message, requestId, details? } }`.
- Nothing is deployed. Terraform is written and validated only; the GCP check script is run manually by the user.
- Local dev must work without any GCP credentials (`KEYVAULT_DRIVER=local`). `LocalKeyVault` throws if `NODE_ENV=production`.

## Review Focus

1. **Same `Idempotency-Key` sent with a test key and a live key of the same merchant** — must be treated as two different keys, never replay across modes. Test in Task 11.
2. **HMAC over a body with non-canonical whitespace / key order** — signature must be computed over the raw bytes received, not re-serialized JSON. Test in Task 9.
3. **Redis unavailable** — authenticated requests still succeed (rate limiter fails open and logs); worker health reports unhealthy. Tests in Tasks 10 and 13.
4. **Dispatcher crashes after enqueueing but before deleting outbox rows** — re-dispatch must not run a handler twice for the same event. Test in Task 13.
5. **Very large on-chain amounts (`10^30` smallest units)** — round-trip through Prisma and JSON exactly, as strings. Test in Task 5.

---

## File Structure

```
apps/api/
  prisma/schema.prisma                 # Task 4 (full rewrite)
  prisma/migrations/<ts>_foundation/   # Task 4 (+ hand-written trigger SQL)
  prisma/seed.ts                       # Task 14
  scripts/verify-gcp-kms.ts            # Task 7 (manual)
  scripts/jobs-failed.ts               # Task 13
  src/env.ts                           # Tasks 1, 6, 7, 10, 13 (extend)
  src/app.ts                           # Tasks 2, 8–11
  src/index.ts                         # api entry (exists)
  src/worker.ts                        # Task 13 worker entry
  src/lib/ids.ts                       # Task 5
  src/lib/serialize.ts                 # Task 5 (rewrite: decimal/date helpers only)
  src/lib/redis.ts                     # Task 10
  src/db/scoped.ts                     # Task 5 scoped + read-only clients
  src/db/models.ts                     # Task 5 per-mode vs shared model lists
  src/keyvault/types.ts                # Task 6
  src/keyvault/keys.ts                 # Task 6 named-key registry
  src/keyvault/local.ts                # Task 6
  src/keyvault/gcp.ts                  # Task 7
  src/keyvault/secp256k1.ts            # Task 6 DER → r,s,v
  src/keyvault/index.ts                # Task 6/7 factory
  src/secrets/secrets.ts               # Task 6 putSecret/getSecret
  src/gateway/principal.ts             # Task 8
  src/gateway/auth.ts                  # Task 8
  src/gateway/signing.ts               # Task 9
  src/gateway/rate-limit.ts            # Task 10
  src/gateway/idempotency.ts           # Task 11
  src/routes/health.ts                 # Task 2 (keep, trim)
  src/routes/ping.ts                   # Task 8
  src/events/record.ts                 # Task 12
  src/events/transitions.ts            # Task 12
  src/jobs/queue.ts                    # Task 13 (rewrite)
  src/jobs/handlers.ts                 # Task 13 handler registry
  src/jobs/dispatcher.ts               # Task 13
  src/test/helpers.ts                  # Task 4 (db reset, merchant/key factories)
packages/contracts/src/
  states.ts      # Task 3 session/payment states + transitions
  enums.ts       # Task 3 (rewrite) all DB enums as Zod
  refunds.ts     # Task 3 deriveRefundStatus
  auth.ts        # Task 3 principal kinds + scopes
  errors.ts      # Task 3 (extend codes)
  index.ts
infra/docker/docker-compose.yml        # Task 1 (+redis)
infra/terraform/gcp/*.tf               # Task 14
infra/terraform/railway/*.tf           # Task 14
.github/workflows/ci.yml               # Task 1
```

---

### Task 1: Tooling — npm, CI, Redis

**Files:**
- Modify: `package.json`, `.npmrc`, `.github/workflows/ci.yml`, `infra/docker/docker-compose.yml`, `.env.example`, `README.md` (quick start only)
- Delete: `pnpm-workspace.yaml`

**Interfaces:**
- Produces: `REDIS_URL` env var (`redis://localhost:6380` locally, `redis://localhost:6379` in CI).

- [ ] **Step 1:** In root `package.json` remove `packageManager` and `engines.pnpm`; keep `engines.node: ">=22.0.0"`. Delete `pnpm-workspace.yaml`. Reduce `.npmrc` to settings npm understands (drop pnpm-only keys; keep nothing if none apply).
- [ ] **Step 2:** Add a `redis` service to `infra/docker/docker-compose.yml`: image `redis:7-alpine`, container `tendr-redis`, ports `"6380:6379"`, healthcheck `redis-cli ping`, named volume.
- [ ] **Step 3:** Fix CI: remove `defaults.run.working-directory: Tendr`, change `node-version-file` to `.nvmrc` and `cache-dependency-path` to `package-lock.json`. Add a `redis:7-alpine` service on `6379` with a ping healthcheck. Replace sandbox env vars (`PAYMENT_PROVIDER`, `CHECKOUT_LIVE_ENABLED`, `WEBHOOK_SIGNING_SECRET`) with `REDIS_URL: redis://localhost:6379`, `KEYVAULT_DRIVER: local`, `LOCAL_KEYVAULT_PATH: .keyvault/ci.json`. Change the Migrate step to `npx prisma migrate deploy` (unchanged script) — it must run before Test.
- [ ] **Step 4:** Update `.env.example` with `REDIS_URL=redis://localhost:6380`, `KEYVAULT_DRIVER=local`, `LOCAL_KEYVAULT_PATH=.keyvault/local.json`, and remove the sandbox variables. Add `.keyvault/` to `.gitignore`.
- [ ] **Step 5:** Verify: `docker compose -f infra/docker/docker-compose.yml up -d && docker exec tendr-redis redis-cli ping` → `PONG`; `npm install` completes with no pnpm warnings.
- [ ] **Step 6:** Commit `chore: switch to npm workspaces, fix CI path, add Redis`.

---

### Task 2: Remove the sandbox slice

**Files:**
- Delete: `apps/api/src/routes/{checkout,payments,webhooks,openapi}.ts`, `apps/api/src/services/`, `apps/api/src/providers/`, `apps/api/src/domain/`, `apps/api/src/plugins/auth.ts`, `apps/api/src/checkout.integration.test.ts`, `apps/api/prisma/migrations/20260423120000_init/`
- Delete: `packages/contracts/src/{checkout,enums,money,pagination}.ts`, `packages/contracts/src/enums.test.ts`
- Delete: `apps/web/src/app/demo/`, `apps/web/src/app/checkout/`, `apps/web/src/app/api/`, `apps/web/src/app/dashboard/{payments,developers}/`, `apps/web/src/components/{CheckoutEngine,HostedCheckout}.tsx`, `apps/web/src/lib/tendr-server.ts`
- Delete: `apps/docs/api-reference/{create-checkout-session,retrieve-checkout-session,create-quote,retrieve-payment}.mdx`, `apps/docs/concepts/{checkout-sessions,quotes-and-expiry,payment-lifecycle,sandbox-vs-live}.mdx`, `apps/docs/integrations/{fintech,gaming}.mdx`
- Modify: `apps/api/src/app.ts`, `apps/api/src/env.ts`, `packages/contracts/src/index.ts`, `packages/sdk/src/client.ts`, `apps/web/src/app/page.tsx`, `apps/web/src/app/dashboard/page.tsx`, `apps/web/e2e/smoke.spec.ts`, `apps/docs/docs.json`
- Test: `apps/api/src/routes/health.test.ts`

**Interfaces:**
- Produces: `buildApp(): Promise<FastifyInstance>` still exported from `src/app.ts`; `GET /v1/health` returns `200 {"status":"ok"}` without auth.

- [ ] **Step 1: Write the failing test** `health.test.ts`:

```ts
it('GET /v1/health is public', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/v1/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
```

- [ ] **Step 2:** Delete the files listed. In `env.ts` remove `CHECKOUT_LIVE_ENABLED`, `PAYMENT_PROVIDER`, `NEAR_INTENTS_*`, `WEBHOOK_SIGNING_SECRET`, `DEMO_MERCHANT_API_KEY`; add `REDIS_URL: z.string().url()`. `app.ts` keeps CORS, request id, error handler and registers only `healthRoutes` (rate limiting is re-added in Task 10). Health route path becomes `/v1/health`.
- [ ] **Step 3:** `packages/contracts/src/index.ts` exports only `errors.js` for now. `packages/sdk/src/client.ts`: remove all endpoint methods, keep constructor and private `request`/`requestRaw` (endpoint methods return in project 2); keep `webhook.ts` and its test.
- [ ] **Step 4:** Web: landing page keeps hero copy but the "Explore the demo" link is removed; dashboard page becomes a placeholder ("Dashboard — coming soon") with no links to deleted pages. Smoke test keeps only `landing page renders`, asserting the `/One checkout/i` heading. Docs: remove deleted pages from `docs.json` navigation; `concepts/idempotency`, `security/*`, `api-reference/overview`, `api-reference/webhooks` stay.
- [ ] **Step 5:** Run `npm run typecheck && npm run build && npm test --workspace=@tendr/api -- health` → all pass. (Prisma client is regenerated in Task 4; until then the old generated client may linger — `app.ts` must not import it.)
- [ ] **Step 6:** Commit `refactor!: remove sandbox checkout slice`.

---

### Task 3: Shared states, enums, scopes — `@tendr/contracts`

**Files:**
- Create: `packages/contracts/src/{states,enums,refunds,auth}.ts`, `packages/contracts/src/states.test.ts`, `packages/contracts/src/refunds.test.ts`
- Modify: `packages/contracts/src/errors.ts`, `packages/contracts/src/index.ts`

**Interfaces:**
- Produces:
  - `SessionStatus` = `'PENDING_DEPOSIT'|'PROCESSING'|'SETTLED'|'REFUNDED'|'EXPIRED'|'LATE_DEPOSIT'`; `SessionStatusSchema`; `SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]>`; `canTransitionSession(from, to): boolean`; `isTerminalSession(s): boolean`.
  - `PaymentStatus` = `'DETECTED'|'PROCESSING'|'SETTLED'|'REFUNDING'|'REFUNDED'`; `PAYMENT_TRANSITIONS`; `canTransitionPayment(from, to)`.
  - `RefundStatus` = `'none'|'in_progress'|'refunded'`; `deriveRefundStatus(sessionStatus: SessionStatus, payments: {id: string; status: PaymentStatus; isLate: boolean}[], refunds: {paymentId: string; reason: RefundReason; createdAt: Date}[]): { refundStatus: RefundStatus; refundReason: RefundReason | null; lateRefundStatus: RefundStatus }`.
  - Zod enums (const arrays + schemas) for every DB enum in Appendix A, named `<Name>Values` / `<Name>Schema` (e.g. `MerchantKindValues = ['merchant','integrator'] as const`).
  - `PrincipalKind` = `'secret_key'|'publishable_key'|'session_client'|'dashboard_user'|'agent'`.
  - `Scope` values: `'sessions:read','sessions:write','payments:read','refunds:write','payment_links:read','payment_links:write','webhooks:read','webhooks:write','events:read'`; `ALL_SCOPES`.
  - Error codes add `'FORBIDDEN'` (exists), `'IDEMPOTENCY_IN_PROGRESS'`, `'SIGNATURE_INVALID'`.

- [ ] **Step 1: Write failing tests** `states.test.ts`:

```ts
it.each([
  ['PENDING_DEPOSIT','PROCESSING'],['PENDING_DEPOSIT','EXPIRED'],
  ['PROCESSING','SETTLED'],['PROCESSING','REFUNDED'],
  ['EXPIRED','LATE_DEPOSIT'],['LATE_DEPOSIT','REFUNDED'],
])('allows %s → %s', (f, t) => expect(canTransitionSession(f, t)).toBe(true));

it.each([
  ['SETTLED','REFUNDED'],['SETTLED','LATE_DEPOSIT'],['REFUNDED','PENDING_DEPOSIT'],
  ['EXPIRED','PENDING_DEPOSIT'],['PENDING_DEPOSIT','SETTLED'],
])('rejects %s → %s', (f, t) => expect(canTransitionSession(f, t)).toBe(false));

it('terminal states', () => {
  expect(isTerminalSession('SETTLED')).toBe(true);
  expect(isTerminalSession('REFUNDED')).toBe(true);
  expect(isTerminalSession('EXPIRED')).toBe(false);
});

it.each([
  ['DETECTED','PROCESSING'],['DETECTED','REFUNDING'],['PROCESSING','SETTLED'],
  ['PROCESSING','REFUNDING'],['REFUNDING','REFUNDED'],
])('payment allows %s → %s', (f, t) => expect(canTransitionPayment(f, t)).toBe(true));
it('payment SETTLED is terminal', () => expect(canTransitionPayment('SETTLED','REFUNDING')).toBe(false));
```

`refunds.test.ts`:

```ts
const p = (id: string, status: PaymentStatus, isLate = false) => ({ id, status, isLate });
it('none when no refunding/refunded payments', () =>
  expect(deriveRefundStatus('SETTLED', [p('a','SETTLED')], []))
    .toEqual({ refundStatus:'none', refundReason:null, lateRefundStatus:'none' }));
it('in_progress wins over refunded; reason from latest refund', () =>
  expect(deriveRefundStatus('PROCESSING', [p('a','REFUNDED'), p('b','REFUNDING')],
    [{paymentId:'a',reason:'failed',createdAt:new Date(1)},{paymentId:'b',reason:'underpaid',createdAt:new Date(2)}]))
  .toMatchObject({ refundStatus:'in_progress', refundReason:'underpaid' }));
it('late refund on a SETTLED session goes only to lateRefundStatus', () =>
  expect(deriveRefundStatus('SETTLED', [p('a','SETTLED'), p('b','REFUNDED', true)],
    [{paymentId:'b',reason:'late',createdAt:new Date(1)}]))
  .toEqual({ refundStatus:'none', refundReason:null, lateRefundStatus:'refunded' }));
it('late deposit on an expired session counts as the session refund', () =>
  expect(deriveRefundStatus('LATE_DEPOSIT', [p('a','REFUNDING', true)],
    [{paymentId:'a',reason:'expired',createdAt:new Date(1)}]))
  .toMatchObject({ refundStatus:'in_progress', refundReason:'expired', lateRefundStatus:'none' }));
```

- [ ] **Step 2:** Run `npm test --workspace=@tendr/contracts` → FAIL (modules missing).
- [ ] **Step 3:** Implement. Transition tables exactly as spec §2: session `PENDING_DEPOSIT→[PROCESSING,EXPIRED]`, `PROCESSING→[SETTLED,REFUNDED]`, `EXPIRED→[LATE_DEPOSIT]`, `LATE_DEPOSIT→[REFUNDED]`, `SETTLED→[]`, `REFUNDED→[]`. Payment `DETECTED→[PROCESSING,REFUNDING]`, `PROCESSING→[SETTLED,REFUNDING]`, `REFUNDING→[REFUNDED]`, `SETTLED→[]`, `REFUNDED→[]`. `deriveRefundStatus`: split payments into *session* payments and *late-on-settled* payments — a payment is late-on-settled when `isLate` and `sessionStatus === 'SETTLED'`; all others are session payments. For each group: any `REFUNDING` → `in_progress`; else any `REFUNDED` → `refunded`; else `none`. `refundReason` = reason of the most recent refund (by `createdAt`) belonging to a session payment, `null` if none.
- [ ] **Step 4:** Run tests → PASS. `npm run build --workspace=@tendr/contracts`.
- [ ] **Step 5:** Commit `feat(contracts): session/payment state machines, enums, scopes`.

---

### Task 4: Prisma schema, migration, append-only trigger

**Files:**
- Rewrite: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_foundation/migration.sql` (generated, then appended)
- Create: `apps/api/src/test/helpers.ts`, `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Produces: Prisma models named in PascalCase singular with `@@map` to the Appendix A table names (`Merchant`→`merchants`, `Session`→`sessions`, `PayoutAllowlistEntry`→`payout_allowlist`, `Event`→`events`, `EventOutbox`→`event_outbox`, `Secret`→`secrets`, `IdempotencyKey`→`idempotency_keys`, etc.); fields camelCase with `@map` snake_case. Prisma enums use the values in Appendix A.
- Produces (test helpers): `resetDb(): Promise<void>` (TRUNCATE all tables except `events` … CASCADE; `events` cleared via `SET session_replication_role = replica` then `DELETE` — test-only), `createMerchant(overrides?) : Promise<Merchant>`, `createApiKey(merchantId, opts: {livemode: boolean; kind?: 'secret'|'publishable'; scopes?: Scope[]; signingRequired?: boolean}) : Promise<{ raw: string; record: ApiKey }>`.

- [ ] **Step 1: Write failing test** `schema.test.ts`:

```ts
it('events rows cannot be updated', async () => {
  const id = newId('evt');
  await prisma.$executeRaw`INSERT INTO events (id, aggregate_type, aggregate_id, type, payload) VALUES (${id}, 'session', 'ses_x', 't', '{}')`;
  await expect(prisma.$executeRaw`UPDATE events SET type = 'x' WHERE id = ${id}`).rejects.toThrow(/append-only/);
});
it('events rows cannot be deleted', async () => { /* same insert */
  await expect(prisma.$executeRaw`DELETE FROM events WHERE id = ${id}`).rejects.toThrow(/append-only/);
});
it('sessions.external_ref is unique per merchant and mode', async () => {
  // create two sessions same merchant, livemode=false, externalRef 'order-1' → second rejects P2002
  // a third with livemode=true and 'order-1' succeeds
});
it('a session cannot reference another merchant\'s theme or payment link', async () => {
  const a = await createMerchant(); const b = await createMerchant();
  const themeB = await createRow('CheckoutTheme', b.id, false);
  const linkB  = await createRow('PaymentLink', b.id, false);
  await expect(prisma.session.create({ data: minimalSession({ merchantId: a.id, livemode: false, themeId: themeB.id }) }))
    .rejects.toThrow(/Foreign key constraint/);
  await expect(prisma.session.create({ data: minimalSession({ merchantId: a.id, livemode: false, paymentLinkId: linkB.id }) }))
    .rejects.toThrow(/Foreign key constraint/);
});
it('a live session cannot reference a test-mode payment link', async () => { /* same merchant, link livemode=false, session livemode=true → FK error */ });
it('payment link slugs are unique per merchant and mode', async () => {
  // same merchant: 'classic-tote' in test and in live both succeed; second 'classic-tote' in test → P2002
});
it('no column stores private keys', async () => {
  const cols = await prisma.$queryRaw<{column_name: string}[]>`SELECT column_name FROM information_schema.columns WHERE table_schema='public'`;
  expect(cols.map(c => c.column_name).filter(c => /private|secret_key|mnemonic|seed/.test(c))).toEqual([]);
});
```

(`newId` comes from Task 5; for this task inline `'evt_' + ulid()`.)

- [ ] **Step 2:** Run → FAIL (tables missing).
- [ ] **Step 3:** Write `schema.prisma` from Appendix A. **Composite FKs:** every parent that merchant-owned children reference gets `@@unique([id, merchantId])` (and `@@unique([id, merchantId, livemode])` when it has `livemode`); every child relation uses `fields: [parentId, merchantId(, livemode)]`, `references: [id, merchantId(, livemode)]`. If Prisma refuses a composite relation where the parent id is optional (e.g. `sessions.theme_id`), keep a plain relation in Prisma and add the composite FK by hand in `migration.sql` (`FOREIGN KEY (theme_id, merchant_id) REFERENCES checkout_themes (id, merchant_id)`; Postgres `MATCH SIMPLE` skips the check when `theme_id` is null). `createRow` and `minimalSession` move into this task's helpers. Delete old `migrations/` contents except `migration_lock.toml`. Run `npx prisma migrate dev --name foundation --create-only`, then append to the generated `migration.sql`:

```sql
CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events is append-only'; END $$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
```

Then `npx prisma migrate dev`.
- [ ] **Step 4:** Implement `src/test/helpers.ts`. Run `npm test --workspace=@tendr/api -- schema` → PASS.
- [ ] **Step 5:** Commit `feat(db): foundation schema from data-model diagram`.

---

### Task 5: IDs, serialization, scoped and read-only data access

**Files:**
- Create: `apps/api/src/lib/ids.ts`, `apps/api/src/db/models.ts`, `apps/api/src/db/scoped.ts`, tests `ids.test.ts`, `serialize.test.ts`, `scoped.test.ts`
- Rewrite: `apps/api/src/lib/serialize.ts`

**Interfaces:**
- Produces:
  - `newId(prefix: IdPrefix): string` → `${prefix}_${ulid()}`. `IdPrefix` = `'mer'|'usr'|'key'|'akey'|'stc'|'pal'|'whe'|'gpol'|'plink'|'ses'|'quo'|'pay'|'ref'|'whd'|'hook'|'gas'|'scr'|'evt'|'fplan'|'rev'|'thm'|'tasset'|'sec'|'idem'`.
  - `toJsonDecimal(d: Prisma.Decimal | null): string | null` (exact `toFixed()` with no exponent).
  - `PER_MODE_MODELS` and `SHARED_MODELS` string arrays (Prisma model names) per Appendix A's `livemode` column.
  - `scopedDb(ctx: { merchantId: string; livemode: boolean }): ScopedDb` — a `prisma.$extends` client whose query extension, for every model in `PER_MODE_MODELS`, injects `merchantId` and `livemode` into `where` for read/update/delete operations and into `data` for create/createMany/upsert; for `SHARED_MODELS` injects `merchantId` only (`Merchant` itself uses `id`). Infra models (`Event`, `EventOutbox`, `Secret`, `IdempotencyKey`) are not reachable through it (throw `FORBIDDEN`). `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe` throw `FORBIDDEN` on both clients; raw SQL is only available on the unscoped `prisma` used by infra code.
  - `readOnlyDb(ctx): ReadOnlyDb` — same scoping, and any create/update/upsert/delete/createMany/updateMany/deleteMany/`$executeRaw`/`$transaction` call throws `AppError('FORBIDDEN', 'read-only data access', 403)`. AI services (later projects) only ever receive this.

- [ ] **Step 1: Write failing tests**:

```ts
// ids.test.ts
it('prefixed ULIDs sort by creation time', async () => {
  const a = newId('evt'); await sleep(2); const b = newId('evt');
  expect(a).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/); expect(a < b).toBe(true);
});
// serialize.test.ts  (Review Focus 5)
it('10^30 smallest units round-trip exactly as a string', async () => {
  const q = await createQuoteRow({ amountIn: new Prisma.Decimal('1000000000000000000000000000000') });
  const back = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
  expect(toJsonDecimal(back.amountIn)).toBe('1000000000000000000000000000000');
});
// scoped.test.ts
it.each(PER_MODE_MODELS)('%s: test-mode client cannot see live rows', async (model) => {
  const m = await createMerchant();
  const liveRow = await createRow(model, m.id, true);   // helper builds minimal valid row per model
  const testDb = scopedDb({ merchantId: m.id, livemode: false });
  expect(await testDb[lcFirst(model)].findMany({})).toEqual([]);
  expect(await testDb[lcFirst(model)].findFirst({ where: { id: liveRow.id } })).toBeNull();
});
it('other merchant rows are invisible', async () => { /* sessions, two merchants */ });
it('create injects merchantId and livemode', async () => {
  const s = await scopedDb({ merchantId: m.id, livemode: true }).session.create({ data: minimalSession() });
  expect(s).toMatchObject({ merchantId: m.id, livemode: true });
});
it.each(['$queryRaw','$queryRawUnsafe','$executeRaw','$executeRawUnsafe'])('%s is blocked on scoped and read-only clients', async (m) => {
  await expect((scopedDb(ctx) as any)[m]`SELECT 1`).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect((readOnlyDb(ctx) as any)[m]`SELECT 1`).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('read-only client rejects writes', async () => {
  await expect(readOnlyDb(ctx).session.update({ where:{id}, data:{ metadata:{} } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Add `ulid` dependency. `createRow(model, merchantId, livemode)` lives in `src/test/helpers.ts`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(db): prefixed ULIDs, scoped and read-only data access`.

---

### Task 6: KeyVault interface, LocalKeyVault, secrets service

**Files:**
- Create: `apps/api/src/keyvault/{types,keys,local,secp256k1,index}.ts`, `apps/api/src/secrets/secrets.ts`, tests `keyvault/local.test.ts`, `keyvault/secp256k1.test.ts`, `secrets/secrets.test.ts`
- Modify: `apps/api/src/env.ts`

**Interfaces:**
- Produces:

```ts
type Curve = 'ed25519' | 'secp256k1';
type KeyName = 'relayer-near' | 'relayer-evm' | 'gas-tron' | 'funding-near' | 'solver-hot';
type Signature =
  | { curve: 'ed25519'; signature: Uint8Array }                 // 64 bytes
  | { curve: 'secp256k1'; r: Uint8Array; s: Uint8Array; v: 0 | 1 }; // low-s
interface KeyVault {
  encrypt(plaintext: Uint8Array, aad: string): Promise<string>;   // serialized envelope
  decrypt(envelope: string, aad: string): Promise<Uint8Array>;
  sign(key: KeyName, payload: Uint8Array): Promise<Signature>;     // ed25519: message; secp256k1: 32-byte digest
  publicKey(key: KeyName): Promise<{ curve: Curve; raw: Uint8Array }>; // ed25519 32B; secp256k1 65B uncompressed
}
function curveOf(key: KeyName): Curve;           // keys.ts registry
function getKeyVault(): KeyVault;                // index.ts, by KEYVAULT_DRIVER
function derToRsv(der: Uint8Array, digest: Uint8Array, pub65: Uint8Array): { r; s; v };   // secp256k1.ts
function evmAddress(pub65: Uint8Array): string;  // 0x + last 20 bytes of keccak256(pub[1:])
function nearPublicKey(raw32: Uint8Array): string; // 'ed25519:' + base58
putSecret(plaintext: string, purpose: string): Promise<string>;  // returns secret id 'sec_…' (the secret_ref)
getSecret(ref: string): Promise<string>;         // decrypt with 5-minute in-memory cache
```

- Registry (`keys.ts`): `relayer-near` ed25519, `relayer-evm` secp256k1 (also submits EIP-3009 transfers), `gas-tron` secp256k1 (Tron gas wallet), `funding-near` ed25519, `solver-hot` ed25519. No EVM/Solana gas keys: that sponsorship is Pimlico, whose API key is stored with `putSecret` (purpose `pimlico`).
- Envelope format: JSON `{ v: 1, kek: string, wrappedDek: base64, iv: base64, tag: base64, ct: base64 }` — AES-256-GCM with a random 32-byte DEK; the DEK is wrapped by the KEK (local: AES-256-GCM with the file KEK; GCP: KMS `encrypt`). `aad` is bound into the data GCM; for secrets the aad is the secret id.
- Env: `KEYVAULT_DRIVER: 'local'|'gcp'` (default `local`), `LOCAL_KEYVAULT_PATH` (default `.keyvault/local.json`).

- [ ] **Step 1: Write failing tests**:

```ts
// local.test.ts
it('encrypt/decrypt round trip, aad bound', async () => {
  const kv = new LocalKeyVault(tmpPath());
  const env = await kv.encrypt(Buffer.from('whsec_abc'), 'sec_1');
  expect(Buffer.from(await kv.decrypt(env, 'sec_1')).toString()).toBe('whsec_abc');
  await expect(kv.decrypt(env, 'sec_2')).rejects.toThrow();
});
it('ed25519 signature verifies as NEAR', async () => {
  const msg = sha256(utf8('near tx bytes'));
  const sig = await kv.sign('funding-near', msg);
  const { raw } = await kv.publicKey('funding-near');
  expect(sig.curve).toBe('ed25519');
  expect(ed25519.verify(sig.signature, msg, raw)).toBe(true);
  expect(nearPublicKey(raw)).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});
it('secp256k1 signature recovers to the key EVM address', async () => {
  const digest = keccak_256(utf8('evm tx'));
  const sig = await kv.sign('relayer-evm', digest);
  const { raw } = await kv.publicKey('relayer-evm');
  const recovered = secp256k1.Signature.fromCompact(concat(sig.r, sig.s)).addRecoveryBit(sig.v)
    .recoverPublicKey(digest).toRawBytes(false);
  expect(evmAddress(recovered)).toBe(evmAddress(raw));
  expect(BigInt('0x' + hex(sig.s)) <= secp256k1.CURVE.n / 2n).toBe(true);
});
it('refuses to construct in production', () => { /* NODE_ENV=production → throws */ });
it('curveOf: relayer-evm and gas-tron are secp256k1, the other three are ed25519', ...);
// secp256k1.test.ts
it('derToRsv normalises high-s and finds v', () => {
  // sign with noble, force high-s (s' = n - s), DER-encode, run derToRsv → low s, recovers to pubkey
});
// secrets.test.ts
it('putSecret stores only ciphertext', async () => {
  const ref = await putSecret('whsec_plain', 'webhook');
  const row = await prisma.secret.findUniqueOrThrow({ where: { id: ref } });
  expect(row.ciphertext).not.toContain('whsec_plain');
  expect(await getSecret(ref)).toBe('whsec_plain');
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `@noble/curves` (ed25519, secp256k1), `@noble/hashes` (sha256, keccak_256), `bs58`. `LocalKeyVault` stores a KEK and per-name private keys in its JSON file, creating them on first use (file mode 0600). Local secp256k1 signing goes through `derToRsv` too (sign → DER → `derToRsv`) so the GCP path's conversion is exercised locally.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(keyvault): KeyVault interface, local vault, secrets`.

---

### Task 7: GcpKeyVault and the two-curve verification script

**Files:**
- Create: `apps/api/src/keyvault/gcp.ts`, `apps/api/src/keyvault/gcp.test.ts`, `apps/api/scripts/verify-gcp-kms.ts`
- Modify: `apps/api/src/keyvault/index.ts`, `apps/api/src/env.ts`, `apps/api/package.json` (script `kms:verify`)

**Interfaces:**
- Consumes: `KeyVault`, `derToRsv`, `evmAddress`, `nearPublicKey`, `curveOf` (Task 6).
- Produces: `new GcpKeyVault(opts: { client: KeyManagementServiceClient; projectId; location; keyRing; kekKey: string })`. Key version path: `projects/{p}/locations/{l}/keyRings/{r}/cryptoKeys/{keyName}/cryptoKeyVersions/1`. Env (required only when `KEYVAULT_DRIVER=gcp`): `GCP_PROJECT_ID`, `GCP_KMS_LOCATION`, `GCP_KMS_KEYRING`, `GCP_KMS_KEK` (default `tendr-kek`), `GCP_CREDENTIALS_JSON` (service-account JSON as a string; parsed and passed as `credentials`).

- [ ] **Step 1: Write failing unit test** with a stubbed `KeyManagementServiceClient`:
  - `sign('relayer-evm', digest)` calls `asymmetricSign` with `{ name: <version path>, digest: { sha256: digest } }` (Cloud KMS's secp256k1 algorithm is `EC_SIGN_SECP256K1_SHA256` and accepts any 32-byte pre-hashed digest — we pass keccak256 for EVM, sha256(raw_data) for Tron), and returns `derToRsv` output.
  - `sign('funding-near', msg)` calls `asymmetricSign` with `{ name, data: msg }`.
  - `publicKey` parses the PEM from `getPublicKey` into raw bytes (ed25519 32B, secp256k1 65B).
  - `encrypt` wraps the DEK via `encrypt({ name: <kek path>, plaintext: dek })`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; add `@google-cloud/kms`. `getKeyVault()` returns `GcpKeyVault` when `KEYVAULT_DRIVER=gcp`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Write `scripts/verify-gcp-kms.ts` (`npm run kms:verify --workspace=@tendr/api`). It uses `GCP_*` env, creates (if absent) key ring `tendr-verify`, a symmetric key `tendr-kek`, an `EC_SIGN_ED25519` key `verify-ed25519` and an `EC_SIGN_SECP256K1_SHA256` key `verify-secp256k1` — HSM protection level, falling back to SOFTWARE with a printed warning if HSM is rejected for that algorithm. Then checks: encrypt/decrypt round trip; Ed25519 signature verifies with `ed25519.verify` against the KMS public key (print the `ed25519:` NEAR key); secp256k1 signature over a keccak256 digest recovers to `evmAddress(publicKey)` (print it). Exit 0 with `ALL CHECKS PASSED` or exit 1 naming the failing check. **Not run in CI; the user runs it with their credentials.**
- [ ] **Step 6:** Commit `feat(keyvault): GCP Cloud KMS vault and verification script`.

---

### Task 8: Gateway — principals, auth, scopes, `/v1/ping`

**Files:**
- Create: `apps/api/src/gateway/principal.ts`, `apps/api/src/gateway/auth.ts`, `apps/api/src/routes/ping.ts`, `apps/api/src/gateway/auth.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `scopedDb` (Task 5), contracts `PrincipalKind`, `Scope`.
- Produces:

```ts
type Principal =
  | { kind: 'secret_key'; merchantId; livemode; apiKeyId; scopes: Scope[] }
  | { kind: 'publishable_key'; merchantId; livemode; apiKeyId }
  | { kind: 'session_client'; merchantId; livemode; sessionId }
  | { kind: 'dashboard_user'; merchantId; livemode; userId; role: MerchantUserRole }  // resolver: project 3
  | { kind: 'agent'; merchantId; livemode; agentId };                                // resolver: project 6
// route option
declare module 'fastify' {
  interface FastifyContextConfig { auth?: { principals: PrincipalKind[]; scope?: Scope } | 'public' }
  interface FastifyRequest { principal?: Principal; db?: ScopedDb }
}
function requirePrincipal(req): Principal;
function principalRef(p: Principal): string;  // apiKeyId | sessionId | userId | agentId — used by rate limit & idempotency
```

- Credential formats (Bearer): secret `tdr_test_…` / `tdr_live_…`; publishable `tdr_pk_test_…` / `tdr_pk_live_…`; session client secret `ses_<ULID>_secret_<32 hex>` (hash in `sessions.client_secret_hash`). `livemode` comes from the stored row, and must equal the prefix (mismatch → 401).
- An `onRoute` hook throws at startup if any `/v1/*` route lacks `config.auth`.

- [ ] **Step 1: Write failing tests** (`auth.test.ts`, registering throwaway test routes on the built app before `ready()`):

```ts
it('ping returns principal for secret test key', async () => {
  const { raw } = await createApiKey(m.id, { livemode: false });
  const res = await app.inject({ url: '/v1/ping', headers: { authorization: `Bearer ${raw}` } });
  expect(res.json()).toEqual({ merchantId: m.id, livemode: false, principal: 'secret_key', scopes: ALL_SCOPES });
});
it('401 on missing, unknown, revoked key', ...);
it('401 when prefix mode disagrees with stored mode', ...);   // tdr_live_ prefix on a livemode=false row
it('403 publishable key on secret-only route', ...);
it('403 missing scope', ...);                                  // key with ['payments:read'] on scope 'sessions:write'
it('session client secret reads only its own session principal', ...);
it('route without auth config fails at startup', async () => {
  const a = await buildApp({ extraRoutes: (f) => f.get('/v1/naked', async () => ({})) });
  await expect(a.ready()).rejects.toThrow(/auth config/);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement auth as a `preHandler` plugin (`fastify-plugin`) that resolves the principal, checks kind and scope, updates `last_used_at` at most once per minute per key, and sets `req.db = scopedDb(principal)`. Request logs (existing `log()`) include `requestId`, `merchantId`, `livemode` and `principal` kind on every authenticated request; the raw credential is never logged. `buildApp(opts?: { extraRoutes?: (app) => void })` gains the test hook. `/v1/ping` uses `auth: { principals: ['secret_key','publishable_key'] }` and returns `{ merchantId, livemode, principal, scopes? }`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(gateway): principals, API key auth, scopes, ping`.

---

### Task 9: Gateway — optional HMAC request signing

**Files:**
- Create: `apps/api/src/gateway/signing.ts`, `apps/api/src/gateway/signing.test.ts`
- Modify: `apps/api/src/app.ts` (raw body capture), `apps/api/src/gateway/auth.ts`

**Interfaces:**
- Consumes: `getSecret` (Task 6), `api_keys.signing_secret_ref`, `api_keys.signing_required`.
- Produces: header `Tendr-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, `${t}.${rawBody}`)>`; `verifyRequestSignature(header: string | undefined, rawBody: Buffer, secret: string, now: number): 'ok' | 'missing' | 'stale' | 'invalid'`; tolerance **300 s** either direction; comparison constant-time. Applies only to `secret_key` principals. If the key has `signing_required` and the header is missing/invalid/stale → 401 `SIGNATURE_INVALID`. If the key has a signing secret but not required and a header is present, it is still verified (bad → 401).

- [ ] **Step 1: Write failing tests**:

```ts
it('accepts a valid signature', ...);
it('rejects wrong secret, stale (t-301), future (t+301), missing when required', ...);
it('verifies over raw bytes, not re-serialised JSON', async () => {   // Review Focus 2
  const body = '{ "b":1,   "a":2 }';
  const sig = sign(secret, now, body);
  const res = await app.inject({ method: 'POST', url: '/v1/test-echo', payload: body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}`, 'tendr-signature': sig } });
  expect(res.statusCode).toBe(200);
});
it('unsigned request passes when signing not required', ...);
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; capture raw body with a JSON content-type parser (`parseAs: 'buffer'`) that stores `req.rawBody` then `JSON.parse`s.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(gateway): optional HMAC request signing`.

---

### Task 10: Gateway — Redis rate limits

**Files:**
- Create: `apps/api/src/lib/redis.ts`, `apps/api/src/gateway/rate-limit.ts`, `apps/api/src/gateway/rate-limit.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces: `getRedis(): Redis` (ioredis singleton from `REDIS_URL`, `maxRetriesPerRequest: 1`, `enableOfflineQueue: false`); `closeRedis()`.
- Limits (1-minute window): `secret_key` **1000 per key**; `publishable_key` **60 per (key, client IP)** — one key is shared by every browser on a merchant's site, so it is never limited per key alone; `session_client` **120 per session**; unauthenticated/public routes **60 per IP**. Client IP is `req.ip` with Fastify `trustProxy: true` (Railway sits behind a proxy). `@fastify/rate-limit` with `redis: getRedis()`, `hook: 'preHandler'` registered after auth, `skipOnError: true` (fail open), errors logged at `warn`. 429 uses the existing `RATE_LIMITED` envelope and `RateLimit-*` headers.

- [ ] **Step 1: Write failing tests**:

```ts
it('429 after the per-key limit, separate counters per key', ...);   // use buildApp({ rateLimitOverrides: { secret_key: 3 } })
it('publishable key: one IP hitting the limit does not block another IP', async () => {
  // rateLimitOverrides { publishable_key: 2 }; 3 requests from x-forwarded-for 1.1.1.1 → third 429;
  // request from 2.2.2.2 with the same key → 200
});
it('fails open when Redis is down', async () => {                      // Review Focus 3
  const app = await buildApp({ redisUrl: 'redis://localhost:1' });
  const res = await app.inject({ url: '/v1/ping', headers: { authorization: `Bearer ${raw}` } });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (`buildApp` gains `rateLimitOverrides` and `redisUrl` options for tests). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(gateway): per-principal rate limits in Redis`.

---

### Task 11: Gateway — idempotency

**Files:**
- Create: `apps/api/src/gateway/idempotency.ts`, `apps/api/src/gateway/idempotency.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `idempotency_keys` (Appendix A), `principal`.
- Produces: on every `POST` under `/v1` with an `Idempotency-Key` header (1–255 chars): row key `(merchant_id, livemode, key)`. Flow: insert row `status='in_progress', request_hash=sha256(method + url + rawBody)`; on unique conflict → if existing `in_progress` → 409 `IDEMPOTENCY_IN_PROGRESS`; if completed with a different hash → 409 `IDEMPOTENCY_CONFLICT`; same hash → replay stored status + body with header `Idempotent-Replayed: true`. On completion (`onSend`) store status code + body and `status='completed'`; on 5xx delete the row so the client can retry. `expires_at = now + 24h`; expired rows are ignored and replaced. **Lock timeout:** an `in_progress` row whose `locked_at` is older than **60 s** is taken over — a conditional `UPDATE … SET locked_at = now(), request_hash = … WHERE status = 'in_progress' AND locked_at < now() - interval '60 seconds'` (one winner) — and the request executes. If the hash differs from the stale row's, it is still a conflict (409 `IDEMPOTENCY_CONFLICT`). A worker job (Task 13) purges expired rows hourly.

- [ ] **Step 1: Write failing tests** (with a test POST route that counts executions):

```ts
it('replays the same response and executes once', ...);
it('409 on same key, different body', ...);
it('concurrent duplicates: one executes, the other gets 409 IDEMPOTENCY_IN_PROGRESS', async () => {
  const [a, b] = await Promise.all([post(key, body), post(key, body)]);  // handler sleeps 200ms
  expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]); expect(counter).toBe(1);
});
it('same key with test and live keys does not replay across modes', ...);  // Review Focus 1: counter === 2
it('5xx response is not stored', ...);
it('expired key executes again', ...);
it('stale in_progress key (locked 61s ago, simulating a crashed request) is taken over and executes', async () => {
  // insert row status in_progress, locked_at = now() - 61s, same request hash; POST → 200, counter 1, row completed
});
it('in_progress key locked 30s ago still returns 409 IDEMPOTENCY_IN_PROGRESS', ...);
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(gateway): idempotency keys`.

---

### Task 12: Event log and state transitions

**Files:**
- Create: `apps/api/src/events/record.ts`, `apps/api/src/events/transitions.ts`, `apps/api/src/events/transitions.test.ts`

**Interfaces:**
- Consumes: contracts `canTransitionSession`, `canTransitionPayment`, `isTerminalSession`; `newId`.
- Produces:

```ts
type Tx = Prisma.TransactionClient;
recordEvent(tx: Tx, e: { merchantId: string | null; livemode: boolean | null;
  aggregateType: 'session' | 'payment' | string; aggregateId: string; type: string; payload: object }): Promise<string>;
  // inserts events row + event_outbox row (same tx); returns event id
transitionSession(tx: Tx, sessionId: string, to: SessionStatus, payload?: object): Promise<void>;
  // reads current status; illegal → invalidState (409 INVALID_STATE_TRANSITION) + log 'warn';
  // updateMany({ where: { id, status: from }, data: { status: to } }); count 0 → conflict('concurrent transition');
  // recordEvent type 'session.status_changed', payload { from, to, ...payload }
transitionPayment(tx: Tx, paymentId: string, to: PaymentStatus, payload?: object): Promise<void>;  // same, 'payment.status_changed'
```

- [ ] **Step 1: Write failing tests**:

```ts
it('legal transition updates status and writes event + outbox in one tx', ...);
it('illegal transition throws INVALID_STATE_TRANSITION and writes nothing', ...);
it('terminal session cannot be transitioned (SETTLED → REFUNDED)', ...);
it('rolled-back tx leaves no event or outbox row', ...);
it('concurrent transitions: exactly one wins', ...);
it('quote expiry leaves session PENDING_DEPOSIT', async () => {
  // a session with an expired quote (deadline in the past) — no code path moves the session;
  // assert transitionSession is not required and status stays PENDING_DEPOSIT after creating a second quote
});
it('late deposit on a SETTLED session is recorded on a new payment, session unchanged', async () => {
  // create SETTLED session; create payment {isLate:true,status:'DETECTED'}; transitionPayment → REFUNDING → REFUNDED
  // session.status still SETTLED; deriveRefundStatus('SETTLED', …) → refundStatus 'none', lateRefundStatus 'refunded'
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(events): append-only event log and transition functions`.

---

### Task 13: Queue, worker, dispatcher, health

**Files:**
- Rewrite: `apps/api/src/jobs/queue.ts`
- Create: `apps/api/src/jobs/handlers.ts`, `apps/api/src/jobs/dispatcher.ts`, `apps/api/src/worker.ts`, `apps/api/scripts/jobs-failed.ts`, `apps/api/src/jobs/dispatcher.test.ts`
- Modify: `apps/api/package.json` (scripts `dev:worker`, `start:worker`, `jobs:failed`), root `package.json` `dev` to run api + worker, `turbo.json` if needed, `apps/api/src/env.ts` (`WORKER_HEALTH_PORT`, default 4100)

**Interfaces:**
- Consumes: `event_outbox`, `events`, `getRedis`.
- Produces:

```ts
registerEventHandler(eventType: string, name: string, fn: (event: Event) => Promise<void>): void;
dispatchOnce(): Promise<number>;   // one batch; returns rows dispatched
startDispatcher(intervalMs = 500): () => Promise<void>;  // returns stop()
startWorker(): Promise<{ stop(): Promise<void> }>;
```

- Queue `tendr-events`. Dispatch batch (≤100) in one Postgres transaction: `SELECT event_id FROM event_outbox ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100`; for each event and each registered handler for its type, `queue.add(handlerName, { eventId }, { jobId: \`${eventId}:${handlerName}\`, attempts: 8, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86400 }, removeOnFail: false })`; then `DELETE` those outbox rows. Events with no handlers are just deleted from the outbox.
- Job processor loads the event by id and calls the handler. Failed jobs after 8 attempts stay in BullMQ's failed set; `npm run jobs:failed` prints them (id, handler, attempts, last error).
- Repeatable job `purge-idempotency` hourly: `DELETE FROM idempotency_keys WHERE expires_at < now()`.
- Worker health: HTTP `GET /health` on `WORKER_HEALTH_PORT` → 200 `{ status:'ok' }` if `SELECT 1` and Redis `PING` succeed, else 503 `{ status:'degraded', db, redis }`. The api's `/v1/health` stays a liveness check (200 whenever the process is up).

- [ ] **Step 1: Write failing tests**:

```ts
it('every committed event is dispatched once per handler', ...);
it('events committed out of id order are still dispatched', async () => {
  // tx A: recordEvent (older ULID), hold open; tx B: recordEvent, commit; dispatchOnce(); commit A; dispatchOnce()
  // both handler calls observed
});
it('crash after enqueue before delete does not run a handler twice', async () => {   // Review Focus 4
  // stub DELETE to throw once → dispatchOnce rejects, outbox rows remain; dispatchOnce again; drain worker
  // handler called exactly once per event (jobId dedupe)
});
it('failed handler retries then lands in failed set', ...);   // attempts overridden to 2 in test
it('worker health is 503 when Redis is down', ...);           // Review Focus 3
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; add `bullmq`, `ioredis`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Verify locally: `npm run dev` starts api (4000) and worker; `curl localhost:4100/health` → `{"status":"ok"}`.
- [ ] **Step 6:** Commit `feat(jobs): BullMQ worker with outbox dispatcher`.

---

### Task 14: Seed, Terraform, docs

**Files:**
- Rewrite: `apps/api/prisma/seed.ts`
- Create: `infra/terraform/gcp/{main,variables,outputs}.tf`, `infra/terraform/railway/{main,variables}.tf`, `infra/terraform/README.md`
- Modify: `README.md`, `.env.example`, `apps/docs/development/local-setup.mdx`, `apps/docs/concepts/idempotency.mdx`, `apps/docs/security/api-keys.mdx`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Seed** (idempotent on `merchants.name = 'Demo Merchant'`): merchant (`kind=merchant`, `status=active`), owner `merchant_users` row `owner@demo.tendr.local` (role owner, no auth yet), secret test + live keys and publishable test + live keys with `ALL_SCOPES` (raw keys printed once), merchant `slug = 'demo-merchant'`; a **test-mode** `settlement_configs` row (USDC on Base placeholder asset, `payout_mode=wallet`, any well-formed placeholder address — test mode moves no funds); a **live-mode** settlement config **only if `SEED_PAYOUT_ADDRESS` is set and is a valid EVM address** — otherwise none, and the seed prints that live payments are disabled until one is configured; never a zero or placeholder address in live mode, default published `checkout_themes` row, `fee_plans` row `fee_bps=50`, `default_fee_payer=merchant`. *(fee_bps 50 is a placeholder; project 2 sets real pricing.)*
- [ ] **Step 1b: Seed test** `prisma/seed.test.ts`: with `SEED_PAYOUT_ADDRESS` unset, after seeding there is no live `settlement_configs` row; with it set to a valid address there is exactly one, with that address; with it set to `0x000…000` the seed refuses (non-zero exit / throws).
- [ ] **Step 2:** Verify: `npm run db:seed` twice → second run prints "already seeded"; `curl -H "Authorization: Bearer <test key>" localhost:4000/v1/ping` → `{"livemode":false,…}`.
- [ ] **Step 3: Terraform GCP** (`google` provider): key ring `tendr-prod`; symmetric key `tendr-kek` (rotation 90 days); asymmetric keys `relayer-near`, `funding-near`, `solver-hot` (`EC_SIGN_ED25519`) and `relayer-evm`, `gas-tron` (`EC_SIGN_SECP256K1_SHA256`); no EVM/Solana gas keys (Pimlico), protection level variable defaulting `HSM`; service account `tendr-api` with `roles/cloudkms.cryptoKeyEncrypterDecrypter` on `tendr-kek` only and `roles/cloudkms.signerVerifier` + `roles/cloudkms.publicKeyViewer` on each asymmetric key. `prevent_destroy` on all keys.
- [ ] **Step 4: Terraform Railway** (community provider `terraform-community-providers/railway`): project, services `api` (start `npm run start --workspace=@tendr/api`, pre-deploy `npm run db:migrate`, healthcheck `/v1/health`), `worker` (start `npm run start:worker --workspace=@tendr/api`), Postgres and Redis plugins, shared variables (`KEYVAULT_DRIVER=gcp`, `GCP_*`, `GCP_CREDENTIALS_JSON` as a sensitive variable). `infra/terraform/README.md` states: **not applied — apply only when the user decides to deploy**; documents creating a Postgres `tendr_app` role without `UPDATE`/`DELETE` on `events` and running migrations as the owner.
- [ ] **Step 5:** Verify: `terraform fmt -check -recursive infra/terraform && terraform -chdir=infra/terraform/gcp init -backend=false && terraform -chdir=infra/terraform/gcp validate` (same for railway) → `Success!`. If Terraform is not installed, install it (`brew install terraform`) or report the step as unverified.
- [ ] **Step 6:** Docs: README quick start (`docker compose up -d`, `npm install`, `npm run db:migrate:dev --workspace=@tendr/api`, `npm run db:seed`, `npm run dev`), removes "Judge demo path" and sandbox sections, adds test/live keys and the `kms:verify` step. Update the three docs pages for key formats (`tdr_test_`, `tdr_live_`, `tdr_pk_*`), `Tendr-Signature`, and the idempotency rules from Task 11.
- [ ] **Step 7:** Full check: `npm run lint && npm run typecheck && npm test && npm run build` → all green.
- [ ] **Step 8:** Commit `chore: seed, terraform (unapplied), docs for foundation`.

---

## Appendix A — Tables

`M` = has `merchant_id` FK (indexed). `L` = has `livemode boolean not null`. All tables have `created_at`; mutable ones also `updated_at`. Enum values are the Postgres enums. Columns are from the `data-model` diagram unless marked **+** (added by spec/plan).

| Table | M | L | Columns (beyond id) and constraints |
|---|---|---|---|
| merchants | – | – | name, **+slug** unique, kind `merchant\|integrator`, aup_accepted_at?, status `active\|suspended\|closed` |
| merchant_users | ✓ | – | email, role `owner\|admin\|finance\|viewer`, auth_provider?, mfa_enabled bool; unique (merchant_id, email) |
| api_keys | ✓ | ✓ | name, **+kind** `secret\|publishable`, key_prefix, key_hash unique, scopes text[], **+signing_secret_ref**? → secrets, **+signing_required** bool default false, last_used_at?, revoked_at? |
| account_keys | ✓ | – | near_account_id, public_key, kind `passkey\|fn_call`, revoked_at? |
| settlement_configs | ✓ | ✓ | dest_asset_id, dest_chain, payout_mode `wallet\|intents`, payout_address?, near_account?, is_default bool |
| payout_allowlist | ✓ | ✓ | chain, address, status `pending\|active\|revoked`, active_from; unique (merchant_id, livemode, chain, address) |
| webhook_endpoints | ✓ | ✓ | url, secret_ref → secrets, events text[], active bool |
| gas_policies | ✓ | ✓ | enabled, per_payment_cap_usd, monthly_budget_usd, min_order_usd, chains text[], tokens text[], first_time_only bool |
| payment_links | ✓ | ✓ | theme_id? → checkout_themes, slug (unique per merchant_id, livemode), title, amount? (38,18), **+amount_currency**, open_amount bool, dest_asset, dest_chain, gas_sponsor `default\|merchant\|buyer`, gas_max_usd?, max_uses?, use_count int default 0, expires_at?, status `active\|inactive\|expired` |
| sessions | ✓ | ✓ | theme_id?, payment_link_id?, external_ref?, amount_mode `EXACT_IN\|EXACT_OUT`, amount (38,18), **+amount_currency**, dest_asset, dest_chain, recipient, beneficiary?, delivery `WEBHOOK\|HOOK`, hook_data jsonb?, metadata jsonb default {}, fee_bps int, fee_payer `merchant\|payer`, gas_sponsor `merchant\|buyer` (resolved), gas_max_usd?, status SessionStatus default PENDING_DEPOSIT, expires_at, **+client_secret_hash** unique; unique (merchant_id, livemode, external_ref); index (status, expires_at) |
| quotes | ✓ | ✓ | session_id, origin_asset_id, deposit_address, amount_in (78,0), amount_out (78,0), refund_to, deadline, oneclick_quote_ref?; unique (livemode, deposit_address) |
| payments | ✓ | ✓ | session_id, quote_id, origin_tx_hash?, amount_received (78,0), settle_tx?, payout_tx?, fee_amount (78,0)?, network_fee (78,0)?, gas_sponsored bool default false, status PaymentStatus, is_late bool default false, settled_at? |
| refunds | ✓ | ✓ | payment_id, reason `expired\|late\|underpaid\|failed`, refund_tx_hash?, status `pending\|submitted\|confirmed\|failed` |
| webhook_deliveries | ✓ | ✓ | endpoint_id, session_id?, **+event_id** → events, event_type, idempotency_key unique, attempt int, status_code?, next_retry_at? |
| hook_calls | ✓ | ✓ | session_id, chain, target_contract, tx_hash?, attempt int, status `pending\|submitted\|confirmed\|failed` |
| gas_sponsorships | ✓ | ✓ | session_id, chain, tx_hash?, method `eip3009\|permit\|paymaster\|paymaster_verifying\|paymaster_erc20\|energy\|fee_payer`, **+provider** (e.g. `pimlico`), **+user_op_hash**?, sponsor `merchant\|tendr`, gas_used (78,0)?, cost_usd?, recovered_from_payment_id?, status `pending\|submitted\|confirmed\|failed` |
| screening_results | ✓ | ✓ | session_id, address, chain, provider, risk_score numeric(5,2), decision `allow\|block` |
| events | ✓? | ✓? | aggregate_type, aggregate_id, type, payload jsonb; index (aggregate_type, aggregate_id), (created_at); append-only trigger |
| fee_plans | ✓ | – | fee_bps int, default_fee_payer `merchant\|payer`, volume_tiers jsonb, effective_from |
| revenue_entries | ✓ | ✓ | payment_id, source `app_fee\|spread`, asset_id, amount (78,0), tx_hash? |
| checkout_themes | ✓ | – | name, is_default, version int, status `draft\|published`, display_name, logo_url?, accent, background, text, mode `light\|dark\|auto`, font, corner_radius int, layout `modal\|inline\|page`, blocks jsonb, schema_version int, custom_css?, css_hash?, css_validation jsonb?, button_label?, success_message?, support_url?, terms_url?, token_preferences jsonb |
| theme_assets | ✓ | – | theme_id, kind `logo\|image\|font`, url, mime, size_bytes int, checksum |
| **+idempotency_keys** | ✓ | ✓ | key, request_hash, status `in_progress\|completed`, locked_at, response_code?, response_body jsonb?, expires_at; unique (merchant_id, livemode, key) |
| **+secrets** | – | – | purpose, ciphertext text (envelope JSON), kek |
| **+event_outbox** | – | – | event_id unique → events, created_at |

All `*_id` FKs to their parent table are **composite** — `(parent_id, merchant_id)`, plus `livemode` when both tables have it — so the database rejects cross-merchant and cross-mode links (Task 4). `secret_ref` columns are FKs to `secrets.id`.
