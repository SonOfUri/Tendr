output "gcp_kms_location" {
  description = "Value for GCP_KMS_LOCATION."
  value       = google_kms_key_ring.tendr.location
}

output "gcp_kms_keyring" {
  description = "Value for GCP_KMS_KEYRING."
  value       = google_kms_key_ring.tendr.name
}

output "gcp_kms_kek" {
  description = "Value for GCP_KMS_KEK."
  value       = google_kms_crypto_key.kek.name
}

output "signing_key_ids" {
  description = "Crypto key resource ids of the named signing keys."
  value       = { for name, key in google_kms_crypto_key.signing : name => key.id }
}

output "service_account_email" {
  description = "Service account the api and worker authenticate as (its key is api_credentials_json)."
  value       = google_service_account.api.email
}

output "api_credentials_json" {
  description = "JSON key of the tendr-api service account: the Railway stack's gcp_credentials_json (GCP_CREDENTIALS_JSON)."
  value       = base64decode(google_service_account_key.api.private_key)
  sensitive   = true
}

output "assets_bucket" {
  description = "Production asset bucket (ASSET_S3_BUCKET)."
  value       = google_storage_bucket.assets["prod"].name
}

output "assets_hmac_access_id" {
  description = "HMAC access id for the production bucket (ASSET_S3_ACCESS_KEY_ID)."
  value       = google_storage_hmac_key.assets["prod"].access_id
  sensitive   = true
}

output "assets_hmac_secret" {
  description = "HMAC secret for the production bucket (ASSET_S3_SECRET_ACCESS_KEY)."
  value       = google_storage_hmac_key.assets["prod"].secret
  sensitive   = true
}

output "dev_assets_bucket" {
  description = "Development asset bucket; null when dev_assets_enabled is false."
  value       = try(google_storage_bucket.assets["dev"].name, null)
}

output "dev_assets_hmac_access_id" {
  description = "HMAC access id for the development bucket; null when dev_assets_enabled is false."
  value       = try(google_storage_hmac_key.assets["dev"].access_id, null)
  sensitive   = true
}

output "dev_assets_hmac_secret" {
  description = "HMAC secret for the development bucket; null when dev_assets_enabled is false."
  value       = try(google_storage_hmac_key.assets["dev"].secret, null)
  sensitive   = true
}
