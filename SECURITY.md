# Security Policy

## Reporting

Email security concerns to the maintainers via the repository contact. Do not open public issues for vulnerabilities that expose secrets, payment integrity, or user data.

## Current status

This repository is the **foundation** of Tendr. It is **not** yet production payment infrastructure: checkout endpoints, settlement and merchant sign-in are built in later projects, and nothing here moves funds.

Known limitations:

- There is no merchant dashboard sign-in or KYC yet; API keys are issued by the seed script.
- Live mode has no settlement path; live payments stay disabled until settlement is built and a merchant has a live settlement config.
- Do not store seed phrases, private keys, or custodian credentials in this application. Signing keys live in Cloud KMS in production (`KEYVAULT_DRIVER=gcp`); the local key vault is for development and refuses to run with `NODE_ENV=production`.
- Never commit `.env` files, `.keyvault/`, Terraform state or real API keys.

## Safe defaults

- API keys are stored as SHA-256 hashes; raw keys are shown once.
- Every request is confined to its merchant and mode (test vs live) by scoped data access and composite foreign keys.
- `events` is append-only (enforced by a database trigger).
- Browser clients cannot mark payments as settled.
- Secrets must stay server-side; do not put them in `NEXT_PUBLIC_*` variables.
