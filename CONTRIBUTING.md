# Contributing to Tendr

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- npm 10+ (the repo uses npm workspaces and `package-lock.json`)
- Docker (for local PostgreSQL and Redis)

## Setup

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d
npm install
npm run build --workspace=@tendr/contracts
npm run db:migrate:dev --workspace=@tendr/api
npm run db:migrate:test --workspace=@tendr/api
npm run db:seed
npm run dev
```

The seed prints the Demo Merchant's API keys once (`tdr_test_…`, `tdr_live_…`, `tdr_pk_test_…`,
`tdr_pk_live_…`). Keep them somewhere local; they are stored only as hashes.

Before pushing, run the CI gates: `npm run lint && npm run typecheck && npm test && npm run build`.

## Guidelines

- Prefer shared Zod schemas in `@tendr/contracts` over duplicated types.
- Route handlers use the scoped client on `req.db`; only infrastructure code uses the unscoped
  `prisma` client.
- Keep test and live modes separate: every per-mode row carries `livemode`.
- Do not invent NEAR Intents API fields; consult official docs before live adapters.
- Add tests for state-machine, idempotency and scoping changes.
