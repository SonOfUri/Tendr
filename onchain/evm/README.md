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
| `payWithPermit(Permit permit, TendrPayment p, bytes sig)` | EIP-2612 tokens                            | An EIP-2612 `permit` to the forwarder for `amount + fee`, plus a `TendrPayment`. The permit is wrapped in `try/catch` (a front-run permit has already set the allowance); the forwarder then requires `allowance >= amount + fee`.                                                                                                                                 |
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
to exact tags: OpenZeppelin Contracts `v5.7.0` and forge-std `v1.17.0`.

```sh
git submodule update --init onchain/evm/lib/openzeppelin-contracts onchain/evm/lib/forge-std
onchain/scripts/forge.sh test
onchain/scripts/forge.sh fmt --check
onchain/scripts/forge.sh snapshot --check   # .gas-snapshot is committed
onchain/scripts/forwarder-abi.sh --check    # TS ABI matches the build
```

Compiler: solc `0.8.37`, optimizer on (10 000 runs), `via_ir` off, EVM version
`cancun`, `bytecode_hash = "none"` and no CBOR metadata, so the bytecode (and
the CREATE2 address) is identical on every EVM chain.

## Deploying (not done by this project)

`script/Deploy.s.sol` deploys through the deterministic CREATE2 deployer
(`0x4e59b44847b379578588920ca78fbf26c0b4956c`) with the fixed salt
`keccak256("tendr.forwarder.v1")`, so the forwarder has the same address on
every EVM chain; `Deploy.predicted()` returns it. **Nothing runs this script**:
deploying needs the user's go-ahead and the external review the spec requires
before mainnet.

## Tron

The same source is meant to be compiled for the TVM; no Tron build pipeline
exists yet. Notes for whoever builds it:

- **Compiler.** Use Tron's solc fork (`tronprotocol/solidity`, as bundled with
  TronBox, run in Docker) at the newest 0.8.x it ships. The OpenZeppelin 5.7
  files the forwarder imports declare `^0.8.24` (`EIP712`, `ECDSA`) and
  `^0.8.20` (`SafeERC20`, `IERC20Permit`), so the Tron compiler must be at
  least 0.8.24; the contract's own `pragma solidity 0.8.37` is exact and has to
  be relaxed (or set to that compiler) for the Tron build. Pick an EVM version
  the TVM supports (check PUSH0 / `mcopy`), and expect a different bytecode
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
- **USDT-TRC20** returns `bool` from `transferFrom` (unlike Ethereum USDT);
  `SafeERC20` handles both.
- **Energy.** A `payWithApproval` call is two `transferFrom`s plus one nonce
  `SSTORE` and an `ecrecover`; on Tron that is energy paid by `gas-tron` (set a
  fee limit with headroom, USDT transfers to a new holder cost more energy).
  The shopper's own `approve` is covered by just-in-time energy delegation
  (spec §2.3), not by this contract.
- Tron has no CREATE2-at-the-same-address guarantee across EVM chains; the Tron
  forwarder has its own address, configured separately.
