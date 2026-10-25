#!/usr/bin/env bash
# Builds every contract crate in the onchain/ workspace to Wasm inside the
# pinned cargo-near Docker image, the same way `cargo near build
# reproducible-wasm` does: the image and command come from each crate's
# [package.metadata.near.reproducible_build].
#
# Why not call `cargo near build reproducible-wasm` directly: that subcommand
# runs on the host and needs cargo-near installed there, and the project rules
# forbid host installs. It only starts this same container with the same
# command, so running the container ourselves gives the same artifact.
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

# Separate from the host's native target/ so Linux container builds and host
# builds never share incremental state.
DOCKER_TARGET="target/docker"
mkdir -p "$DOCKER_TARGET"

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
  # (which pins the native toolchain used for tests). The image sets the same
  # value; it is passed explicitly so a stray toolchain file can't win.
  toolchain="${image##*-rust-}"

  # cargo-near writes <target-dir>/near/<lib_name>/<lib_name>.wasm, where
  # lib_name is the crate name with dashes replaced by underscores. Delete any
  # stale artifact first so an old file can never be mistaken for a fresh one.
  lib_name="${crate//-/_}"
  built="$DOCKER_TARGET/near/$lib_name/$lib_name.wasm"
  rm -f "$built"

  echo "==> $crate ($image_ref, rust $toolchain)"
  # --user keeps output files owned by the host user. The image's CARGO_HOME
  # belongs to its `near` user, so the registry cache lives under target/docker.
  docker run --rm \
    --platform linux/amd64 \
    --user "$(id -u):$(id -g)" \
    -v "$ONCHAIN_DIR":/host \
    -w "/host/$crate" \
    -e RUSTUP_TOOLCHAIN="$toolchain" \
    -e CARGO_TARGET_DIR=/host/target/docker \
    -e CARGO_HOME=/host/target/docker/cargo-home \
    "$image_ref" \
    cargo near build non-reproducible-wasm --locked

  [ -f "$built" ] || { echo "build.sh: expected $built was not produced" >&2; exit 1; }
  out_dir="target/near/$crate"
  mkdir -p "$out_dir"
  cp "$built" "$out_dir/$crate.wasm"
  echo "    -> onchain/$out_dir/$crate.wasm ($(wc -c <"$out_dir/$crate.wasm" | tr -d ' ') bytes)"
done
