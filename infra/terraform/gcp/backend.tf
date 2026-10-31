# Remote state in a private, versioned GCS bucket the user creates once by hand (see ../README.md):
# Terraform cannot keep its state in a bucket it creates. State holds secrets (the HMAC secrets
# and the tendr-api service-account key), so the bucket stays private.
terraform {
  backend "gcs" {
    bucket = "tendr-tfstate"
    prefix = "gcp"
  }
}
