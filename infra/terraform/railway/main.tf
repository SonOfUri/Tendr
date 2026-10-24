# Railway project for Tendr production: api, worker, Postgres and Redis on private networking.
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
}

# ---------------------------------------------------------------------------------------------
# Data stores
# ---------------------------------------------------------------------------------------------

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "random_password" "redis" {
  length  = 32
  special = false
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
    # Owner connection; the api's pre-deploy migrations run with it (see ../README.md for the
    # least-privilege `tendr_app` role the services should use at runtime).
    {
      name  = "DATABASE_URL"
      value = "postgresql://postgres:${random_password.postgres.result}@$${{RAILWAY_PRIVATE_DOMAIN}}:5432/tendr"
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
# Shared variables (both api and worker). NODE_ENV=production and KEYVAULT_DRIVER=gcp are
# required: env validation refuses to boot production with the local key vault.
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
    CORS_ORIGINS       = var.cors_origins
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

# ---------------------------------------------------------------------------------------------
# Application services (same repo, two processes)
# ---------------------------------------------------------------------------------------------

resource "railway_service" "api" {
  name               = "api"
  project_id         = railway_project.tendr.id
  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  regions            = local.regions

  build_command     = "npm ci && npm run db:generate && npx turbo run build --filter=@tendr/api..."
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

  build_command = "npm ci && npm run db:generate && npx turbo run build --filter=@tendr/api..."
  start_command = "npm run start:worker --workspace=@tendr/api"

  # The worker's health server listens on WORKER_HEALTH_PORT; PORT points Railway's check at it.
  healthcheck_path    = "/health"
  healthcheck_timeout = 60
}

locals {
  # Railway resolves shared variables into a service only when the service references them.
  shared_references = [
    for name in concat(keys(local.shared_variables), ["GCP_CREDENTIALS_JSON"]) :
    { name = name, value = "$${{shared.${name}}}" }
  ]
  data_references = [
    { name = "DATABASE_URL", value = "$${{postgres.DATABASE_URL}}" },
    { name = "REDIS_URL", value = "$${{redis.REDIS_URL}}" },
  ]
}

resource "railway_variable_collection" "api" {
  environment_id = local.environment_id
  service_id     = railway_service.api.id

  variables = concat(local.shared_references, local.data_references, [
    { name = "API_HOST", value = "0.0.0.0" },
    { name = "API_PORT", value = "4000" },
    { name = "PORT", value = "4000" },
  ])

  depends_on = [railway_shared_variable.config, railway_shared_variable.gcp_credentials_json]
}

resource "railway_variable_collection" "worker" {
  environment_id = local.environment_id
  service_id     = railway_service.worker.id

  variables = concat(local.shared_references, local.data_references, [
    { name = "WORKER_HEALTH_HOST", value = "0.0.0.0" },
    { name = "PORT", value = tostring(var.worker_health_port) },
  ])

  depends_on = [railway_shared_variable.config, railway_shared_variable.gcp_credentials_json]
}
