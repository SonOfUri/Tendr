# Cloud KMS for Tendr production: one key ring, the envelope-encryption KEK and the named
# signing keys (spec §5), plus the service account the API and worker run as.
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
  # as a secret), so there are no EVM/Solana gas keys; `gas-tron` is the only self-run gas key.
  signing_keys = {
    "relayer-near"     = "EC_SIGN_ED25519"          # NEAR notify-only relayer (project 5)
    "funding-near"     = "EC_SIGN_ED25519"          # storage deposits for merchant NEAR accounts (project 3)
    "relayer-accounts" = "EC_SIGN_ED25519"          # gas-only relayer for merchant account contracts (project 3); never a signer
    "solver-hot"       = "EC_SIGN_ED25519"          # solver hot wallet, phase 2 (project 7)
    "relayer-evm"      = "EC_SIGN_SECP256K1_SHA256" # EVM relayer + EIP-3009 submitter (project 5)
    "gas-tron"         = "EC_SIGN_SECP256K1_SHA256" # Tron energy/bandwidth sponsorship (project 5)
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
