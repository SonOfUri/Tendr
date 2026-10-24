variable "project_id" {
  description = "Existing GCP project that holds the key ring."
  type        = string
}

variable "location" {
  description = "Cloud KMS location of the key ring (GCP_KMS_LOCATION)."
  type        = string
  default     = "global"
}

variable "key_ring_name" {
  description = "Key ring name (GCP_KMS_KEYRING)."
  type        = string
  default     = "tendr-prod"
}

variable "protection_level" {
  description = "Protection level for every key: HSM or SOFTWARE."
  type        = string
  default     = "HSM"

  validation {
    condition     = contains(["HSM", "SOFTWARE"], var.protection_level)
    error_message = "protection_level must be HSM or SOFTWARE."
  }
}

variable "protection_level_overrides" {
  description = <<-EOT
    Per-key protection level, for keys whose algorithm Cloud KMS does not offer at HSM level
    in this location (check with `npm run kms:verify --workspace=@tendr/api` first), e.g.
    { "relayer-near" = "SOFTWARE" }.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for v in values(var.protection_level_overrides) : contains(["HSM", "SOFTWARE"], v)])
    error_message = "protection_level_overrides values must be HSM or SOFTWARE."
  }
}

variable "service_account_id" {
  description = "Account id of the service account the API and worker authenticate as."
  type        = string
  default     = "tendr-api"
}
