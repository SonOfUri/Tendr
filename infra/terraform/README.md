# Tendr infrastructure (Terraform)

> **Not applied. Apply only when the user decides to deploy.** Tendr runs locally first
> (docker compose Postgres + Redis, `LocalKeyVault`). Nothing here has been planned or applied
> against the real GCP or Railway accounts. Do not run `terraform plan` or `terraform apply`
> against them without that decision.

Two independent stacks, applied in this order:

| Stack      | Provider                                      | Creates                                                                                                                                      |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `gcp/`     | `hashicorp/google`                            | Cloud KMS key ring `tendr-prod`, KEK `tendr-kek`, the named signing keys, service account + IAM + its JSON key, asset buckets with HMAC keys |
| `railway/` | `terraform-community-providers/railway` (0.6) | Project with `api`, `worker`, `web`, `postgres`, `redis` services, shared and per-service variables, custom domains `pay`/`app`/`api`        |

## Remote state (create once, by hand)

Both stacks keep state in the GCS bucket `tendr-tfstate` (`backend.tf`; prefix `gcp` and
`railway`). Terraform cannot keep its state in a bucket it creates, so create it once, private and
versioned, before the first `init`:

```bash
gcloud storage buckets create gs://tendr-tfstate --project=<project> --location=us-east4 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://tendr-tfstate --versioning
```

State holds every secret: the Postgres/Redis/`tendr_app` passwords, `WEB_INTERNAL_TOKEN`, the HMAC
secrets, the `tendr-api` service-account key and every key passed to Railway. Keep the bucket
private to your account; never commit state or `terraform.tfvars` (`*.tfstate` and `*.tfvars` are
gitignored; `terraform.tfvars.example` holds placeholders only).

## Validating without touching any account

Terraform is not required on the host; use the pinned image. `-backend=false` skips the GCS
backend, so nothing contacts GCP or Railway:

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

The service-account JSON key (`google_service_account_key.api`) is created by Terraform and
read from the `api_credentials_json` output (sensitive), so no key file is copied by hand. The
cost is that the private key also sits in state, which is why the state bucket stays private.

### Theme asset storage

- `tendr-assets-prod` (`var.assets_location`, default `us-east4`): uniform bucket-level access,
  `allUsers` as `roles/storage.objectViewer` (assets are public), CORS `GET`/`HEAD` from
  `https://pay.usetendr.tech` and `https://app.usetendr.tech` (response header `Content-Type`,
  max age 3600) so fonts load cross-origin.
- Service account `tendr-assets` with `roles/storage.objectAdmin` on that bucket only, and an HMAC
  key for it. The API writes through GCS's S3 interop: `ASSET_S3_ENDPOINT=https://storage.googleapis.com`,
  `ASSET_S3_REGION=auto`, `ASSET_S3_FORCE_PATH_STYLE=true`, `TENDR_ASSET_ORIGIN=https://storage.googleapis.com/tendr-assets-prod`.
- `var.dev_assets_enabled` (default `true`) adds `tendr-assets-dev`, its own service account
  `tendr-assets-dev` and HMAC key, with the same shape plus CORS for `http://localhost:3000`: local
  development uses it in place of MinIO. Its outputs are `null` when off.

Outputs: `assets_bucket`, `assets_hmac_access_id`, `assets_hmac_secret`, `dev_assets_bucket`,
`dev_assets_hmac_access_id`, `dev_assets_hmac_secret`, `api_credentials_json` (all secrets
`sensitive`).

## `railway/` — services

Authenticates with `RAILWAY_TOKEN`. Copy `terraform.tfvars.example` to `terraform.tfvars`, or
export the secrets so they never touch disk:

```bash
export TF_VAR_gcp_credentials_json="$(terraform -chdir=infra/terraform/gcp output -raw api_credentials_json)"
export TF_VAR_asset_s3_access_key_id="$(terraform -chdir=infra/terraform/gcp output -raw assets_hmac_access_id)"
export TF_VAR_asset_s3_secret_access_key="$(terraform -chdir=infra/terraform/gcp output -raw assets_hmac_secret)"
# plus TF_VAR_resend_api_key, TF_VAR_oneclick_api_key, TF_VAR_fx_api_key
```

Required inputs: `source_repo`, `gcp_project_id`, and the sensitive `gcp_credentials_json`,
`asset_s3_access_key_id`, `asset_s3_secret_access_key`, `resend_api_key`, `oneclick_api_key`,
`fx_api_key`. The hosts default to the production values (`api_base_url`, `web_url`,
`checkout_base_url`, `cors_origins`, `webauthn_rp_id`, `webauthn_origins`, `tendr_asset_origin`).

| Service    | Source                                         | Start / checks                                                                                                                                                          |
| ---------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`      | repo                                           | pre-deploy `npm run db:migrate`; start `npm run start --workspace=@tendr/api`; healthcheck `/v1/health`                                                                 |
| `worker`   | repo                                           | start `npm run start:worker --workspace=@tendr/api`; healthcheck `/health` on `WORKER_HEALTH_PORT` (4100); never migrates                                               |
| `web`      | repo                                           | build `npm ci --include=dev && npx turbo run build --filter=@tendr/web...`; start `npm run start --workspace=@tendr/web -- --port $PORT` (3000); healthcheck `/privacy` |
| `postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:16` | volume `/var/lib/postgresql/data`                                                                                                                                       |
| `redis`    | `redis:7-alpine`                               | volume `/data`, password, AOF, `maxmemory-policy noeviction` (BullMQ requires it)                                                                                       |

The community provider has no database "plugin" resource, so Postgres and Redis are image services
with volumes, as Railway's own templates are.

Custom domains (`railway_custom_domain`): the hosts of `checkout_base_url` (`pay.usetendr.tech`)
and `web_url` (`app.usetendr.tech`) on `web` (port 3000), the host of `api_base_url`
(`api.usetendr.tech`) on `api` (port 4000). The `custom_domain_dns` output lists, per domain, the
CNAME (`host_label` → `dns_record_value`) and any ownership TXT record
(`verification_host_label` → `verification_record_value`) to create at Namecheap.

Variables:

- **Shared** (project-level; a service sees only the ones it references): `NODE_ENV=production`,
  `KEYVAULT_DRIVER=gcp`, `GCP_PROJECT_ID`, `GCP_KMS_LOCATION`, `GCP_KMS_KEYRING`, `GCP_KMS_KEK`,
  `GCP_CREDENTIALS_JSON` (sensitive), `WORKER_HEALTH_PORT`, `LOG_LEVEL`, `API_BASE_URL`, `WEB_URL`,
  `CHECKOUT_BASE_URL`, `CORS_ORIGINS`, `TENDR_ASSET_ORIGIN`, `WEB_INTERNAL_TOKEN`
  (`random_password`, 48 characters). `NODE_ENV=production` with `KEYVAULT_DRIVER=gcp` is
  mandatory: env validation refuses to boot production on the local key vault.
- **api and worker** (both load the same env schema, so both get everything production
  requires): every shared variable; `REDIS_URL`; `DATABASE_URL` (the `tendr_app` URL, see below);
  `LIVE_MODE_ENABLED`, `GASLESS_LIVE_ENABLED`, `FEE_SWEEP_ENABLED` all `"false"`; `WEBAUTHN_RP_ID`,
  `WEBAUTHN_ORIGINS`; `MAIL_DRIVER=resend`, `MAIL_FROM`, `RESEND_API_KEY`; `ASSET_STORE_DRIVER=s3`
  and the `ASSET_S3_*` settings; `ONECLICK_API_KEY`; `FX_PROVIDER=openexchangerates`, `FX_API_KEY`;
  and `NEAR_PARENT_ACCOUNT_*`, `FEE_ACCOUNT_*`, `MERCHANT_ACCOUNT_CODE_HASH_*` only when the
  Terraform variable is non-empty (the API rejects an empty value; unset takes its default). The
  api also gets `DATABASE_MIGRATE_URL`, `DATABASE_APP_PASSWORD`, `API_HOST`, `API_PORT`, `PORT`;
  the worker `WORKER_HEALTH_HOST` and `PORT`.
- **web**: `NODE_ENV`, `API_BASE_URL`, `WEB_URL`, `CHECKOUT_BASE_URL`, `TENDR_ASSET_ORIGIN`,
  `WEB_INTERNAL_TOKEN` (shared references); `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WEBAUTHN_RP_ID`,
  `TENDR_CHECKOUT_BASE_URL`, `PORT=3000`; and, when non-empty, `NEXT_PUBLIC_REOWN_PROJECT_ID`,
  `NEXT_PUBLIC_EVM_FORWARDER_ADDRESS`, `NEXT_PUBLIC_TRON_FORWARDER_ADDRESS`,
  `NEXT_PUBLIC_GAS_FEE_RECIPIENTS`. `NEXT_PUBLIC_*` and `TENDR_CHECKOUT_BASE_URL` are inlined at
  build time, which is why they are service variables (present during the build).

The Chainalysis screening key is not an env var: it is a stored secret (`putSecret`, purpose
`chainalysis`), put after the first deploy (see the runbook).

### Manual steps the provider cannot do

The provider covers services, variables, the pre-deploy command and custom domains. Left by hand:

- Create the `tendr-tfstate` bucket (above) before the first `init`.
- Create the DNS records from `custom_domain_dns` at Namecheap; Railway issues the certificates
  once they resolve.
- Connect the GitHub repository to Railway (the GitHub app must see `source_repo`) before the
  first apply, or the repo-sourced services cannot build.

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
  all need. Keep `--include=dev` in every build command (api, worker, web), and confirm the first build log installs
  them.

## Postgres roles: least privilege

`db:migrate` (the api pre-deploy) runs `prisma migrate deploy` and then `prisma/roles.sql` as the
database owner, using `DATABASE_MIGRATE_URL` (falls back to `DATABASE_URL`). `roles.sql` is
idempotent: it creates the `tendr_app` login role if absent, grants `SELECT, INSERT, UPDATE, DELETE`
on all tables and `USAGE, SELECT` on all sequences in `public` (plus default privileges for tables
the owner creates later), and withholds `CREATE` on the schema, so `tendr_app` cannot change the
schema. `events` is append-only: a trigger already rejects `UPDATE`, `DELETE` and `TRUNCATE`, and
`tendr_app` also lacks those privileges. `tendr_app` has no access to `_prisma_migrations`.
If `DATABASE_APP_PASSWORD` is set the script sets the role's password from it (quoted server-side,
never logged); if unset it leaves the password alone and logs one line saying so.

Variables (Terraform sets them):

| Service  | `DATABASE_URL`                | `DATABASE_MIGRATE_URL` | `DATABASE_APP_PASSWORD`  |
| -------- | ----------------------------- | ---------------------- | ------------------------ |
| `api`    | `tendr_app` (private network) | owner (`postgres`) URL | the `tendr_app` password |
| `worker` | `tendr_app` (private network) | unset                  | unset                    |

Verify: as `tendr_app`, `UPDATE events SET type = type` and `CREATE TABLE x (id int)` must fail with
`permission denied`.
