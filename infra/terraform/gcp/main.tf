# Cloud KMS for Tendr production: one key ring, the envelope-encryption KEK and the named
# signing keys (spec §5), plus the service account the API and worker run as and its JSON key.
# Also the theme asset buckets (deploy spec §4) and their HMAC keys.
#
# NOT APPLIED. Apply only when the user decides to deploy — see ../README.md.

terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
}

locals {
  # Named signing keys. EVM and Solana gas sponsorship go through Pimlico (an API key stored
  # as a secret), so there are no EVM/Solana gas-paying keys; `gas-tron` is the only self-run gas
  # key. The `gas-fees-*` keys only receive collected fees.
  signing_keys = {
    "relayer-near"     = "EC_SIGN_ED25519"          # NEAR notify-only relayer (project 5)
    "funding-near"     = "EC_SIGN_ED25519"          # storage deposits for merchant NEAR accounts (project 3)
    "relayer-accounts" = "EC_SIGN_ED25519"          # gas-only relayer for merchant account contracts (project 3); never a signer
    "solver-hot"       = "EC_SIGN_ED25519"          # solver hot wallet, phase 2 (project 7)
    "relayer-evm"      = "EC_SIGN_SECP256K1_SHA256" # EVM relayer + EIP-3009 submitter (project 5)
    "gas-tron"         = "EC_SIGN_SECP256K1_SHA256" # Tron energy/bandwidth sponsorship (project 5)
    # Gas-fee accounts (project 5a): receive shopper-paid network fees; receive-only, used only by
    # the fee sweep job. Kept apart from the relayer keys so a stolen relayer key never reaches them.
    "gas-fees-evm"    = "EC_SIGN_SECP256K1_SHA256" # one address on every EVM chain
    "gas-fees-tron"   = "EC_SIGN_SECP256K1_SHA256"
    "gas-fees-near"   = "EC_SIGN_ED25519"
    "gas-fees-solana" = "EC_SIGN_ED25519"
  }

  kek_name = "tendr-kek"

  protection = { for name in concat([local.kek_name], keys(local.signing_keys)) :
    name => lookup(var.protection_level_overrides, name, var.protection_level)
  }
}

resource "google_project_service" "cloudkms" {
  service            = "cloudkms.googleapis.com"
  disable_on_destroy = false
}

resource "google_kms_key_ring" "tendr" {
  name     = var.key_ring_name
  location = var.location

  depends_on = [google_project_service.cloudkms]
}

# Envelope-encryption KEK (secrets at rest: webhook / request-signing secrets, provider credentials).
resource "google_kms_crypto_key" "kek" {
  name            = local.kek_name
  key_ring        = google_kms_key_ring.tendr.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 days

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = local.protection[local.kek_name]
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Asymmetric signing keys. Private material never leaves Cloud KMS; asymmetric keys do not
# auto-rotate (a rotation changes the on-chain address/public key and is a deliberate migration).
resource "google_kms_crypto_key" "signing" {
  for_each = local.signing_keys

  name     = each.key
  key_ring = google_kms_key_ring.tendr.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm        = each.value
    protection_level = local.protection[each.key]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "api" {
  account_id   = var.service_account_id
  display_name = "Tendr API and worker"
  description  = "Runtime identity of the Tendr api and worker services (Cloud KMS only)."
}

# Least privilege: encrypt/decrypt on the KEK only; sign + read public key on each signing key.
resource "google_kms_crypto_key_iam_member" "kek_encrypter_decrypter" {
  crypto_key_id = google_kms_crypto_key.kek.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = google_service_account.api.member
}

resource "google_kms_crypto_key_iam_member" "signer_verifier" {
  for_each = google_kms_crypto_key.signing

  crypto_key_id = each.value.id
  role          = "roles/cloudkms.signerVerifier"
  member        = google_service_account.api.member
}

resource "google_kms_crypto_key_iam_member" "public_key_viewer" {
  for_each = google_kms_crypto_key.signing

  crypto_key_id = each.value.id
  role          = "roles/cloudkms.publicKeyViewer"
  member        = google_service_account.api.member
}

# The JSON key the api and worker authenticate to Cloud KMS with (GCP_CREDENTIALS_JSON). Created
# here and handed to the Railway stack through the `api_credentials_json` output, so no key file is
# copied by hand. The cost: the private key also sits in state, which is a private bucket.
resource "google_service_account_key" "api" {
  service_account_id = google_service_account.api.name
}

# ---------------------------------------------------------------------------------------------
# Theme asset storage (spec §4). The API writes through GCS's S3 interop (ASSET_STORE_DRIVER=s3,
# ASSET_S3_ENDPOINT=https://storage.googleapis.com) with an HMAC key; pages read the objects
# publicly at https://storage.googleapis.com/<bucket> (TENDR_ASSET_ORIGIN).
# ---------------------------------------------------------------------------------------------

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

locals {
  # One entry per asset bucket: production always, development when var.dev_assets_enabled.
  asset_buckets = merge(
    {
      prod = {
        name            = var.assets_bucket_name
        service_account = "tendr-assets"
        display_name    = "Tendr theme assets"
        cors_origins    = var.assets_cors_origins
      }
    },
    var.dev_assets_enabled ? {
      dev = {
        name            = var.dev_assets_bucket_name
        service_account = "tendr-assets-dev"
        display_name    = "Tendr theme assets (local development)"
        cors_origins    = concat(var.assets_cors_origins, var.dev_assets_extra_cors_origins)
      }
    } : {},
  )
}

resource "google_storage_bucket" "assets" {
  for_each = local.asset_buckets

  name                        = each.value.name
  location                    = var.assets_location
  uniform_bucket_level_access = true
  # Objects are read publicly (allUsers below), so public access prevention must not be enforced.
  public_access_prevention = "inherited"

  # Fonts are fetched cross-origin by the checkout (pay host) and the dashboard (app host).
  cors {
    origin          = each.value.cors_origins
    method          = ["GET", "HEAD"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.storage]
}

# Public read: every theme asset is shown to shoppers.
resource "google_storage_bucket_iam_member" "assets_public_read" {
  for_each = google_storage_bucket.assets

  bucket = each.value.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# One service account per bucket, with object admin on that bucket only (no project roles), so the
# development key can never touch production assets.
resource "google_service_account" "assets" {
  for_each = local.asset_buckets

  account_id   = each.value.service_account
  display_name = each.value.display_name
  description  = "Writes theme assets to ${each.value.name} through the S3 interop (HMAC key)."
}

resource "google_storage_bucket_iam_member" "assets_object_admin" {
  for_each = google_storage_bucket.assets

  bucket = each.value.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.assets[each.key].member
}

# ASSET_S3_ACCESS_KEY_ID / ASSET_S3_SECRET_ACCESS_KEY. The secret is only readable at creation
# and lives in state.
resource "google_storage_hmac_key" "assets" {
  for_each = local.asset_buckets

  service_account_email = google_service_account.assets[each.key].email
}
