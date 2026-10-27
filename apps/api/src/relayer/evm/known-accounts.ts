// The smart-account code the paymaster proxy sponsors (project 5a, ruling I1-b). The calls check
// binds only what an HONEST account does with its callData; an account whose code ignores its
// arguments could take Pimlico's sponsorship and pay nothing. So only accounts whose code is a
// known implementation are sponsored: anything else is refused and the pay page falls back.
//
// Addresses are the canonical deployments (the same on every EVM chain). Confirm each one on each
// chain before go-live (README live checklist): code present, and for proxies the runtime below.
//
//   coinbase  ERC-1967 proxy (Solady LibClone runtime) whose implementation slot holds a listed
//             Coinbase Smart Wallet implementation; counterfactual: the listed factory's
//             `createAccount(bytes[] owners, uint256 nonce)` (it always deploys the listed
//             implementation). Calls: `execute` / `executeBatch`.
//   safe      SafeProxy whose singleton (storage slot 0) is a listed Safe singleton, with the Safe
//             4337 module enabled. Calls: `executeUserOp` / `executeUserOpWithErrorString`.
//             Counterfactual Safes are not sponsored (their setup data is not verified).
//   ERC-7579  none listed: no implementation is verified the same way yet, so 7579 accounts are
//             refused.

/** keccak256("eip1967.proxy.implementation") − 1. */
export const ERC1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** Solady `LibClone` ERC-1967 proxy runtime (what the Coinbase Smart Wallet factory deploys). */
export const SOLADY_ERC1967_PROXY_RUNTIME =
  '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';

/** Coinbase Smart Wallet implementations (lower-case). */
export const COINBASE_SMART_WALLET_IMPLEMENTATIONS: readonly string[] = [
  '0x000100abaad02f1cfc8bbe32bd5a564817339e72', // v1
];

/** Coinbase Smart Wallet factories (lower-case). */
export const COINBASE_SMART_WALLET_FACTORIES: readonly string[] = [
  '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a', // v1
];

/** `createAccount(bytes[],uint256)`. */
export const COINBASE_CREATE_ACCOUNT_SELECTOR = '0x3ffba36f';

/**
 * SafeProxy runtime (v1.3.0 / v1.4.1, solc 0.7.6) before its CBOR metadata: delegates everything
 * to the singleton in slot 0 and answers `masterCopy()` (0xa619486e) itself. The metadata tail
 * (`a2 64 'ipfs' 58 22 <34 bytes> 64 'solc' 43 <3 bytes> 00 33`) may differ between builds.
 */
export const SAFE_PROXY_RUNTIME_PREFIX =
  '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fe';

/** Safe singletons (lower-case). */
export const SAFE_SINGLETONS: readonly string[] = [
  '0x41675c099f32341bf84bfc5382af534df5c7461a', // Safe v1.4.1
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762', // SafeL2 v1.4.1
  '0xd9db270c1b5e3bd161e8c8503c55ceabee709552', // Safe v1.3.0
  '0x3e5c63644e683549055b9be8653de26e0b4cd36e', // SafeL2 v1.3.0
];

/** Safe 4337 module for EntryPoint v0.7 (v0.3.0), lower-case. */
export const SAFE_4337_MODULES: readonly string[] = ['0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226'];

/** `isModuleEnabled(address)`. */
export const SAFE_IS_MODULE_ENABLED_SELECTOR = '0x2d9ad53d';
