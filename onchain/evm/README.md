# TendrForwarder

The payment forwarder for gasless EVM and Tron payments (spec
`docs/superpowers/specs/2026-10-27-gasless-relayer-design.md` §2.3). A relayer
submits a shopper-signed payment; the forwarder moves the payment to the 1Click
deposit address and the optional network fee to Tendr's gas-fee address in the
same transaction.

The contract is immutable and has no owner, no admin functions, no `receive`
or `fallback`, and no storage except the per-shopper set of used `TendrPayment`
nonces. Tokens move straight from the shopper to the signed destinations; the
forwarder never holds a balance. A relayer, or anyone else, can only submit
what the shopper signed: the destination, amounts, fee recipient, token and
deadline are all bound by the shopper's signature.

## Entry points

| Function                                                  | Used for                                   | What the shopper signs                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payWithAuthorizations(Auth3009 payment, Auth3009 fee)`   | EIP-3009 tokens (USDC)                     | One `TransferWithAuthorization` per leg: `to` = deposit address (payment), `to` = gas-fee address (fee). The forwarder calls the token's `transferWithAuthorization` for each leg. A leg whose nonce is already used (front-run) is skipped, not reverted, so a front-run payment leg never strands the fee leg. A fee leg with `value == 0` is empty and skipped. |
| `payWithPermit(Permit permit, TendrPayment p, bytes sig)` | EIP-2612 tokens                            | An EIP-2612 `permit` to the forwarder for exactly `amount + fee` (any other value reverts `PermitMismatch`, so nothing is left approved), plus a `TendrPayment`. The permit is wrapped in `try/catch` (a front-run permit has already set the allowance); the forwarder then requires `allowance >= amount + fee`.                                                 |
| `payWithApproval(TendrPayment p, bytes sig)`              | Tron (USDT-TRC20) and approve-based tokens | An exact-amount `approve(forwarder, amount + fee)` transaction, plus a `TendrPayment`.                                                                                                                                                                                                                                                                             |

For both `TendrPayment` paths the forwarder checks the deadline, recovers the
signer with OpenZeppelin `ECDSA` (malleable high-`s` signatures rejected; EOA
signatures only, smart wallets use the Pimlico path), requires the signer to be
`p.from`, marks `(from, nonce)` used, and does exactly
`transferFrom(from, to, amount)` and, when `fee > 0`, `transferFrom(from, feeTo, fee)`
through `SafeERC20` (so tokens without a return value, such as USDT, work).

EIP-712 domain: name `TendrForwarder`, version `1`, `chainId`, `verifyingContract`.

```
TendrPayment(address token,address from,address to,uint256 amount,uint256 fee,address feeTo,uint256 deadline,bytes32 nonce)
```

The TypeScript side (types, domain helper and the generated ABI) is in
`packages/contracts/src/forwarder.ts` and `forwarder-abi.ts`; regenerate the ABI
with `onchain/scripts/forwarder-abi.sh` after changing the contract.

## Build and test

Foundry runs only in Docker (no host installs), through the pinned image in
`onchain/scripts/forge.sh`. The Solidity dependencies are git submodules pinned
to exact tags: OpenZeppelin Contracts `v5.4.0` and forge-std `v1.17.0`.
OpenZeppelin is held at 5.4.0 because from 5.5.0 `Strings` (imported by
`EIP712` through `MessageHashUtils`) pulls in `Bytes`, which uses `mcopy` and
does not compile for `paris`.

```sh
git submodule update --init onchain/evm/lib/openzeppelin-contracts onchain/evm/lib/forge-std
onchain/scripts/forge.sh test
onchain/scripts/forge.sh fmt --check
onchain/scripts/forge.sh snapshot --check   # .gas-snapshot is committed
onchain/scripts/forwarder-abi.sh --check    # TS ABI matches the build
```

`test/SignatureVectors.t.sol` replays signatures made by the TypeScript signing
path (ethers `signTypedData` with `forwarderDomain` and `TENDR_PAYMENT_TYPES`)
from `test/fixtures/tendr-payment-vectors.json`. That fixture is generated and
drift-checked by `packages/contracts/src/forwarder-vectors.test.ts`; regenerate
it with `UPDATE_FORWARDER_VECTORS=1 npm test --workspace=@tendr/contracts`.

Compiler: solc `0.8.37`, optimizer on (10 000 runs), `via_ir` off, EVM version
`paris`, `bytecode_hash = "none"` and no CBOR metadata, so the bytecode (and
the CREATE2 address) is identical on every EVM chain. `paris` emits neither
`PUSH0` (Shanghai) nor `MCOPY` (Cancun), so the one bytecode runs on all nine
listed chains whatever their hard-fork level, and the same source targets the
TVM without relying on newer opcodes.

## Deploying (not done by this project)

`script/Deploy.s.sol` deploys through the deterministic CREATE2 deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) with the fixed salt
`keccak256("tendr.forwarder.v1")`, so the forwarder has the same address on
every EVM chain; `Deploy.predicted()` returns it (currently
`0x19BEBC71495490A99cA6F50F107076967380cf09`; any change to the source, the
compiler settings or the OpenZeppelin version changes it). Confirm the
deterministic deployer exists on each chain (gnosis, bera) at deploy time.
**Nothing runs this script**:
deploying needs the user's go-ahead and the external review the spec requires
before mainnet.

## Tron

The same source is meant to be compiled for the TVM; no Tron build pipeline
exists yet. Notes for whoever builds it:

- **Compiler.** Use Tron's solc fork (`tronprotocol/solidity`, as bundled with
  TronBox, run in Docker) at the newest 0.8.x it ships. The OpenZeppelin 5.4
  files the forwarder imports declare `^0.8.20`, so the Tron compiler must be
  at least 0.8.20; the contract's own `pragma solidity 0.8.37` is exact and has
  to be relaxed (or set to that compiler) for the Tron build. Keep
  `evm_version = paris` (no `PUSH0` / `MCOPY`), and expect a different bytecode
  from the EVM build.
- **TIP-712 domain.** Tron's typed-data signing (TIP-712, what TronLink's
  `signTypedData` implements) uses the same `EIP712Domain(string name,string
version,uint256 chainId,address verifyingContract)` struct. `chainId` is the
  TVM's `block.chainid` (mainnet `0x2b6653dc` = 728126428, Nile testnet
  `0xcd8690dc` = 3448148188) and `verifyingContract` is the 20-byte address
  (the base58 address's `41` prefix dropped), which is what `address(this)`
  returns on the TVM. `forwarderDomain(chainId, address)` in
  `packages/contracts` takes it in that form. Verify a signature from a real
  TronLink against a Nile deployment before go-live.
- **USDT-TRC20 return value (go-live check).** `SafeERC20` accepts `true` or
  no return data and reverts on `false`. Confirm on Nile that USDT-TRC20's
  `transferFrom` returns `true` (it is known not to on `transfer`); if it
  returned `false`, every Tron payment would revert.
- **Fee-on-transfer and rebasing tokens are unsupported** on every chain; the
  API's token allow-list must exclude them.
- **Energy.** A `payWithApproval` call is two `transferFrom`s plus one nonce
  `SSTORE` and an `ecrecover`; on Tron that is energy paid by `gas-tron` (set a
  fee limit with headroom, USDT transfers to a new holder cost more energy).
  The shopper's own `approve` is covered by just-in-time energy delegation
  (spec §2.3), not by this contract.
- Tron has no CREATE2-at-the-same-address guarantee across EVM chains; the Tron
  forwarder has its own address, configured separately: the API reads it from
  `TRON_FORWARDER_ADDRESS` (base58 `T…`, no default; Tron gasless stays off until it
  is set). The API side is `apps/api/src/relayer/tron.ts` (the two signing steps,
  the `payWithApproval` relay) and `tron-energy.ts` (just-in-time delegation).

## Reference integrator receiver

`src/reference/TendrDepositReceiver.sol` is an example for integrators, not a
Tendr contract: Tendr never deploys it. An integrator settles its payments into
its own contract; once a payment has settled there, Tendr's relayer
(`relayer-evm`) calls

```solidity
function onTendrDeposit(bytes32 paymentId, bytes32 sessionId, bytes hookData,
                        address token, uint256 amount, bytes32 txHash) external;
```

`paymentId` / `sessionId` are the Tendr ids (`pay_…`, `ses_…`) as UTF-8 bytes
right-padded to 32; `hookData` is the session's `hook_data` as JSON (≤ 1 KB);
`token` is the settlement token (`address(0)` for the native coin); `txHash` is
the settlement transaction. The API side is `apps/api/src/hooks/` (`guard.ts`
builds and checks the exact call; `relayer-evm` signs nothing else to a
contract).

Checks every integrator contract must keep (the reference has them):

1. **Sender:** only Tendr's published relayer address for the chain.
2. **Balance:** credit `min(amount, balance(token) − accounted[token])` and add
   it to `accounted[token]`, so even a compromised relayer key cannot make the
   contract credit money that never arrived. Anything that moves tokens out must
   lower `accounted[token]` by the same amount.
3. **Duplicates:** each `txHash` is notified once.

**Misattribution limit.** These checks do not stop a compromised relayer key
from crediting the wrong reference: with two deposits pending (player A's and
player B's), a forged call naming player A and both amounts credits A with B's
deposit, and B's own call then credits nothing. Integrators who need stronger
guarantees reconcile each credit against Tendr's signed `payment.succeeded` /
`hook.succeeded` webhooks, or check `txHash` against the actual transfer. The
NEAR reference (`onchain/integrator-near`) has the same limit.

Gas (`test_gasOfAHookCall`, full transaction): 85.2k for a typical call, 104.8k
for a token's first deposit, 126.9k with 1 KB of `hookData`. The API estimates
90k (`HOOK_GAS_UNITS`) and deducts it from the payment's proceeds; a costlier
call's excess is Tendr's loss. A reverting call is retried for 3 days (the
contract may be paused), then reported as `hook.failed`.
