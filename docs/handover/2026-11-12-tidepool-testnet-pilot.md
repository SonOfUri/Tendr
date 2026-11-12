# Tidepool testnet pilot — 12 November 2026

## Result and release status

**Real testnet funds moved successfully across Solana devnet, NEAR testnet, and Base Sepolia.** A customer paid in test USDC, a Tendr-style native P256 merchant wallet received test USDT inside the NEAR Intents verifier, and that wallet signed a withdrawal to test USDC on Base Sepolia.

Branch: `feat/tidepool-testnet`, based on `origin/deploy` at `97471c0`.

This branch contains a restricted Tidepool adapter, unit tests, and a repeatable on-chain pilot. **It does not switch the deployed dashboard/API Test mode away from the simulator.** No Railway variables, production keys, live wallets, or merchant records were changed. The pilot uses an isolated software P256 key and the existing Tendr WebAuthn encoding; browser registration, synced passkeys, recovery, checkout webhooks, and the database payment lifecycle are not yet verified against Tidepool.

## Transaction evidence

All tokens below are Tidepool test tokens with six decimals, not Circle/Tether assets with monetary value.

| Step                                      | Amount                | Evidence                                                                                                                                                 |
| ----------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer deposit, Solana devnet USDC      | 1.012184 sent         | [Solana deposit](https://explorer.solana.com/tx/4hWKtv8Gfqih3uBsb9XhqJPG4FjHdaNjCQxUhjS2H9qSeDn8KnWDJW79FHGq9G6qdf5zVvCRzngVCYgFnfdZHYjo?cluster=devnet) |
| Merchant settlement, NEAR testnet USDT    | 1.000000 received     | [Final NEAR settlement](https://testnet.nearblocks.io/txns/5M9xKKwtMCyXopwuwz4LhejnoXD2XVYHyWiu64AVrtvD)                                                 |
| Unused input returned, Solana devnet USDC | 0.010021 refunded     | [Solana refund](https://explorer.solana.com/tx/L5E36XeubxskGeWZyVYkqnS5LVMrQNqXg4CHWkRYiRzp5peJJttRD1VoztF2VLHVHU5Jm9VBsP4CiUzwtUP5ijb?cluster=devnet)   |
| Merchant authorizes withdrawal            | 1.000000 USDT debited | [Final NEAR WebAuthn transfer](https://testnet.nearblocks.io/txns/BxD8rWUyFsoybutxbx8BiPZLGgtkmz2dgfuqg1j8q29o)                                          |
| Withdrawal, Base Sepolia USDC             | 0.996967 received     | [Base payout](https://sepolia.basescan.org/tx/0x8eb1c5d1d4be06aac4a6cda099c246533b7ef178192c90ec697c8261671a115e)                                        |

Public pilot addresses:

- Customer: `7SEYS3n5AWC3B6aXUp2TycE2eUYyDCX8x6Koc8qSLRLt` (Solana devnet).
- Merchant: `0x34b8961eb64d30a6ee6d65d765cc977e2447f81c` (native P256 account inside the NEAR testnet verifier).
- Withdrawal recipient: `0xBaa13b52Ed4326f6E10864B1bc48aBB1DA50cAb9` (Base Sepolia).
- Withdrawal intent hash: `4keHj7j4PPAg1Qs6vA7Yswseh3DktKvuyYUo9UpC25i4`.

The script checked successful, final NEAR receipts emitted by the pinned verifier for the exact merchant, asset, and amount, using Tendr's existing `matchingCredits` parser. It checked a successful Base receipt with at least two confirmations and ERC-20 `Transfer` logs from the pinned USDC contract to the exact recipient. Separately, the final withdrawal-origin receipt was checked for the verifier's `dip4` transfer and `intents_executed` events matching the merchant, amount, deposit account, and intent hash above. Provider `SUCCESS` alone was not accepted as payment proof.

## Provider configuration and compatibility

- API: `https://www.usetidepool.tech`.
- Verifier: `verifier.tidepool-sandbox.testnet`.
- NEAR RPC: `https://rpc.testnet.fastnear.com`.
- Base RPC: `https://sepolia.base.org`, chain ID `84532`.
- Solana RPC: `https://api.devnet.solana.com`, devnet genesis `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- No API credential needed. Never forward Tendr's mainnet 1Click key to Tidepool.

The six-asset allowlist and chain-specific token contracts/mints live in `apps/api/src/checkout/oneclick/tidepool.ts`. It permits USDC and USDT on `near`, `base`, and `sol`, and rejects unsupported assets, invalid amounts, and app fees. The catalog must contain all six assets with the expected chain, symbol, and decimals.

Observed differences that matter for integration:

1. **WebAuthn generation:** Tidepool's `generate-intent` endpoint does not generate WebAuthn payloads, but `submit-intent` successfully relays them. `tidepoolTransferPayload` creates exactly one bounded transfer locally and runs Tendr's existing payout validator over it. Keep normal browser assertion validation before calling `signedIntent` in the application.
2. **Implicit deposit accounts:** `INTENTS` quotes return 64-character NEAR implicit account IDs. They do not necessarily end in `.testnet`; the pinned verifying contract and network determine their chain.
3. **Mixed transaction hashes:** `destinationChainTxHashes` can contain a Solana refund alongside NEAR settlement, or NEAR swap execution alongside a Base payout. Select candidates by chain, deduplicate, then verify receipts against the expected contract and recipient. `tidepoolNearSettlementHashes` only selects candidates; it does not prove payment.
4. **Exact-output surplus:** This payment returned the unused slippage allowance to the customer. A refund entry on `SUCCESS` does not mean the merchant payment failed.
5. **SPL deposits:** A Solana deposit address is the owner. Send tokens to its associated token account for the correct mint; the pilot creates that ATA idempotently before `transferChecked`.
6. **Service limits:** Tidepool is an independent community testnet service using trusted test bridges. It is not official mainnet 1Click infrastructure, and this test does not establish uptime guarantees or full route coverage. See the [compatibility guide](https://www.usetidepool.tech/docs/resources/compatibility), [trust model](https://www.usetidepool.tech/docs/resources/trust-model), [WebAuthn submission schema](https://www.usetidepool.tech/docs/api-reference/submit-intent), and [Solana bridge guide](https://www.usetidepool.tech/docs/guides/bridge-solana-devnet).

## Repeat the pilot

Use Node 22. These are repository maintainer commands, not merchant setup instructions.

```sh
npm ci
npm run build --workspace @tendr/contracts
npm run checkout:verify:tidepool --workspace @tendr/api
```

The first read-only run creates dedicated test-only keys in the gitignored `.keyvault/tidepool-pilot.json` with file permissions `0600` and prints only public addresses and balances. Claim USDC/USDT for the displayed Solana customer through the [Tidepool faucet website](https://app.usetidepool.tech/faucet); obtain devnet SOL for transaction fees and ATA rent through a [Solana faucet](https://faucet.solana.com). Do not put production keys into the pilot state or publish that file.

```sh
npm run checkout:verify:tidepool --workspace @tendr/api -- --run
```

`--run` performs one exact-output payment of 1 test USDT (maximum input: 2 test USDC) followed by withdrawal of 1 test USDT to Base Sepolia USDC. It verifies network identities before any broadcast. A lock prevents two local runs from racing. The signed Solana transaction is saved before broadcast; retries only reuse those bytes. Finalized transactions resume verification even after their blockhash expires. Signed withdrawal intent and submission-attempt state are saved before relaying. An ambiguous relay response is reconciled through the existing quote status; the script never silently creates another intent or nonce.

Polling stops after five minutes per leg and can be resumed with the same command. A completed run does not send another payment. An expired or ambiguous deposit, refund, or failed swap requires manual reconciliation before starting a new trial. If the process was killed, confirm that it has stopped before removing its `.lock` file. Preserve the state and its keys while any swap or test balance remains outstanding.

## Required application work before enabling real Test mode

The existing `providerFor(false)` still selects `SimulatedOneClick`. Merely replacing its URL would leave these gaps:

- Add an explicit Test provider setting shared by API and worker. Pin Tidepool token IDs, verifier, and testnet RPCs. Disable simulator endpoints and simulated receipt fallbacks when Tidepool is selected.
- Make native wallet registration, activation, balances, payouts, and settings mode-aware. Current native wallet services and the registration database constraint assume Live mode. Use distinct Test wallet credentials and keep Live/Test isolation.
- Handle existing stores' legacy Test accounts explicitly. Do not overwrite their accounts or auto-provision the old contract wallet when native test wallets are selected.
- Use the Tidepool transfer builder for Test withdrawals, while retaining browser origin/RP/challenge/user-verification checks, exact debit validation, idempotency, and receipt verification.
- Test additional wallet-key and recovery operations against the Tidepool verifier version and relay. Do not advertise recovery compatibility based on this single-key transfer proof.
- Route Base signing to `84532`, Solana signing to devnet, and NEAR signing to testnet. Update checkout token-address mappings, explorer links, and network labels; do not infer mainnet from the provider's `base`/`sol` labels.
- Run the API/database watcher flow from Test wallet creation through payment link checkout, verified settlement, `payment.succeeded` webhook, balance update, and withdrawal. Include underpayment, expiry/refund, mixed-chain hash responses, retry, and isolation checks.

This pilot is evidence that the three-chain, two-token approach is feasible. The deployment switch should follow the application integration checks above.

## Validation

- 39 targeted tests passed: Tidepool adapter/guards (21), existing HTTP client (13), and NEAR credit-event parsing (5).
- API source and script TypeScript checks passed; API lint passed.
- A second completed `--run` reused the recorded result, left the customer SOL balance unchanged, and observed the merchant USDT balance at zero after withdrawal. It did not submit another payment or withdrawal.
