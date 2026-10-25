#!/usr/bin/env bash
# Builds every contract crate in the onchain/ workspace to Wasm inside the
# pinned cargo-near Docker image, the same way `cargo near build
# reproducible-wasm` does: the image and command come from each crate's
# [package.metadata.near.reproducible_build]. Nothing is installed on the host.
#
# Output: onchain/target/near/<crate>/<crate>.wasm
#
# Usage: onchain/scripts/build.sh [crate ...]   (default: all contract crates)
set -euo pipefail

ONCHAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ONCHAIN_DIR"

DEFAULT_CRATES=(merchant-account)
CRATES=("$@")
if [ ${#CRATES[@]} -eq 0 ]; then
  CRATES=("${DEFAULT_CRATES[@]}")
fi

command -v docker >/dev/null || { echo "build.sh: docker is required" >&2; exit 1; }

# Reads `key = "value"` from the crate's reproducible_build metadata table.
metadata() {
  local manifest="$1" key="$2"
  awk -v key="$key" '
    /^\[package\.metadata\.near\.reproducible_build\]/ { in_table = 1; next }
    /^\[/ { in_table = 0 }
    in_table && $1 == key { sub(/^[^=]*= *"/, ""); sub(/".*$/, ""); print; exit }
  ' "$manifest"
}

for crate in "${CRATES[@]}"; do
  manifest="$crate/Cargo.toml"
  [ -f "$manifest" ] || { echo "build.sh: no such crate: $crate" >&2; exit 1; }

  image="$(metadata "$manifest" image)"
  digest="$(metadata "$manifest" image_digest)"
  [ -n "$image" ] && [ -n "$digest" ] || {
    echo "build.sh: $manifest lacks reproducible_build image/image_digest" >&2
    exit 1
  }
  # Pin by digest; the tag is informational.
  image_ref="${image%%:*}@${digest}"
  # The image's own toolchain is authoritative; it overrides rust-toolchain.toml
  # (which pins the native toolchain used for tests).
  toolchain="${image##*-rust-}"

  echo "==> $crate ($image_ref, rust $toolchain)"
  docker run --rm \
    --platform linux/amd64 \
    -v "$ONCHAIN_DIR":/host \
    -w "/host/$crate" \
    -e RUSTUP_TOOLCHAIN="$toolchain" \
    -e CARGO_TARGET_DIR=/host/target \
    "$image_ref" \
    cargo near build non-reproducible-wasm --locked

  # cargo-near names the artifact after the lib target (underscores) and its
  # directory layout differs between versions; normalise to target/near/<crate>/<crate>.wasm.
  lib_name="${crate//-/_}"
  out_dir="target/near/$crate"
  built="$(find target/near -name "$lib_name.wasm" -type f | head -n 1)"
  [ -n "$built" ] || { echo "build.sh: no $lib_name.wasm produced" >&2; exit 1; }
  mkdir -p "$out_dir"
  if [ "$built" != "$out_dir/$crate.wasm" ]; then
    cp "$built" "$out_dir/$crate.wasm"
  fi
  echo "    -> onchain/$out_dir/$crate.wasm ($(wc -c <"$out_dir/$crate.wasm" | tr -d ' ') bytes)"
done
