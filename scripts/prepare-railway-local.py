#!/usr/bin/env python3
"""Prepare an isolated Railway Terraform working directory with local, private state.

Only copies versioned configuration; preserves existing state and operator inputs.
Does not authenticate, create resources, generate keys, or run Terraform.
"""
from pathlib import Path
import os
import shutil

root = Path(__file__).resolve().parents[1]
source = root / "infra" / "terraform" / "railway"
target = root / ".keyvault" / "railway-terraform"
if target.is_symlink() or target.parent.is_symlink():
    raise SystemExit("Refusing a symlinked private state directory")
target.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(target, 0o700)
if (target / "backend.tf").exists():
    raise SystemExit("Remove or migrate the existing backend deliberately before preparing local state")
for name in ("main.tf", "variables.tf", "outputs.tf", ".terraform.lock.hcl"):
    destination = target / name
    if destination.is_symlink():
        raise SystemExit("Refusing a symlinked configuration file")
    shutil.copyfile(source / name, destination)
    os.chmod(destination, 0o600)
print(f"Prepared {target}. State and secrets stay in this Git-ignored directory.")
print("Run Terraform there with umask 077 and maintain a private backup of state and keys.")
