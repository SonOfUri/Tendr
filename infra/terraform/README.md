# Tendr infrastructure (Terraform)

> **Not applied. Apply only when the user decides to deploy.** Tendr runs locally first
> (docker compose Postgres + Redis, `LocalKeyVault`). Nothing here has been planned or applied
> against the real GCP or Railway accounts. Do not run `terraform plan` or `terraform apply`
> against them without that decision.

Two independent stacks, applied in this order:

| Stack      | Provider                                      | Creates                                                                                         |
| ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `gcp/`     | `hashicorp/google`                            | Cloud KMS key ring `tendr-prod`, KEK `tendr-kek`, the named signing keys, service account + IAM |
| `railway/` | `terraform-community-providers/railway` (0.6) | Project with `api`, `worker`, `postgres`, `redis` services, shared and per-service variables    |

Neither stack configures a remote backend. Pick one (e.g. a GCS bucket) before the first apply;
state contains the Postgres/Redis passwords and `GCP_CREDENTIALS_JSON`, so it must not live in git
(`*.tfstate` and `*.tfvars` are gitignored).

## Validating without touching any account

Terraform is not required on the host; use the pinned image:

```bash
docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf hashicorp/terraform:1.9.8 fmt -check -recursive
docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf/gcp hashicorp/terraform:1.9.8 init -backend=false
docker run --rm -v "$PWD/infra/terraform:/tf" -w /tf/gcp hashicorp/terraform:1.9.8 validate
# same two commands with -w /tf/railway
```

## `gcp/` — keys and identity

- Key ring `tendr-prod` (location `var.location`, default `us-east4`). Cloud HSM keys are not
  offered in the `global` location, so the key ring must be regional. Keep the Railway region
  (`region`, default `us-east4-eqdc4a`) close to it: every secret decrypt and signature is a KMS
  round trip.
- `tendr-kek`: symmetric `ENCRYPT_DECRYPT`, rotated every 90 days. Envelope encryption for stored
  secrets.
- Signing keys (`ASYMMETRIC_SIGN`, never exported):
  - `relayer-near`, `funding-near`, `relayer-accounts`, `solver-hot` — `EC_SIGN_ED25519`
    (`relayer-accounts` pays gas for merchant account contract calls and can move no funds; its
    NEAR implicit account, the hex of its public key, is funded out of band)
  - `relayer-evm`, `gas-tron` — `EC_SIGN_SECP256K1_SHA256`
  - `gas-fees-evm`, `gas-fees-tron` — `EC_SIGN_SECP256K1_SHA256`; `gas-fees-near`,
    `gas-fees-solana` — `EC_SIGN_ED25519`. Receive-only accounts for shopper-paid network fees
    (one `gas-fees-evm` address on every EVM chain); only the fee sweep job signs with them, to
    swap collected fees to USDC. Kept apart from the relayer keys.
  - No EVM or Solana gas-paying keys: that sponsorship goes through Pimlico (an API key stored as a
    secret).
- `protection_level` defaults to `HSM`. If Cloud KMS rejects an algorithm at HSM level in the chosen
  location, set a per-key fallback in `protection_level_overrides` (e.g.
  `{ "relayer-near" = "SOFTWARE" }`). Run `npm run kms:verify --workspace=@tendr/api` first, with
  `GCP_KMS_LOCATION` set to the same location as `var.location` (HSM availability differs by
  location): it checks both curves against real Cloud KMS and reports which protection level
  worked.
- Service account `tendr-api`: `roles/cloudkms.cryptoKeyEncrypterDecrypter` on `tendr-kek` only, and
  `roles/cloudkms.signerVerifier` + `roles/cloudkms.publicKeyViewer` on each signing key. No
  project-level roles.
- Every key has `prevent_destroy`. Cloud KMS keys cannot be deleted anyway (only their versions are
  scheduled for destruction), and losing a signing key loses the on-chain account it controls.

The service-account JSON key is created outside Terraform so it never enters state:

```bash
gcloud iam service-accounts keys create tendr-api.json \
  --iam-account "$(terraform -chdir=infra/terraform/gcp output -raw service_account_email)"
```

Pass its contents as `gcp_credentials_json` to the Railway stack (e.g. `TF_VAR_gcp_credentials_json`),
then delete the local file.

## `railway/` — services

Authenticates with `RAILWAY_TOKEN`. Required inputs: `source_repo`, `api_base_url`, `web_url`,
`cors_origins`, `gcp_project_id`, `gcp_credentials_json` (sensitive).

| Service    | Source                                         | Start / checks                                                                                            |
| ---------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `api`      | repo                                           | pre-deploy `npm run db:migrate`; start `npm run start --workspace=@tendr/api`; healthcheck `/v1/health`   |
| `worker`   | repo                                           | start `npm run start:worker --workspace=@tendr/api`; healthcheck `/health` on `WORKER_HEALTH_PORT` (4100) |
| `postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:16` | volume `/var/lib/postgresql/data`                                                                         |
| `redis`    | `redis:7-alpine`                               | volume `/data`, password, AOF, `maxmemory-policy noeviction` (BullMQ requires it)                         |

The community provider has no database "plugin" resource, so Postgres and Redis are image services
with volumes, as Railway's own templates are.

Shared variables: `NODE_ENV=production`, `KEYVAULT_DRIVER=gcp`, `GCP_PROJECT_ID`,
`GCP_KMS_LOCATION`, `GCP_KMS_KEYRING`, `GCP_KMS_KEK`, `GCP_CREDENTIALS_JSON` (sensitive),
`WORKER_HEALTH_PORT`, `LOG_LEVEL`, `API_BASE_URL`, `WEB_URL`, `CORS_ORIGINS`. `NODE_ENV=production`
with `KEYVAULT_DRIVER=gcp` is mandatory: env validation refuses to boot production on the local key
vault. `DATABASE_URL` and `REDIS_URL` are per-service references to the `postgres` and `redis`
services over private networking.

### Check before the first deploy

- **`X-Forwarded-For`.** The API trusts exactly one proxy hop (`trustProxy` in `apps/api/src/app.ts`)
  and takes the client IP from the last `X-Forwarded-For` entry. Verify Railway's edge _appends_ the
  connecting address to `X-Forwarded-For` (or replaces the header) rather than passing a client's
  header through untouched: send a request with a forged `X-Forwarded-For: 1.2.3.4` and log `req.ip`
  — it must be your real address. If it is `1.2.3.4`, clients can pick their IP and dodge per-IP
  limits. If Railway puts more than one proxy hop in front of the service, the trusted hop count in
  `app.ts` must change to match.
- **Health check vs rate limit.** `/v1/health` is limited to 60 requests/min per IP. Railway's
  healthcheck polls during deploys; confirm its probe frequency (and whether all probes share one
  source IP) stays well under that, or exempt the health route from the per-IP limit.
- **Build command.** `npm ci --include=dev && npm run db:generate && npx turbo run build --filter=@tendr/api...`
  builds the API and its workspace dependencies. Confirm Railway's Nixpacks/Railpack picks Node 22.
- **Dev dependencies at build time.** Railway exposes service variables (including
  `NODE_ENV=production`) during the build, and a plain `npm ci` then skips devDependencies — turbo,
  typescript, prisma, dotenv-cli — which the build, `db:generate` and the pre-deploy `db:migrate`
  all need. Keep `--include=dev` in both build commands, and confirm the first build log installs
  them.

## Postgres roles: least privilege on `events`

`events` is append-only. A trigger already rejects `UPDATE`, `DELETE` and `TRUNCATE`; in production
the runtime role should also lack those privileges, so the guarantee does not rest on the trigger
alone. Migrations run as the owner (`postgres`), the services as `tendr_app`.

After the first deploy (migrations applied by the owner), connect as `postgres` and run:

```sql
CREATE ROLE tendr_app LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE tendr TO tendr_app;
GRANT USAGE ON SCHEMA public TO tendr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tendr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tendr_app;
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM tendr_app;
REVOKE ALL ON _prisma_migrations FROM tendr_app;
-- Tables created by later migrations (run as postgres) get the same grants:
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tendr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tendr_app;
```

Then:

1. Add `MIGRATION_DATABASE_URL = ${{postgres.DATABASE_URL}}` (the owner URL) to the `api` service.
2. Point `DATABASE_URL` on `api` and `worker` at
   `postgresql://tendr_app:<password>@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/tendr`.
3. Change the `api` pre-deploy to run migrations as the owner:
   `sh -c 'DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:migrate'` (`dotenv-cli` does not
   override variables already set).
4. Mirror these three changes in `railway/main.tf` so the next apply does not revert them.

Verify: as `tendr_app`, `UPDATE events SET type = type` must fail with `permission denied`.
