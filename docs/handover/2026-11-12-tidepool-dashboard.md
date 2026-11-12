# Tidepool Test mode — dashboard and API handover

Updated 12 November 2026. This extends the [dashboard handover](2026-11-02-dashboard-frontend.md) and [on-chain pilot](2026-11-12-tidepool-testnet-pilot.md).

## Merchant flow

1. Select a store and **Test** mode, then open **Wallet**.
2. Create a dedicated Test wallet passkey and complete activation. A synced passkey is recommended. Login, Live wallet and Test wallet credentials are separate.
3. Choose the store's default settlement token. A payment link can override it using the supported Test catalog.
4. Create a Test payment link or an API checkout using a Test API key. Fund the customer wallet using the [Tidepool faucet](https://app.usetidepool.tech/faucet), and obtain the network's test gas token.
5. Pay from NEAR testnet, Base Sepolia or Solana devnet using Tidepool test USDC/USDT. Checkout can connect a wallet or display deposit instructions. Transactions spend test funds and require wallet approval.
6. The worker independently verifies final NEAR settlement receipts before recording payment success and scheduling the normal `payment.succeeded` webhook. The dashboard displays the Test balance. Withdraw with the Test wallet passkey to a supported external testnet wallet.

These tokens have no monetary value. Test balances and history are scoped separately from Live. Existing simulated history remains historical data; it does not become a Tidepool balance.

## Frontend contracts

Use the existing dashboard cookie/CSRF authentication, `Tendr-Merchant` and `Tendr-Livemode: false` headers. The native wallet endpoints now accept Test mode when Tidepool is enabled:

- Registration: `POST /v1/account/native/passkey/options`, then `/passkey/verify`.
- Activation: use the assertion options returned by registration or the existing activation challenge flow, then `POST /v1/account/native/activate`.
- Balances: `GET /v1/account/balances`; asset IDs and amounts are strings.
- Payouts: `POST /v1/account/native/payouts`, then the payout's `/challenge` and `/submit` routes. Poll its existing detail/list endpoints until terminal status. Retrying uses the original signed payload and nonce.
- Settlement selection uses the existing native settlement endpoint and Test asset catalog.

`GET /v1/account` adds `accountKind` and `testProvider`. Use `account.kind ?? accountKind` to select the native setup UI even before a wallet exists. A Tidepool response has `accountKind: "native_intents"`, `testProvider: "tidepool"`; `account` can be null. `POST /v1/merchants` now returns `testAccount: null` for these stores; do not show a contract-provisioning spinner or require the old contract recovery-kit flow.

`GET /v1/account/settlement` adds `account_kind`. Native stores manage the default token on Wallet, rather than through contract multisig proposals. Connected-site readiness points to Test wallet creation when required.

Shopper session responses expose `test_provider: "tidepool"`. Only this explicit value enables real Test wallet payments. Hide simulation controls and gasless signing for these sessions. Never infer mainnet from the provider's `near`, `base` or `sol` chain labels.

The hosted `/pay/[id]` page renders `DemoCheckoutPanel` for its main payment flow. Despite its name, this component handles hosted payments as well as the frontend playground; updating only `PayFlow` does not update the active checkout. It now passes Tidepool testnet settings to the wallet connector, labels network choices and deposit instructions correctly, and exposes simulation controls only for an explicit `simulated` provider. Only the `uiOnly` playground advances confirmation steps on a timer; hosted progress follows API status. AI recommendation responses use `source: "testnet_quotes"` for Tidepool, separate from `simulated_quotes` and `live_quotes`.

The shared allowlist is `packages/contracts/src/tidepool.ts`: USDC and USDT on three networks, all six decimals. Base chain ID is `84532`; Solana is devnet; NEAR is testnet. Explorer links and connected wallets must use these networks. The `0x…` merchant address identifies its P256 balance inside the pinned NEAR verifier; it is not an EVM deposit address.

## Intentional limits

- Test wallet backup-key changes and offline recovery kits are disabled (`capabilities.nativeWalletKeyManagement: false`). A synced or cross-device-accessible original wallet passkey is required to withdraw. Existing Live key management is unchanged.
- Customer-paid test gas only. No gasless sponsorship, HOOK delivery, checkout top-up quotes or Tendr app fees in this integration. Solver/network costs may reduce withdrawal output; display the quote.
- Testnet screening is recorded as skipped with reason `tidepool_testnet`, not as a successful sanctions check. Live screening configuration is unchanged.
- An old Test placeholder is replaced only after checking that its NEAR account does not exist, it holds no Tidepool funds and no recent provisioner lease is active. Its previous identity is saved in an audit event. An actual legacy on-chain account is preserved; create a new store to try Tidepool in that case.
- Old simulator quotes cannot be revived, simulated or watched as Tidepool quotes. Create a new Test checkout after switching providers.
- Tidepool is an independent testnet service. Unavailable routes, faucet limits or RPC outages must produce actionable retry/error states, never simulated success.

## Operator rollout

Apply migration `20261112100000_tidepool_test_wallets`. Deploy the API, worker and web from the same revision. API and worker must both use `TEST_PAYMENT_PROVIDER=tidepool`, `NEAR_CLIENT_DRIVER=rpc` and no `NEAR_FAKE_SIMULATE`. Production already defaults to the RPC driver. The environment parser pins the Tidepool verifier and NEAR testnet RPCs; the adapter uses its fixed service URL without forwarding the mainnet 1Click API key.

The provider switch defaults to `simulated` for isolated development and unit tests. To roll back the switch, first stop new Test checkouts and reconcile any funded Tidepool quotes or pending withdrawals; switching providers is not a refund mechanism. Live mode continues to use its existing mainnet provider.

## Verification

The earlier pilot moved real test tokens Solana → NEAR merchant → Base and recorded final transaction evidence. Application integration tests additionally cover WebAuthn registration/activation in Test with Live disabled, new-store creation, safe placeholder replacement, catalog isolation, simulator rejection, final-receipt settlement, exactly one success event, signed payout verification and mode isolation. Test withdrawals require final destination token evidence and verifier execution matching the signed merchant/nonce/debit. Provider `SUCCESS` alone is insufficient.

Browser passkey availability still depends on the user's credential provider. A software authenticator test or deployment health check is not evidence that a particular user's device can access its wallet passkey.

An additional application smoke run used an isolated PostgreSQL database and the real RPC/provider clients. It registered and activated a dedicated Test credential, created an API checkout, verified settlement, recorded exactly one `payment.succeeded` event and displayed a 1 USDC balance. The same API accepted its WebAuthn withdrawal and independently verified completion on Base Sepolia:

- [Solana devnet customer deposit](https://explorer.solana.com/tx/5xWAEFMLciqGeBed4xevfr6WQgAfHq8QSsMZDvvFdMdU2RRLEYHJdSTLZWg2MSom5e4xpP7X7iUHHnHsHkfa4GXK?cluster=devnet).
- Test merchant: `0x22e255fd4ce7c24cfe81a92b065b914aa0b5b070`.
- [NEAR verifier withdrawal debit](https://testnet.nearblocks.io/txns/2reFSxGBzy6J8BszQwiTNwBbE4aGGvSvChdN6azDYkep).
- [Base Sepolia payout](https://sepolia.basescan.org/tx/0xa1d56072cfc4a42f01998d8ddc5db429e33c7d4cc1477dc08707e0652448141a): 0.997889 test USDT.

No production user wallet or Live funds were used. This smoke run verifies the API/database payment lifecycle, not delivery of an HTTP webhook to an external merchant.

API and web production builds passed. Relevant API suites passed after updating stale assertions for catalog metadata and the added response fields; 438 targeted web tests passed. Headless Chrome displayed the real smoke wallet and completed payout at desktop and mobile widths, without horizontal overflow or page errors. The full web suite retains eight pre-existing failures in host asset coverage, theme defaults, API-key UI expectations and link-error UI tests; these were reproduced separately at the unchanged `842307f` baseline.
