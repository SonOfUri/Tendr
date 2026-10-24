# Tendr

**One checkout. Every way to pay.**

Tendr is a universal checkout and payment-orchestration layer for digital commerce. Merchants integrate once; customers pay with supported digital assets; Tendr coordinates checkout, verification, and merchant notifications.

NEAR Intents is an optional execution integration behind the scenes—not the Tendr brand.

> **Scaffold status:** runnable **sandbox** vertical slice. Live settlement and production auth are **not** implemented.

## Monorepo layout

```text
Tendr/
├── apps/web          # Next.js App Router + PWA
├── apps/api          # Fastify REST /v1
├── apps/docs         # Mintlify docs
├── packages/contracts|sdk|ui|config-*
├── apps/api/prisma   # schema, migrations, seed
└── infra/docker      # Postgres (host port 5433)
```

## What is implemented

- Checkout sessions, quotes, confirm, payment status (sandbox)
- PostgreSQL persistence via Prisma
- Idempotency, request IDs, typed errors, webhook HMAC signing
- Four demo experiences sharing one checkout engine
- Typed TypeScript SDK + Mintlify docs
- Adapter boundary for NEAR Intents (not live)

## What is not implemented

- Live NEAR Intents payment settlement
- Custody / private keys
- Production merchant auth / KYC
- Real prediction-market or game inventory fulfillment
- Fiat settlement

## Quick start

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d
npm install
npm run build --workspace=@tendr/contracts
npm run build --workspace=@tendr/sdk
npm run build --workspace=@tendr/ui
npm run db:generate
npm run db:migrate
npm run db:seed          # prints DEMO_MERCHANT_API_KEY — paste into .env
npm run dev
```

Local Postgres is on **host port 5433** (see `.env.example`) so it does not collide with other local databases on 5432.

- Web: http://localhost:3000  
- API: http://localhost:4000 (or set `API_PORT` / `API_HOST` if Windows blocks the port — try `18080`)  
- Docs: `npm run dev:docs` (Mintlify via `npx`)

### Windows notes

- Prefer **npm** workspaces on Windows without Developer Mode (pnpm needs symlink privileges).
- If `listen EACCES` occurs on `API_PORT`, Windows may have excluded that port range — set `API_PORT=18080` and matching `API_BASE_URL` / `NEXT_PUBLIC_API_BASE_URL`.
- API defaults to `API_HOST=127.0.0.1`.

Seed prints a demo merchant API key. Prefer calling the API from Next.js server routes; never embed secret keys in client bundles.

## Sandbox vs live

| Mode | Behavior |
| --- | --- |
| Sandbox (default) | Deterministic simulation. Labelled **Sandbox — no real funds move.** |
| Live | Only when `CHECKOUT_LIVE_ENABLED=true` and a real provider is configured and healthy. Off by default. |

## Judge demo path

1. Open http://localhost:3000 → **Explore the demo**
2. Pick E-commerce → create sandbox checkout → authorize payment
3. See pending → settled states driven by the API (not the browser)

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Web + API (Turbo) |
| `npm run dev:docs` | Mintlify docs |
| `npm run build` / `lint` / `typecheck` / `test` | CI gates |
| `npm run test:e2e` | Playwright smoke |
| `npm run db:migrate` / `db:seed` | Database |

## Enabling NEAR Intents later

1. Read https://docs.near-intents.org/ and record API versions in docs/ADR
2. Implement `NearIntentsProvider` methods (no invented fields)
3. Set provider credentials server-side only
4. Feature-flag with `CHECKOUT_LIVE_ENABLED` after verifier tests pass

## Product docs

See `docs/product/INTRO_TO_TENDR.md` and `docs/product/TENDR_MONOREPO_SCAFFOLD.md`.

## License

Proprietary / hackathon use unless otherwise stated.
