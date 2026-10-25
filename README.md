# Tendr

**One checkout. Every way to pay.**

Tendr is a universal checkout and payment-orchestration layer for digital commerce. Merchants integrate once; customers pay with supported digital assets; Tendr coordinates checkout, verification, and merchant notifications.

NEAR Intents is an optional execution integration behind the scenes—not the Tendr brand.

> **Status:** foundation. The platform underneath checkout is in place: database schema, API
> gateway (API keys, scopes, request signing, rate limits, idempotency), append-only event log,
> BullMQ worker with outbox dispatch, and a key vault (local file in dev, Cloud KMS in
> production). Checkout endpoints (sessions, quotes, payments, webhooks) come in the checkout
> project; nothing here moves funds yet.

## Monorepo layout

```text
Tendr/
├── apps/web          # Next.js App Router + PWA
├── apps/api          # Fastify REST /v1 (api) + BullMQ worker
├── apps/docs         # Mintlify docs
├── packages/contracts|sdk|ui|config-*
├── apps/api/prisma   # schema, migrations, seed
└── infra
    ├── docker        # Postgres (host port 5433) + Redis (host port 6380)
    └── terraform     # GCP Cloud KMS + Railway (written, not applied)
```

## What is implemented

- PostgreSQL schema for merchants, keys, sessions, payments, refunds, webhooks, themes and the
  event log, with composite FKs that keep merchants and test/live modes apart
- `/v1` gateway: secret and publishable API keys per mode, scopes, optional HMAC request
  signing (`Tendr-Signature`), per-principal rate limits, `Idempotency-Key` on `POST`
- Scoped data access: every request reads and writes only its own merchant and mode
- Append-only `events` table with an outbox drained by the worker
- `KeyVault`: envelope encryption and Ed25519 / secp256k1 signing (local file or Cloud KMS)
- Health checks for the api (`GET /v1/health`) and worker (`GET /health` on `WORKER_HEALTH_PORT`)

## What is not implemented yet

- Checkout sessions, quotes, payments, refunds, webhook delivery (checkout project)
- Live settlement through NEAR Intents
- Merchant dashboard sign-in / KYC

## Quick start

Requires Node 22+, npm 10+ and Docker.

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d   # Postgres + Redis
npm install
npm run build --workspace=@tendr/contracts                # used by the seed script
npm run db:migrate:dev --workspace=@tendr/api             # dev database (DATABASE_URL)
npm run db:migrate:test --workspace=@tendr/api            # test database (TEST_DATABASE_URL)
npm run db:seed                                           # prints the demo API keys once
npm run dev                                               # web + api + worker
```

An existing local `tendr` database that still has the old sandbox migration needs a reset: run
`npm run db:migrate:dev --workspace=@tendr/api` (it prompts before resetting) or point
`DATABASE_URL` at a fresh database.

The seed is idempotent: it creates the **Demo Merchant** with secret keys (every scope) and
publishable keys (`sessions:read`, `sessions:write`, `payment_links:read`) for test and live mode
and prints the raw keys once (a rerun prints "already seeded" and no keys).
Keys look like:

| Key               | Prefix         | Use                    |
| ----------------- | -------------- | ---------------------- |
| Secret, test      | `tdr_test_`    | server-side, test mode |
| Secret, live      | `tdr_live_`    | server-side, live mode |
| Publishable, test | `tdr_pk_test_` | browser, test mode     |
| Publishable, live | `tdr_pk_live_` | browser, live mode     |

```bash
curl -H "Authorization: Bearer tdr_test_..." http://localhost:4000/v1/ping
# {"merchantId":"mer_...","livemode":false,"principal":"secret_key","scopes":[...]}
```

Live mode has no settlement config until you seed one with a real payout address
(`SEED_PAYOUT_ADDRESS=0x... npm run db:seed`); the zero address is refused.

Local Postgres is on **host port 5433** and Redis on **6380** (see `.env.example`), so they do
not collide with other local services.

- Web: http://localhost:3000
- API: http://localhost:4000 (`GET /v1/health`)
- Worker health: http://localhost:4100/health
- Docs: `npm run dev:docs` (Mintlify via `npx`)

### Merchant accounts (NEAR)

Each store gets a NEAR account (`<slug>.tendr.near` live, `<slug>.tendr.testnet` test) with **zero
access keys**. A threshold contract (`onchain/merchant-account`) is the only thing that can act for
it, and signers are passkeys verified inside the contract. Design:
`docs/superpowers/specs/2026-10-25-merchant-accounts-design.md`.

**Local development needs no NEAR node, GCP or contract build.** Outside production
`NEAR_CLIENT_DRIVER` defaults to `fake`, an in-memory NEAR client. Set `NEAR_FAKE_SIMULATE=1` (e2e
and offline demos only; refused with any other driver) to also run the contract's rules in memory.
`npm run e2e:serve --workspace=@tendr/api` starts the API and worker in one process for the
Playwright dashboard tests. Keep `MAIL_DRIVER=log` (the default in development): sign-in and
recovery emails are written to the log and to `apps/api/.mail/`.

**Testnet publish** (manual, never run by CI). Needs Docker and a funded `tendr.testnet` key:

```bash
export NEAR_PUBLISH_PRIVATE_KEY=ed25519:...        # full-access key of tendr.testnet
npm run onchain:publish:testnet --workspace=@tendr/api -- --network testnet
```

It builds `onchain/` in Docker (`onchain/scripts/build.sh`), publishes the `testnet-admin` build of
the merchant-account contract as a global contract, deploys `mock-intents` to
`intents-mock.tendr.testnet`, and prints the code hash. Put that in `MERCHANT_ACCOUNT_CODE_HASH_TEST`
and confirm the testnet asset ids it lists against `apps/web/src/lib/asset-registry.ts`. Any
`--network` other than `testnet` is refused.

**Mainnet checks** (manual, spends real funds, never run by CI). Verifies the spec's "Assumptions to
verify early" with a funded mainnet account of your own: `p256_verify` on mainnet, a 1Click swap
delivered to a contract account (`recipientType INTENTS`, `refundType INTENTS`), a threshold-approved
`ft_withdraw` with a `WITHDRAW_TO:` memo to an EVM address you control, sub-account creation without
`AddKey`, and NEP-145 storage needs. It also prints the observed omft token account names (to
confirm `POA_CHAIN_PREFIXES` in `money.rs` and `poa_suffix`), the real verifier's return values, and
the shape of RPC `InvalidNonce` and timeout errors. The saved-address delay is 24 h, so it runs in
two phases:

```bash
onchain/scripts/build.sh && onchain/scripts/build.sh --features probe merchant-account
export VERIFY_FUNDER_ACCOUNT_ID=you.near VERIFY_FUNDER_PRIVATE_KEY=ed25519:...
npm run onchain:verify:mainnet --workspace=@tendr/api -- \
  --yes-i-understand-this-spends-mainnet-funds --evm-address 0x... --phase prepare
# 24 hours later:
npm run onchain:verify:mainnet --workspace=@tendr/api -- \
  --yes-i-understand-this-spends-mainnet-funds --evm-address 0x... --phase finish --cleanup
```

It prints PASS / FAIL / INFO per check and stops at the first FAIL. The `probe` build adds a
`probe_p256` view and exists only for this script; it is never published.

**Audit gate.** The contract must be independently audited before any live merchant holds funds.
Do not set `MERCHANT_ACCOUNT_CODE_HASH_LIVE` (and do not publish a global contract on mainnet) until
the audit is done: provisioning a live account is refused while it is unset.

**Production checklist for merchant accounts**

- Fund the `relayer-accounts` NEAR account out of band. It is the implicit account whose id is the
  lower-case hex of the key's 32-byte Ed25519 public key (`implicitAccountId` in
  `apps/api/src/near/tx.ts`; read the public key from Cloud KMS). It only needs gas money.
  `funding-near` creates accounts and is capped by `FUNDING_PER_ACCOUNT_YOCTO` and
  `FUNDING_DAILY_CAP_YOCTO`; keep its balance low.
- `MAIL_DRIVER` has no working default in production (`unconfigured` makes sending fail loudly).
  Configure a real mail provider before enabling signup: until then no one can verify an email.
- The API answers `401 UNAUTHENTICATED` for a missing or expired dashboard session and for a failed
  passkey ceremony (the dashboard does not sign the user out on a failed ceremony). See
  `apps/docs` troubleshooting.
- The API and the dashboard may live on different subdomains. The CSRF value is returned as
  `csrfToken` in the body of every response that starts or describes a session and is sent back as
  the `Tendr-CSRF` header, so the dashboard does not depend on reading the API's cookie. Set
  `WEBAUTHN_RP_ID` to the parent domain (`usetendr.tech`) and list every dashboard origin in
  `WEBAUTHN_ORIGINS`.

### Cloud KMS check

Production keeps keys in Google Cloud KMS. To check that the GCP project supports both curves
(envelope encryption, an Ed25519 signature valid for NEAR, a secp256k1 signature that recovers to
the key's EVM address), set the `GCP_*` variables in `.env` and run:

```bash
npm run kms:verify --workspace=@tendr/api
```

It creates keys in a separate `tendr-verify` key ring and deploys nothing.

### Windows notes

- If `listen EACCES` occurs on `API_PORT`, Windows may have excluded that port range — set
  `API_PORT=18080` and matching `API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL`.
- The API defaults to `API_HOST=127.0.0.1`.

Never embed secret keys (`tdr_test_` / `tdr_live_`) in client bundles; only publishable keys
belong in the browser.

## Scripts

| Script                                          | Description                                |
| ----------------------------------------------- | ------------------------------------------ |
| `npm run dev`                                   | Web + API + worker (Turbo)                 |
| `npm run dev:docs`                              | Mintlify docs                              |
| `npm run build` / `lint` / `typecheck` / `test` | CI gates (tests need Postgres + Redis)     |
| `npm run test:e2e`                              | Playwright smoke                           |
| `npm run db:migrate`                            | Apply migrations (`prisma migrate deploy`) |
| `npm run db:seed`                               | Seed the Demo Merchant                     |
| `npm run jobs:failed --workspace=@tendr/api`    | List failed (dead-letter) jobs             |

## Deployment

Railway (api, worker, Postgres, Redis) and GCP Cloud KMS are described in
`infra/terraform/` and are **not applied** — see `infra/terraform/README.md`.

## Product docs

See `docs/product/INTRO_TO_TENDR.md` and `docs/product/TENDR_MONOREPO_SCAFFOLD.md`.

## License

Proprietary / hackathon use unless otherwise stated.
