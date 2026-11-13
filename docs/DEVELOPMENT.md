# Local development and verification

These commands target the application tree described in the [README](../README.md), after checking out the exact application revision below. The documentation is mirrored across branches whose application code can differ; run the Tidepool-specific checks against the pinned revision below. Node 22, npm 10 and Docker are the baseline; [`.nvmrc`](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/.nvmrc), [package scripts](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/package.json) and [CI](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/.github/workflows/ci.yml) are the source of truth.

The default local environment uses simulated Test payments, a fake NEAR client, logged email and disabled model calls. It does not require GCP billing, a mainnet wallet or a NEAR AI key.

## Check out the reviewed application

From an existing Tendr repository checkout, create a separate worktree so its current files stay in place:

```sh
git fetch origin deploy
git worktree add --detach ../tendr-app-review 2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde
cd ../tendr-app-review
```

Run every command below from `tendr-app-review`. The published npm SDK has its own release tag; it does not change the application revision selected here.

## Install

Use Node 22 (with nvm, run `nvm install` and `nvm use` in the repository). Then:

```sh
npm ci
cp .env.example .env
npm run build --workspace=@tendr/contracts
npm run build --workspace=@tendr/sdk
npm run build --workspace=@tendr/ui
npm run db:generate --workspace=@tendr/api
```

If `.env` already exists, keep it and compare the example rather than overwriting it. Use a separate local configuration for evaluation; do not copy production secrets or database URLs.

## UI-only preview

```sh
npm run dev:web
```

Open [localhost:3000/demo](http://localhost:3000/demo). Switch industries and start checkout to inspect the frontend playground. Its completion states are simulated. The dashboard's persisted business workflows need the API/database setup below.

## Focused checks without external services

After installation, these four API suites run with provider/receipt mocks and pure pricing logic. They need the test environment values from `.env.example`, but do not require running PostgreSQL, Redis, a model provider or blockchain RPC:

```sh
npm run test --workspace=@tendr/api -- \
  src/checkout/oneclick/tidepool.test.ts \
  src/checkout/tidepool-receipts.test.ts \
  src/invoices/pricing.test.ts \
  src/ai/provider.test.ts
npm run test --workspace=@tendr/contracts
npm run lint --workspace=@tendr/docs
```

Expected result: passing assertions for network/token guards, receipt matching, USD-to-token arithmetic and the bounded model interface; schema tests; then the documentation check reports valid navigation, API operations and internal targets. These mocks do not prove provider uptime or funds movement.

## API, worker and persisted workflows

The current compose file maps PostgreSQL to **15432** and Redis to **6380**. Start just those services; optional object storage is not needed for the core review:

```sh
docker compose -f infra/docker/docker-compose.yml up -d postgres redis
npm run db:migrate --workspace=@tendr/api
npm run db:migrate:test --workspace=@tendr/api
npm run db:seed
npm run dev
```

The migration commands read the separate `DATABASE_URL` and `TEST_DATABASE_URL` from `.env`. The seed prints demo keys once; keep them local. API tests reset their database, so `TEST_DATABASE_URL` must point to a disposable database, never a store's real data.

| Surface           | Local address / expected observation                             |
| ----------------- | ---------------------------------------------------------------- |
| Web               | `http://localhost:3000`                                          |
| API               | `http://localhost:4000/v1/health` returns health JSON            |
| Worker            | `http://localhost:4100/health`                                   |
| Development email | Files/log entries under `apps/api/.mail/` with `MAIL_DRIVER=log` |
| Docs              | `npm run dev:docs`, then `http://localhost:3001`                 |

`NEAR_FAKE_SIMULATE=1` enables the old contract-account simulator for offline account demonstrations; use it only with `NEAR_CLIENT_DRIVER=fake`. It is not native Intents execution. Hosted Tidepool Test uses a different provider and real RPCs. Theme asset uploads need a configured asset store; a basic local checkout does not establish that integration.

For the API console, see the existing [console guide](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/api-console.md). Production-like wallet access has additional configuration; use the [native wallet handover](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/handover/2026-11-02-native-intents-wallets.md) and [Test integration handover](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/handover/2026-11-12-tidepool-dashboard.md).

## Broader test suites

With the isolated databases migrated and Redis running:

```sh
npm run test --workspace=@tendr/api
npm run test --workspace=@tendr/web
npm run typecheck --workspace=@tendr/api
npm run typecheck --workspace=@tendr/web
```

Browser tests start their own application servers, use simulated providers and a virtual authenticator:

```sh
npm exec --workspace=@tendr/web -- playwright install chromium
npm run test:e2e
```

Consult [CI](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/.github/workflows/ci.yml) for the complete prerequisites for WooCommerce, Rust sandbox and EVM tests. The [Tidepool handover](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/handover/2026-11-12-tidepool-dashboard.md#verification) records known pre-existing full-web-suite failures; historical counts are not a promise of a clean current run.

## Actual testnet verification

The [recorded pilot](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/handover/2026-11-12-tidepool-testnet-pilot.md#repeat-the-pilot) provides a separate script and funding instructions. It uses dedicated test-only accounts. Its `--run` option broadcasts testnet transactions, so it is outside the default mocked checks above.

For hosted-style testing, set `TEST_PAYMENT_PROVIDER=tidepool` and `NEAR_CLIENT_DRIVER=rpc` on both API and worker, with contract simulation disabled. Use the [integration handover](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/handover/2026-11-12-tidepool-dashboard.md) for wallet setup, exact token/network mappings and limits. A provider or faucet outage is an external dependency failure, not simulated success.

## Deployment and model calls

Live mode, native Live wallets, mail, FX and storage have separate readiness requirements. The older [deployment runbook](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/docs/handover/2026-10-31-deploy-runbook.md) is historical; combine it with the newer native-wallet, recovery and Tidepool handovers and current [environment schema](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/apps/api/src/env.ts). Cloud KMS is an available driver, not a requirement for the local setup above.

To enable model-backed features, configure the NEAR AI provider, supported model profile and server-only key described in [`.env.example`](https://github.com/SonOfUri/Tendr/blob/2623e8dc8d5ee5fbf8f8b3bd31daf885ad7fdcde/.env.example). Model usage can incur provider charges. Leave `AI_PROVIDER=disabled` for the ordinary test commands. Customer-facing checkout state remains determined by the payment API and receipt verification.
