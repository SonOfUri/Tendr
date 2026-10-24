variable "workspace_id" {
  description = "Railway workspace (team) to create the project in; null for the personal workspace."
  type        = string
  default     = null
}

variable "project_name" {
  description = "Railway project name."
  type        = string
  default     = "tendr"
}

variable "source_repo" {
  description = "GitHub repository (owner/name) the api and worker services build from."
  type        = string
}

variable "source_repo_branch" {
  description = "Branch to deploy."
  type        = string
  default     = "main"
}

variable "region" {
  description = "Railway region for every service."
  type        = string
  default     = "us-east4-eqdc4a"
}

variable "api_base_url" {
  description = "Public base URL of the API (API_BASE_URL)."
  type        = string
}

variable "web_url" {
  description = "Public URL of the web app (WEB_URL)."
  type        = string
}

variable "cors_origins" {
  description = "Comma-separated allowed CORS origins (CORS_ORIGINS)."
  type        = string
}

variable "gcp_project_id" {
  description = "GCP project holding the key ring (GCP_PROJECT_ID)."
  type        = string
}

variable "gcp_kms_location" {
  description = "Cloud KMS location (GCP_KMS_LOCATION); `gcp_kms_location` output of ../gcp."
  type        = string
  default     = "us-east4"
}

variable "gcp_kms_keyring" {
  description = "Key ring name (GCP_KMS_KEYRING); `gcp_kms_keyring` output of ../gcp."
  type        = string
  default     = "tendr-prod"
}

variable "gcp_kms_kek" {
  description = "KEK name (GCP_KMS_KEK); `gcp_kms_kek` output of ../gcp."
  type        = string
  default     = "tendr-kek"
}

variable "gcp_credentials_json" {
  description = "JSON key of the tendr-api service account (GCP_CREDENTIALS_JSON). Never commit it."
  type        = string
  sensitive   = true
}

variable "worker_health_port" {
  description = "Port of the worker's GET /health server (WORKER_HEALTH_PORT)."
  type        = number
  default     = 4100
}

variable "log_level" {
  description = "LOG_LEVEL for api and worker."
  type        = string
  default     = "info"
}
