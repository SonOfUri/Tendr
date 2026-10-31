# Remote state in the same private, versioned GCS bucket as ../gcp (see ../README.md). State holds
# every secret passed to Railway, so the bucket stays private.
terraform {
  backend "gcs" {
    bucket = "tendr-tfstate"
    prefix = "railway"
  }
}
