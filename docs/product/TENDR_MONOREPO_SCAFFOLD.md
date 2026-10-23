# Tendr Monorepo — AI Agent Scaffolding Brief

## Mission

Scaffold a production-minded **Tendr** monorepo containing the web frontend/PWA, Node.js backend API, and Mintlify documentation.

**Product:** Tendr is a universal checkout layer for applications, commerce, and eventually AI agents. Merchants integrate Tendr once; customers pay with supported digital assets and networks; Tendr coordinates checkout, payment execution, verification, and merchant notifications.

**Tagline:** “One checkout. Every way to pay.”

**Brand direction:** premium, minimal fintech; deep navy, electric indigo, white, and restrained cyan. Do not make NEAR the product brand. NEAR Intents is an execution integration behind the scenes.

This task is to scaffold a coherent, runnable foundation—not to pretend that payment rails, wallet flows, or provider integrations are already production-ready.

---

## 1. Required stack

- **Monorepo:** pnpm workspaces + Turborepo.
- **Runtime:** current supported Node.js LTS; pin it in `.nvmrc` and `engines`.
- **Frontend:** Next.js App Router + TypeScript, responsive and installable PWA.
- **Backend:** Node.js + TypeScript REST API. Prefer Fastify for a small, typed service.
- **Validation/contracts:** Zod; share API schemas/types through a workspace package.
- **Database:** PostgreSQL + Prisma ORM, with initial migration and seed.
- **Jobs/queues:** define an adapter boundary for background payment watching and webhook delivery. Do not require Redis to run the basic local scaffold; document how to enable it.
- **Testing:** Vitest; API integration tests; Playwright smoke test for frontend.
- **Lint/format:** ESLint + Prettier, with shared root configuration.
- **Documentation:** Mintlify project in `/apps/docs` (Mintlify configuration and MDX pages).
- **Package manager:** pnpm; workspace dependency versions should be consistent.
- **CI:** GitHub Actions for install, lint, typecheck, tests, and build.

Use stable, mutually compatible versions. Avoid experimental features unless clearly isolated and documented.

---

## 2. Monorepo layout

Create this structure (minor improvements are acceptable if explained):

```text
tendr/
├── apps/
│   ├── web/                     # Next.js public site, merchant dashboard, demo hub
│   ├── api/                     # Node.js REST API
│   └── docs/                    # Mintlify developer documentation
├── packages/
│   ├── contracts/               # Shared Zod schemas and API DTOs
│   ├── sdk/                     # Typed TypeScript API client
│   ├── ui/                      # Shared UI components (keep framework compatibility)
│   ├── config-eslint/
│   └── config-typescript/
├── prisma/                      # Prisma schema, migrations, seed if shared DB location
├── infra/
│   ├── docker/
│   └── scripts/
├── .github/workflows/ci.yml
├── .env.example
├── .gitignore
├── .npmrc
├── .nvmrc
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.json
├── README.md
├── CONTRIBUTING.md
└── SECURITY.md
```

If Prisma belongs inside `apps/api` for cleaner service ownership, put it there and update the docs consistently. Do not duplicate schema/migrations.

### Workspace scripts

Root `package.json` should expose at least:

- `pnpm dev` — run web and API in parallel.
- `pnpm dev:web`
- `pnpm dev:api`
- `pnpm dev:docs` — Mintlify local dev command.
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm db:generate`
- `pnpm db:migrate`
- `pnpm db:seed`
- `pnpm format`
- `pnpm format:check`

Use Turbo pipelines with correct dependency ordering and caching. Ensure the README scripts actually work.

---

## 3. Frontend requirements (`apps/web`)

### Routes

Build a polished, responsive foundation with these routes:

- `/` — Tendr marketing landing page.
- `/demo` — live demo hub with four use-case experiences.
- `/demo/ecommerce`
- `/demo/fintech`
- `/demo/gaming`
- `/demo/prediction-markets`
- `/checkout/[sessionId]` — hosted checkout UI.
- `/dashboard` — basic merchant dashboard shell.
- `/dashboard/payments`
- `/dashboard/developers`
- `/privacy`
- `/terms`

If authentication is not implemented, protect no route by pretending it is secure. Mark dashboard as demo/development-only or implement a proper auth boundary. Do not ship fake auth.

### Landing page

Brand and copy:
- Headline: **One checkout. Every way to pay.**
- Subheading: “Let customers pay with supported digital assets across networks. Tendr handles the payment complexity, so your product doesn’t have to.”
- Primary CTA: **Explore the demo**
- Secondary CTA: **Build with Tendr**
- Show a convincing checkout preview, integration steps, use cases, developer API snippet, and clear FAQ.
- Explain supported assets/networks honestly. Never claim “every asset” or “every chain.”
- Include NEAR Intents in the technical/integration section, not as the dominant Tendr brand.
- Use original copy. Do not copy competitors’ landing pages.

### Demo hub

One shared checkout engine must power all four demos. Each demo has its own merchant-facing context but shares checkout/session logic.

1. **E-commerce:** product/cart → Tendr checkout → payment status → order confirmation.
2. **FinTech:** simulated financial service funding flow; clearly label any simulated balance or settlement.
3. **Gaming:** purchase an item/skin; only mark unlocked after the demo payment reaches a verified success state.
4. **Prediction markets:** simulated funding of a position only. Do not imply actual market execution or connect to a real market without a separately configured integration.

Provide two explicit modes:
- **Sandbox mode:** deterministic simulation, visibly labelled “Sandbox — no real funds move.”
- **Live mode:** only show when a real provider integration is configured and healthy. Use a server-controlled feature flag. Never simulate a transaction under a “Live” label.

Use accessible loading, empty, error, expired, pending, failed, and success states. Ensure responsive layouts and keyboard accessibility.

### PWA

Implement a proper Next.js-compatible PWA setup:
- `manifest.webmanifest` with Tendr name, short name, icons, theme/background colors, and `display: standalone`.
- App icons as placeholders with TODO notes if final brand assets are not supplied; do not invent existing asset paths.
- Service worker/offline behavior appropriate for a checkout app.
- Cache only static assets and safe public shell resources. **Never cache checkout responses, authentication data, wallet data, API secrets, or private merchant information.**
- Show an offline state; disable payment actions when offline.
- Document HTTPS requirements and local development behavior.
- Verify installability with a basic checklist. Do not claim full PWA compliance without testing.

### Frontend quality

- TypeScript strict mode.
- Use server components by default; client components only where interaction requires them.
- Use a clean, minimal visual system: deep navy `#080D1B`, electric indigo around `#4035F5`, white `#FFFFFF`, cyan accent `#16C7F7`, lavender `#C9C6FF`.
- Respect reduced motion and color contrast.
- Avoid heavy animation libraries unless needed.
- Include loading/error boundaries and a not-found page.
- Use environment variables through a single typed configuration module. Never expose server secrets through `NEXT_PUBLIC_*`.

---

## 4. Backend requirements (`apps/api`)

### API conventions

- REST API under `/v1`.
- OpenAPI specification generated from route schemas and served in development.
- Request validation and response serialization with shared Zod schemas.
- Consistent error shape, e.g. `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.
- Request ID/correlation ID for all requests.
- Structured JSON logs; redact secrets, authorization headers, wallet signatures, and personal data.
- CORS allowlist configured via environment.
- Rate limiting on public endpoints.
- Idempotency support for payment-session creation and other mutation endpoints.
- Graceful shutdown and health/readiness endpoints.
- API versioning and consistent pagination for list endpoints.
- Use UTC timestamps in ISO 8601.

### Initial endpoints

Implement functional endpoints with persistence where appropriate:

```text
GET    /health
GET    /ready
GET    /v1/openapi.json

POST   /v1/checkout/sessions
GET    /v1/checkout/sessions/:sessionId
POST   /v1/checkout/sessions/:sessionId/quote
POST   /v1/checkout/sessions/:sessionId/confirm
GET    /v1/payments/:paymentId
GET    /v1/merchants/me
GET    /v1/merchants/me/payments
POST   /v1/webhooks/endpoints
GET    /v1/webhooks/endpoints
POST   /v1/webhooks/endpoints/:endpointId/test
```

For the scaffold, implement real validation, persistence, and explicit sandbox behavior. Provider-dependent endpoints should return a clear `PROVIDER_NOT_CONFIGURED` response when not configured; do not fabricate quotes, transaction hashes, or blockchain confirmations.

Suggested create-session request:

```json
{
  "merchantReference": "order_123",
  "amount": "49.99",
  "currency": "USD",
  "description": "Demo purchase",
  "successUrl": "https://merchant.example/success",
  "cancelUrl": "https://merchant.example/cancel",
  "mode": "sandbox",
  "metadata": {}
}
```

Use decimal-safe money representation. Do not use JavaScript floating point for financial calculations. Document amount precision and currency rules.

### Core domain models

Create Prisma models for:

- `Merchant`
- `ApiKey` (store a one-way hash; reveal the raw key once only if key issuance is implemented)
- `CheckoutSession`
- `Payment`
- `Quote`
- `WebhookEndpoint`
- `WebhookDelivery`
- `IdempotencyKey`
- `AuditEvent`

Include created/updated timestamps, unique constraints, indexes, and ownership relations. Use soft deletion only where it makes sense. Store monetary amounts as decimal strings/Decimal or integer minor units, not floating point.

### Checkout/payment state machine

Use explicit allowed transitions and test them:

```text
CREATED → AWAITING_PAYMENT → PROCESSING → SETTLED
                     ↘ EXPIRED
                     ↘ FAILED
PROCESSING → REFUND_PENDING → REFUNDED
```

Adjust transitions only with a written rationale. Never allow the browser to mark a payment as settled. Only a trusted server-side provider/verifier or an explicitly labelled sandbox simulator may do so.

Separate **checkout session state** from **on-chain payment state**. Persist state-change events for auditability. Prevent duplicate settlement handling.

### Provider architecture

Define interfaces/adapters, not fake implementations:

- `PaymentProvider`
- `QuoteProvider`
- `PaymentVerifier`
- `WebhookSigner`
- `WebhookTransport`

Implement:
1. A deterministic `SandboxPaymentProvider` that cannot be enabled accidentally in live mode.
2. A `NearIntentsProvider` adapter boundary with typed methods, configuration validation, and TODOs linking to the current official NEAR Intents documentation.
3. A verifier boundary for transaction/status verification.

Do not invent NEAR API endpoints, payload fields, authentication details, or guarantees. Before implementing the live adapter, have the agent consult official current documentation and record exact API versions, request/response examples, supported assets/networks, and limitations in `docs`/an ADR. Keep provider credentials server-side. Feature-flag live payments off by default.

### Webhooks

- HMAC-sign outgoing webhook bodies with per-endpoint secrets.
- Include timestamp and event ID in signed headers.
- Provide a documented verification example in the SDK/docs.
- Retry transient failures with exponential backoff and jitter; cap retries.
- Make delivery idempotent and observable.
- Never include secret material or sensitive user data in webhook payloads.
- Events to define: `checkout.session.created`, `payment.pending`, `payment.processing`, `payment.settled`, `payment.failed`, `payment.expired`, `payment.refunded`.
- Webhook creation must validate HTTPS in production, except explicitly allowed local test destinations in development.

### Security baseline

- Secrets via environment/secret manager; never commit `.env`.
- Strict CORS and request-size limits.
- Input validation on every boundary.
- Authentication and merchant authorization must be explicit. If full auth is out of scope, clearly mark merchant dashboard/API-key management as local demo-only; do not imply production-ready access control.
- Avoid logging personal data or payment credentials.
- Validate callback URLs to mitigate SSRF/open redirect risks. Use a URL allowlist or strict scheme/host rules.
- Enforce idempotency keys and database uniqueness for critical mutations.
- Never store seed phrases or private wallet keys.
- No arbitrary “merchant full-access” keys in the browser.
- Add `SECURITY.md` with reporting guidance and known scaffold limitations.

---

## 5. Shared packages

### `packages/contracts`

- Shared enums, Zod request/response schemas, error schemas, pagination, checkout/payment states, webhook event types.
- Export TypeScript types inferred from Zod.
- Avoid importing server-only code into the frontend.

### `packages/sdk`

Create a typed `TendrClient` with:
- Configurable `baseUrl` and API key.
- Methods for checkout sessions, quote retrieval, payment status, and webhook signature verification helper (Node-only verification should be separated from browser-safe code).
- Typed errors and timeout/abort support.
- No secret API key embedded in client-side browser bundles.
- Unit tests and README examples.

### `packages/ui`

Create reusable UI primitives or a small design system if it can be shared cleanly. Do not force Next.js server-only dependencies into shared UI. At minimum, define tokens and shared components for buttons, cards, status badges, alerts, form fields, and loading indicators.

---

## 6. Mintlify documentation (`apps/docs`)

Set up Mintlify according to its current official documentation and configuration format. Include the correct `docs.json`, MDX pages, navigation, and local dev instructions. Do not use an outdated config schema without checking.

Suggested documentation structure:

```text
apps/docs/
├── docs.json
├── introduction.mdx
├── quickstart.mdx
├── concepts/
│   ├── checkout-sessions.mdx
│   ├── quotes-and-expiry.mdx
│   ├── payment-lifecycle.mdx
│   ├── sandbox-vs-live.mdx
│   └── idempotency.mdx
├── api-reference/
│   ├── overview.mdx
│   ├── create-checkout-session.mdx
│   ├── retrieve-checkout-session.mdx
│   ├── create-quote.mdx
│   ├── retrieve-payment.mdx
│   └── webhooks.mdx
├── sdks/
│   └── typescript.mdx
├── integrations/
│   ├── ecommerce.mdx
│   ├── gaming.mdx
│   ├── fintech.mdx
│   └── near-intents.mdx
├── security/
│   ├── api-keys.mdx
│   ├── webhook-signatures.mdx
│   └── production-checklist.mdx
└── development/
    ├── local-setup.mdx
    └── troubleshooting.mdx
```

Docs requirements:
- Clearly distinguish implemented features, sandbox simulations, planned work, and live provider features.
- Use copy-pasteable request/response examples that match actual schemas.
- Document error codes, idempotency, quote expiration, payment lifecycle, webhook retry semantics, and verification requirements.
- Do not advertise a live integration before it exists.
- Add Mintlify link checking or a documented manual validation step.
- Include a clear “Sandbox only — no real funds move” warning wherever relevant.

---

## 7. Environment and local development

Create `.env.example` with safe placeholders, e.g.:

```dotenv
NODE_ENV=development
API_PORT=4000
API_BASE_URL=http://localhost:4000
WEB_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tendr
CORS_ORIGINS=http://localhost:3000
LOG_LEVEL=debug
CHECKOUT_LIVE_ENABLED=false
PAYMENT_PROVIDER=sandbox
NEAR_INTENTS_API_BASE_URL=
NEAR_INTENTS_API_KEY=
WEBHOOK_SIGNING_SECRET=
```

Validate environment variables at startup and fail with a clear message for missing required values. Do not require NEAR credentials for sandbox development. Do not include real credentials.

Provide Docker Compose for local PostgreSQL. Redis should be optional until the queue adapter is enabled. Include a seed script that creates clearly named demo data without production credentials.

README should include exact commands for:
1. Install dependencies.
2. Start local database.
3. Copy `.env.example` to `.env`.
4. Run migrations and seed.
5. Start web/API/docs.
6. Run tests and lint/typecheck.
7. Explain sandbox behavior and how to enable a future provider integration safely.

---

## 8. Testing and acceptance criteria

The scaffold is complete only when all applicable criteria pass:

- [ ] Clean install from repository root succeeds with pnpm.
- [ ] `pnpm dev` starts frontend and API without requiring live provider credentials.
- [ ] Mintlify docs start using the documented command.
- [ ] Landing page renders and is responsive.
- [ ] All four demo routes load and share the same checkout component/flow.
- [ ] Sandbox mode is clearly labelled and cannot be confused with real settlement.
- [ ] Session creation and retrieval persist to PostgreSQL.
- [ ] Input validation rejects malformed amounts, invalid URLs, and unsupported modes.
- [ ] API returns stable typed errors and request IDs.
- [ ] Idempotency prevents duplicate session creation for the same merchant/key.
- [ ] State machine rejects invalid transitions and browser-originated settlement.
- [ ] Webhook signature verification has tests.
- [ ] API and frontend have smoke tests.
- [ ] Lint, typecheck, unit tests, and production builds pass.
- [ ] No secrets are committed or exposed in client bundles.
- [ ] PWA manifest is valid; offline behavior never suggests a payment succeeded.
- [ ] OpenAPI and Mintlify examples match implemented endpoints.
- [ ] `README.md` accurately describes what is implemented vs. planned.

---

## 9. Agent execution plan

Work in small, verifiable phases. Do not stop after creating folders and placeholder files.

### Phase 1 — Inspect and plan
- Inspect the existing repository before making changes.
- Preserve existing user work; do not overwrite blindly.
- Write a short implementation plan and list assumptions.
- Check current official docs for Next.js, pnpm/Turborepo, Prisma, Fastify, Mintlify, and NEAR Intents before choosing configuration/API specifics.

### Phase 2 — Workspace foundation
- Create workspace, shared configs, scripts, formatting, lint, typecheck, CI, env validation, Docker Compose, and root README.

### Phase 3 — API and data model
- Implement health/readiness, Prisma schema/migration/seed, checkout-session CRUD, validation, error handling, idempotency, and state machine.
- Add unit/integration tests.
- Keep live payments disabled.

### Phase 4 — Web/PWA
- Build design tokens and shared UI.
- Implement marketing page, demo hub, four demos, hosted checkout, and dashboard shell.
- Connect sandbox demos to the actual local API instead of hardcoding success in UI.
- Add PWA setup and safe offline behavior.

### Phase 5 — SDK and docs
- Implement the typed SDK against the actual API.
- Generate OpenAPI from actual routes.
- Write Mintlify docs based on real implementation and test examples.

### Phase 6 — Verify
- Run all scripts.
- Fix failures instead of merely reporting them.
- Check generated bundles for leaked secrets.
- Summarize commands run, tests passed, limitations, and next steps.

If a command fails due to environment limitations, report the exact failure and the remaining manual action. Never claim a test passed unless it was actually run.

---

## 10. Explicit non-goals for the initial scaffold

Do **not** silently implement or claim:
- Production payment settlement or universal chain/token support.
- A complete NEAR Intents live integration without verifying the current official API.
- Custody, private-key storage, or seed phrase handling.
- Production merchant identity verification, KYC/AML, sanctions screening, or legal compliance.
- Real prediction-market execution.
- Real game inventory fulfillment.
- Production-ready authentication merely to make the dashboard appear protected.
- Actual fiat settlement or guaranteed atomic settlement.
- Production readiness just because the project builds.

Create clear adapter interfaces and TODOs for these areas.

---

## Final instruction to the coding agent

Scaffold the full monorepo, implement the runnable sandbox vertical slice end-to-end, and verify it. Prioritize maintainability, truthful product states, security boundaries, and consistent contracts over excessive abstraction.

At the end, provide:
1. The resulting directory tree.
2. Key architectural decisions.
3. Exact setup and run commands.
4. Test/build results.
5. What is genuinely implemented.
6. What remains before enabling real NEAR Intents payments.
