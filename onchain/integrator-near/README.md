# integrator-near — reference NEAR receiver for Tendr hooks

An example for integrators, not a Tendr contract: Tendr never deploys it. An
integrator settles its Tendr payments into its own NEAR contract; once a payment
has settled there, Tendr's relayer (`relayer-near`) calls

```
on_tendr_deposit({ payment_id, session_id, hook_data, token, amount, tx_hash })
```

with 50 Tgas attached and no deposit. All arguments are strings: `payment_id` /
`session_id` are the Tendr ids (`pay_…`, `ses_…`), `hook_data` is the session's
`hook_data` as JSON text (≤ 1 KB), `token` is the NEP-141 contract, `amount` the
settled amount in its base units (U128), `tx_hash` the settlement transaction.

## Checks every integrator contract must keep

1. **Sender:** only Tendr's published relayer account (`relayer`).
2. **Balance:** credit `min(amount, ft_balance_of(self) − accounted[token])` and
   add it to `accounted[token]`. NEAR contracts cannot read a token balance
   synchronously, so the call asks the token and credits in the `on_balance`
   callback, where the read, the check and the update happen in one receipt.
   Even a compromised relayer key cannot make the contract credit money that
   never arrived.
3. **Duplicates:** each `tx_hash` is credited once (checked at the call and
   again, atomically, in the callback; a failed token lookup records nothing, so
   Tendr's retry goes through).
4. **Outflows:** anything that moves tokens out must lower `accounted[token]`
   by the same amount, and must make callbacks already in flight credit nothing
   (their balance read may predate the outflow). This reference has no outflow.

## Misattribution limit

These checks do not stop a compromised relayer key from crediting the wrong
reference: with two deposits pending (player A's and player B's), a forged call
naming player A and both amounts credits A with B's deposit, and B's own call
then credits nothing. The settlement transfer carries no reference, so the
contract cannot tell the deposits apart. Integrators who need stronger
guarantees reconcile each credit against Tendr's signed `payment.succeeded` /
`hook.succeeded` webhooks (same payment, amount and transaction).

An atomic alternative (the settlement transfer itself calling the contract, via
`ft_transfer_call` with `hook_data` as its message) would remove the relayer
from the trust path; whether 1Click's NEAR delivery supports it is an open
live-checklist item (Task 11 report).

## Gas and failures

Tendr deducts its estimate (30 Tgas burnt, `HOOK_GAS_UNITS.near`) from the
payment's proceeds. The unit tests measure 39.2 Tgas used by the call itself
including the 20 Tgas it hands to its two receipts (`ft_balance_of` 5 Tgas,
`on_balance` 15 Tgas), within the 50 Tgas attached; the gas actually burnt on
chain is a live-checklist measurement. A panicking call is retried for 3 days
(the contract may be paused), then reported to the integrator as `hook.failed`.

## Build and test

```sh
# unit tests (inside the pinned cargo-near image; no host installs)
docker run --rm --platform linux/amd64 -v "$PWD/onchain":/host -w /host \
  -e RUSTUP_TOOLCHAIN=1.93.0 -e CARGO_HOME=/host/target/docker/cargo-home \
  sourcescan/cargo-near@sha256:79b789c81ba19ec30794a6b1046b02dcaf5c055994b22cc7c9af67ab5096b095 \
  cargo test -p integrator-near --lib
onchain/scripts/build.sh integrator-near   # Wasm, never deployed by Tendr
```
