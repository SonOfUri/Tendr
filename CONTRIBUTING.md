# Contributing to Tendr

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- npm 10+ (recommended on Windows). pnpm also works on Linux/macOS or Windows with Developer Mode.
- Docker (for local PostgreSQL)

## Setup

```bash
cd Tendr
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d
npm install
npm run build --workspace=@tendr/contracts
npm run build --workspace=@tendr/sdk
npm run build --workspace=@tendr/ui
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Paste the printed `DEMO_MERCHANT_API_KEY` into `.env`.

## Guidelines

- Prefer shared Zod schemas in `@tendr/contracts` over duplicated types.
- Keep sandbox vs live payment modes honest and labelled.
- Do not invent NEAR Intents API fields; consult official docs before live adapters.
- Add tests for state-machine and idempotency changes.
