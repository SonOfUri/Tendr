# Security Policy

## Reporting

Email security concerns to the maintainers via the repository contact. Do not open public issues for vulnerabilities that expose secrets, payment integrity, or user data.

## Scaffold limitations

This repository is a **hackathon / development scaffold**. It is **not** production-ready payment infrastructure.

Known limitations:

- Merchant dashboard and API-key flows are **demo/development-only**. There is no production authentication or KYC.
- Live payment providers are **disabled by default**. Sandbox mode never moves real funds.
- Webhook delivery uses an in-process runner; Redis-backed queues are optional and not required for local sandbox.
- Do not store seed phrases, private keys, or custodian credentials in this application.
- Never commit `.env` files or real API keys.

## Safe defaults

- `CHECKOUT_LIVE_ENABLED=false`
- `PAYMENT_PROVIDER=sandbox`
- Browser clients cannot mark payments as settled
- Secrets must stay server-side; do not put them in `NEXT_PUBLIC_*` variables
