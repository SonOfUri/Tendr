variable "project_id" {
  description = "Existing GCP project that holds the key ring."
  type        = string
}

variable "location" {
  description = "Cloud KMS location of the key ring (GCP_KMS_LOCATION). Cloud HSM keys are not available in `global`; use a region."
  type        = string
  default     = "us-east4"
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

variable "assets_bucket_name" {
  description = "Production theme-asset bucket (ASSET_S3_BUCKET); TENDR_ASSET_ORIGIN is https://storage.googleapis.com/<name>."
  type        = string
  default     = "tendr-assets-prod"
}

variable "assets_location" {
  description = "Location of the asset buckets. Kept next to the Railway region."
  type        = string
  default     = "us-east4"
}

variable "assets_cors_origins" {
  description = "Origins allowed to GET/HEAD assets cross-origin (fonts): the pay and app hosts."
  type        = list(string)
  default     = ["https://pay.usetendr.tech", "https://app.usetendr.tech"]
}

variable "dev_assets_enabled" {
  description = "Create the tendr-assets-dev bucket, its own service account and HMAC key, for local development in place of MinIO."
  type        = bool
  default     = true
}

variable "dev_assets_bucket_name" {
  description = "Development theme-asset bucket (only when dev_assets_enabled)."
  type        = string
  default     = "tendr-assets-dev"
}

variable "dev_assets_extra_cors_origins" {
  description = "CORS origins the development bucket allows on top of assets_cors_origins."
  type        = list(string)
  default     = ["http://localhost:3000"]
}
