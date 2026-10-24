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

The seed is idempotent: it creates the **Demo Merchant** with secret and publishable keys for
test and live mode and prints the raw keys once (a rerun prints "already seeded" and no keys).
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
