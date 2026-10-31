#!/usr/bin/env python3
"""Collect provider credentials in the operator's terminal without echo or shell history."""
import getpass
import json
import os
from pathlib import Path
import sys
import tempfile

if not sys.stdin.isatty():
    raise SystemExit("Run this script in your own interactive terminal; do not pipe secrets into it.")
root = Path(__file__).resolve().parents[1]
directory = root / ".keyvault"
path = directory / "provider-secrets.json"
if directory.is_symlink() or path.is_symlink():
    raise SystemExit("Refusing a symlinked secrets location")
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
data = json.loads(path.read_text()) if path.exists() else {}
if not isinstance(data, dict):
    raise SystemExit("Existing provider-secrets.json must be a JSON object")

fields = [
    ("RESEND_API_KEY", "Resend sending API key", True),
    ("ONECLICK_API_KEY", "1Click JWT", True),
    ("FX_API_KEY", "Open Exchange Rates app ID", True),
    ("CHAINALYSIS_API_KEY", "Chainalysis screening API key", True),
    ("NEXT_PUBLIC_REOWN_PROJECT_ID", "Reown project ID (optional)", False),
]
print("Inputs are hidden. Press Enter to keep an existing value. Ctrl-C cancels without writing.")
try:
    for key, label, required in fields:
        while True:
            existing = bool(data.get(key))
            value = getpass.getpass(label + (" [already saved]" if existing else "") + ": ").strip()
            if value:
                data[key] = value
                break
            if existing or not required:
                break
            print("This credential is required for the real-money deployment; Ctrl-C to cancel.")
except (KeyboardInterrupt, EOFError):
    raise SystemExit("\nCancelled; no changes saved.")

fd, temporary = tempfile.mkstemp(prefix=".provider-secrets-", dir=directory)
try:
    with os.fdopen(fd, "w") as output:
        json.dump(data, output, indent=2)
        output.write("\n")
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print(f"Saved {path} with owner-only permissions. No credential values were printed.")
