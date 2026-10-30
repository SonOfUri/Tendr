#!/bin/sh
# One-shot MinIO setup (docker compose service `minio-init`): creates the theme asset bucket and
# lets anyone download from it, so TENDR_ASSET_ORIGIN (http://localhost:9100/tendr-assets) serves
# uploads directly. Safe to re-run.
set -eu

BUCKET="${MINIO_BUCKET:-tendr-assets}"

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/$BUCKET"
mc anonymous set download "local/$BUCKET"
echo "minio-init: bucket $BUCKET ready (anonymous download)"
