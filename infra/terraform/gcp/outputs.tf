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
  description = "Service account to create the GCP_CREDENTIALS_JSON key for (see ../README.md)."
  value       = google_service_account.api.email
}
