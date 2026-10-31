# Railway project for Tendr production: api, worker, web, Postgres and Redis on private
# networking, plus the custom domains pay/app (web) and api (api).
#
# NOT APPLIED. Apply only when the user decides to deploy — see ../README.md.
#
# The community provider has no "plugin" resource, so Postgres and Redis are image services
# with volumes, as Railway's own database templates are. `$${{service.VAR}}` is Railway's
# reference-variable syntax (the `$$` escapes Terraform interpolation).

terraform {
  required_version = ">= 1.6"

  required_providers {
    railway = {
      source  = "terraform-community-providers/railway"
      version = "~> 0.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Authenticates with the RAILWAY_TOKEN environment variable.
provider "railway" {}

resource "railway_project" "tendr" {
  name         = var.project_name
  workspace_id = var.workspace_id
  private      = true
}

locals {
  environment_id = railway_project.tendr.default_environment.id
  regions        = [{ region = var.region, num_replicas = 1 }]

  # Host names of the public URLs: the custom domains are derived from the same variables the
  # services read, so they cannot drift apart.
  pay_host = regex("^https://([^/:]+)", var.checkout_base_url)[0]
  app_host = regex("^https://([^/:]+)", var.web_url)[0]
  api_host = regex("^https://([^/:]+)", var.api_base_url)[0]

  api_port = 4000
  web_port = 3000
}

# ---------------------------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------------------------

resource "random_password" "postgres" {
  length  = 32
  special = false
}

# Password of the least-privilege `tendr_app` role (DATABASE_APP_PASSWORD); the api's pre-deploy
# `db:migrate` sets it on the role (apps/api/scripts/db-migrate.ts). Alphanumeric so it can sit in
# a connection URL unescaped. var.database_app_password overrides it.
resource "random_password" "database_app" {
  length  = 32
  special = false
}

resource "random_password" "redis" {
  length  = 32
  special = false
}

locals {
  database_app_password = var.database_app_password != null ? var.database_app_password : random_password.database_app.result
}

resource "railway_service" "postgres" {
  name         = "postgres"
  project_id   = railway_project.tendr.id
  source_image = "ghcr.io/railwayapp-templates/postgres-ssl:16"
  regions      = local.regions

  volume = {
    name       = "postgres-data"
    mount_path = "/var/lib/postgresql/data"
  }
}

resource "railway_variable_collection" "postgres" {
  environment_id = local.environment_id
  service_id     = railway_service.postgres.id

  variables = [
    { name = "POSTGRES_USER", value = "postgres" },
    { name = "POSTGRES_PASSWORD", value = random_password.postgres.result },
    { name = "POSTGRES_DB", value = "tendr" },
    { name = "PGDATA", value = "/var/lib/postgresql/data/pgdata" },
    # Owner connection: only the api's pre-deploy migrations use it (DATABASE_MIGRATE_URL).
    {
      name  = "DATABASE_URL"
      value = "postgresql://postgres:${random_password.postgres.result}@$${{RAILWAY_PRIVATE_DOMAIN}}:5432/tendr"
    },
    # Least-privilege runtime connection for the api and worker (role created by db:migrate).
    {
      name  = "APP_DATABASE_URL"
      value = "postgresql://tendr_app:${local.database_app_password}@$${{RAILWAY_PRIVATE_DOMAIN}}:5432/tendr"
    },
  ]
}

resource "railway_service" "redis" {
  name         = "redis"
  project_id   = railway_project.tendr.id
  source_image = "redis:7-alpine"
  regions      = local.regions
  # BullMQ requires noeviction; AOF so queued jobs survive restarts.
  start_command = "/bin/sh -c \"exec redis-server --requirepass $REDIS_PASSWORD --appendonly yes --dir /data --maxmemory-policy noeviction\""

  volume = {
    name       = "redis-data"
    mount_path = "/data"
  }
}

resource "railway_variable_collection" "redis" {
  environment_id = local.environment_id
  service_id     = railway_service.redis.id

  variables = [
    { name = "REDIS_PASSWORD", value = random_password.redis.result },
    {
      name  = "REDIS_URL"
      value = "redis://default:${random_password.redis.result}@$${{RAILWAY_PRIVATE_DOMAIN}}:6379"
    },
  ]
}

# ---------------------------------------------------------------------------------------------
# Shared variables: origins, NODE_ENV, GCP/KMS. NODE_ENV=production and KEYVAULT_DRIVER=gcp are
# required: env validation refuses to boot production with the local key vault. A service only
# sees a shared variable it references, so the web never gets the GCP credentials.
# ---------------------------------------------------------------------------------------------

locals {
  shared_variables = {
    NODE_ENV           = "production"
    KEYVAULT_DRIVER    = "gcp"
    GCP_PROJECT_ID     = var.gcp_project_id
    GCP_KMS_LOCATION   = var.gcp_kms_location
    GCP_KMS_KEYRING    = var.gcp_kms_keyring
    GCP_KMS_KEK        = var.gcp_kms_kek
    WORKER_HEALTH_PORT = tostring(var.worker_health_port)
    LOG_LEVEL          = var.log_level
    API_BASE_URL       = var.api_base_url
    WEB_URL            = var.web_url
    CHECKOUT_BASE_URL  = var.checkout_base_url
    CORS_ORIGINS       = var.cors_origins
    TENDR_ASSET_ORIGIN = var.tendr_asset_origin
  }
}

resource "railway_shared_variable" "config" {
  for_each = local.shared_variables

  environment_id = local.environment_id
  project_id     = railway_project.tendr.id
  name           = each.key
  value          = each.value
}

resource "railway_shared_variable" "gcp_credentials_json" {
  environment_id = local.environment_id
  project_id     = railway_project.tendr.id
  name           = "GCP_CREDENTIALS_JSON"
  value          = var.gcp_credentials_json
}

# The web server sends it as `x-tendr-internal` on payment-link reads; the API (and the worker,
# which validates the same env) requires the same value in production (>= 32 characters).
resource "random_password" "web_internal_token" {
  length  = 48
  special = false
}

resource "railway_shared_variable" "web_internal_token" {
  environment_id = local.environment_id
  project_id     = railway_project.tendr.id
  name           = "WEB_INTERNAL_TOKEN"
  value          = random_password.web_internal_token.result
}

# ---------------------------------------------------------------------------------------------
# Application services (same repo, three processes)
# ---------------------------------------------------------------------------------------------

resource "railway_service" "api" {
  name               = "api"
  project_id         = railway_project.tendr.id
  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  regions            = local.regions

  build_command = "npm ci --include=dev && npm run db:generate && npx turbo run build --filter=@tendr/api..."
  # Migrations run here only, as the owner (DATABASE_MIGRATE_URL); the worker never migrates.
  predeploy_command = "npm run db:migrate"
  start_command     = "npm run start --workspace=@tendr/api"

  healthcheck_path    = "/v1/health"
  healthcheck_timeout = 60
}

resource "railway_service" "worker" {
  name               = "worker"
  project_id         = railway_project.tendr.id
  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  regions            = local.regions

  build_command = "npm ci --include=dev && npm run db:generate && npx turbo run build --filter=@tendr/api..."
  start_command = "npm run start:worker --workspace=@tendr/api"

  # The worker's health server listens on WORKER_HEALTH_PORT; PORT points Railway's check at it.
  healthcheck_path    = "/health"
  healthcheck_timeout = 60
}

resource "railway_service" "web" {
  name               = "web"
  project_id         = railway_project.tendr.id
  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  regions            = local.regions

  # The build runs `prebuild` (build:embed and the font copy). NEXT_PUBLIC_* and
  # TENDR_CHECKOUT_BASE_URL are inlined at build time, so they are service variables.
  build_command = "npm ci --include=dev && npx turbo run build --filter=@tendr/web..."
  # The package's `start` script passes --port 3000; the later --port wins.
  start_command = "npm run start --workspace=@tendr/web -- --port $PORT"

  # A static page that does not call the API, so a web deploy never waits on the api.
  healthcheck_path    = "/privacy"
  healthcheck_timeout = 60
}

locals {
  # Railway resolves shared variables into a service only when the service references them.
  shared_reference = { for name in concat(keys(local.shared_variables), ["GCP_CREDENTIALS_JSON", "WEB_INTERNAL_TOKEN"]) :
    name => { name = name, value = "$${{shared.${name}}}" }
  }

  # Optional settings: set only when non-empty. The API's env validation rejects an empty
  # MERCHANT_ACCOUNT_CODE_HASH_* (not base58 of 32 bytes), NEAR_PARENT_ACCOUNT_* (min length) and
  # FEE_ACCOUNT_* (not a NEAR account id), and an unset one takes the code's default.
  near_optional = {
    NEAR_PARENT_ACCOUNT_LIVE        = var.near_parent_account_live
    NEAR_PARENT_ACCOUNT_TEST        = var.near_parent_account_test
    FEE_ACCOUNT_LIVE                = var.fee_account_live
    FEE_ACCOUNT_TEST                = var.fee_account_test
    MERCHANT_ACCOUNT_CODE_HASH_LIVE = var.merchant_account_code_hash_live
    MERCHANT_ACCOUNT_CODE_HASH_TEST = var.merchant_account_code_hash_test
  }

  # api and worker load the same env schema, so both get every setting it requires in production.
  app_variables = concat(
    values(local.shared_reference),
    [
      { name = "REDIS_URL", value = "$${{redis.REDIS_URL}}" },
      { name = "DATABASE_URL", value = "$${{postgres.APP_DATABASE_URL}}" },
      # Platform switches (deploy spec §6): live mode, live gasless and the fee sweep stay off.
      { name = "LIVE_MODE_ENABLED", value = "false" },
      { name = "GASLESS_LIVE_ENABLED", value = "false" },
      { name = "FEE_SWEEP_ENABLED", value = "false" },
      # Dashboard sign-in.
      { name = "WEBAUTHN_RP_ID", value = var.webauthn_rp_id },
      { name = "WEBAUTHN_ORIGINS", value = var.webauthn_origins },
      # Mail (Resend).
      { name = "MAIL_DRIVER", value = "resend" },
      { name = "MAIL_FROM", value = var.mail_from },
      { name = "RESEND_API_KEY", value = var.resend_api_key },
      # Theme assets: GCS through its S3 interop (spec §4).
      { name = "ASSET_STORE_DRIVER", value = "s3" },
      { name = "ASSET_S3_ENDPOINT", value = "https://storage.googleapis.com" },
      { name = "ASSET_S3_REGION", value = "auto" },
      { name = "ASSET_S3_FORCE_PATH_STYLE", value = "true" },
      { name = "ASSET_S3_BUCKET", value = var.asset_s3_bucket },
      { name = "ASSET_S3_ACCESS_KEY_ID", value = var.asset_s3_access_key_id },
      { name = "ASSET_S3_SECRET_ACCESS_KEY", value = var.asset_s3_secret_access_key },
      # 1Click and FX.
      { name = "ONECLICK_API_KEY", value = var.oneclick_api_key },
      { name = "FX_PROVIDER", value = "openexchangerates" },
      { name = "FX_API_KEY", value = var.fx_api_key },
    ],
    [for name, value in local.near_optional : { name = name, value = value } if value != ""],
  )

  web_optional = {
    NEXT_PUBLIC_REOWN_PROJECT_ID       = var.next_public_reown_project_id
    NEXT_PUBLIC_EVM_FORWARDER_ADDRESS  = var.next_public_evm_forwarder_address
    NEXT_PUBLIC_TRON_FORWARDER_ADDRESS = var.next_public_tron_forwarder_address
    NEXT_PUBLIC_GAS_FEE_RECIPIENTS     = var.next_public_gas_fee_recipients
  }
}

resource "railway_variable_collection" "api" {
  environment_id = local.environment_id
  service_id     = railway_service.api.id

  variables = concat(local.app_variables, [
    # Owner URL for the pre-deploy `db:migrate` only; it then sets the tendr_app password.
    { name = "DATABASE_MIGRATE_URL", value = "$${{postgres.DATABASE_URL}}" },
    { name = "DATABASE_APP_PASSWORD", value = local.database_app_password },
    { name = "API_HOST", value = "0.0.0.0" },
    { name = "API_PORT", value = tostring(local.api_port) },
    { name = "PORT", value = tostring(local.api_port) },
  ])

  depends_on = [
    railway_shared_variable.config,
    railway_shared_variable.gcp_credentials_json,
    railway_shared_variable.web_internal_token,
  ]
}

resource "railway_variable_collection" "worker" {
  environment_id = local.environment_id
  service_id     = railway_service.worker.id

  # Only the tendr_app URL: no owner URL, no role password.
  variables = concat(local.app_variables, [
    { name = "WORKER_HEALTH_HOST", value = "0.0.0.0" },
    { name = "PORT", value = tostring(var.worker_health_port) },
  ])

  depends_on = [
    railway_shared_variable.config,
    railway_shared_variable.gcp_credentials_json,
    railway_shared_variable.web_internal_token,
  ]
}

resource "railway_variable_collection" "web" {
  environment_id = local.environment_id
  service_id     = railway_service.web.id

  variables = concat(
    [for name in ["NODE_ENV", "API_BASE_URL", "WEB_URL", "CHECKOUT_BASE_URL", "TENDR_ASSET_ORIGIN", "WEB_INTERNAL_TOKEN"] :
      local.shared_reference[name]
    ],
    [
      # Build-time (inlined into the browser bundle / the embed script).
      { name = "NEXT_PUBLIC_API_BASE_URL", value = var.api_base_url },
      { name = "NEXT_PUBLIC_WEBAUTHN_RP_ID", value = var.webauthn_rp_id },
      { name = "TENDR_CHECKOUT_BASE_URL", value = var.checkout_base_url },
      { name = "PORT", value = tostring(local.web_port) },
    ],
    [for name, value in local.web_optional : { name = name, value = value } if value != ""],
  )

  depends_on = [railway_shared_variable.config, railway_shared_variable.web_internal_token]
}

# ---------------------------------------------------------------------------------------------
# Custom domains. Railway returns the DNS records to create at the registrar (outputs.tf); the
# domains serve only once those records exist.
# ---------------------------------------------------------------------------------------------

resource "railway_custom_domain" "pay" {
  domain         = local.pay_host
  environment_id = local.environment_id
  service_id     = railway_service.web.id
  target_port    = local.web_port
}

resource "railway_custom_domain" "app" {
  domain         = local.app_host
  environment_id = local.environment_id
  service_id     = railway_service.web.id
  target_port    = local.web_port
}

resource "railway_custom_domain" "api" {
  domain         = local.api_host
  environment_id = local.environment_id
  service_id     = railway_service.api.id
  target_port    = local.api_port
}
