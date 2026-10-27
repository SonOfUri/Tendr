#!/usr/bin/env bash
# Runs Foundry's `forge` for the EVM contracts in onchain/evm inside the pinned
# Foundry Docker image. The project rules forbid host installs, so this is the
# only way the Solidity contracts are built, tested, formatted or snapshotted.
#
# Usage: onchain/scripts/forge.sh <forge args...>
#   e.g. onchain/scripts/forge.sh test
#        onchain/scripts/forge.sh fmt --check
#        onchain/scripts/forge.sh snapshot --check
#
# The Solidity dependencies (OpenZeppelin, forge-std) are git submodules under
# onchain/evm/lib, pinned to exact tags; run `git submodule update --init
# onchain/evm/lib/openzeppelin-contracts onchain/evm/lib/forge-std` first on a fresh clone.
#
# This script never deploys anything: there is no RPC URL or private key in the
# container, and script/Deploy.s.sol is not run by CI.
set -euo pipefail

# Foundry v1.8.5 (released 2026-10-05). Pinned by digest; the tag is informational.
IMAGE="ghcr.io/foundry-rs/foundry:v1.8.5"
IMAGE_DIGEST="sha256:32c8ea9ef052a440cb1620175987a3f49eff8b068a0c6a3d09ebf7f5f9a0e043"

EVM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../evm" && pwd)"

command -v docker >/dev/null || { echo "forge.sh: docker is required" >&2; exit 1; }
[ -f "$EVM_DIR/lib/openzeppelin-contracts/package.json" ] && [ -f "$EVM_DIR/lib/forge-std/package.json" ] || {
  echo "forge.sh: Solidity dependencies missing; run: git submodule update --init onchain/evm/lib/openzeppelin-contracts onchain/evm/lib/forge-std" >&2
  exit 1
}

# HOME inside the mounted project keeps the downloaded solc between runs and
# works whichever uid the container runs as.
mkdir -p "$EVM_DIR/.foundry-home"

tty_flag=()
[ -t 1 ] && tty_flag=(-t)

exec docker run --rm ${tty_flag[@]+"${tty_flag[@]}"} \
  --user "$(id -u):$(id -g)" \
  --network bridge \
  -e HOME=/work/.foundry-home \
  -e FOUNDRY_DISABLE_NIGHTLY_WARNING=1 \
  -v "$EVM_DIR":/work \
  -w /work \
  --entrypoint forge \
  "${IMAGE%%:*}@${IMAGE_DIGEST}" "$@"
