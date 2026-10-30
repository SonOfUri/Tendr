// Test-mode gasless payloads (project 5a, ruling T10-f): in test mode nothing a shopper signs may
// be usable on a real chain, even when they connect a real wallet holding real funds. The API
// issues these markers in every test-mode payload and accepts only them; the pay page REQUIRES
// them for a test-mode session and REFUSES them for a live one, before the wallet is asked.
//
// - EVM (3009, permit, TendrPayment) and Tron's TendrPayment: the EIP-712 / TIP-712 domain is
//   `TEST_PAYMENT_DOMAIN_NAME` at `TEST_VERIFYING_CONTRACT`. That address is a vanity sentinel
//   with no deployer and no code on any chain, so no contract will ever accept the signature
//   (EIP-712 binds the verifying contract).
// - Solana: the recent blockhash is `TEST_SOLANA_BLOCKHASH` (sha256 of a fixed string), which no
//   cluster ever produced, so the transaction can never land.
// - Tron approve: the TaPoS reference is `TEST_TRON_REF_BLOCK`, not a real block, so every node
//   refuses it (TAPOS_ERROR).
// - NEAR: the delegate action's receiver is `TEST_NEAR_RECEIVER`, an account id under the
//   `.invalid` top level that cannot exist, so the action can never execute.

export const TEST_PAYMENT_DOMAIN_NAME = 'Tendr test payment';
export const TEST_PAYMENT_DOMAIN_VERSION = '1';
/** Holds no code on any chain (see above). */
export const TEST_VERIFYING_CONTRACT = '0x7E57000000000000000000000000000000007E57';
/** sha256("tendr:test-mode:solana-blockhash"), base58. */
export const TEST_SOLANA_BLOCKHASH = '9xWa63eegkSG738oa3REXzSizpErkLYybriuY4GkpdtU';
/** `ref_block_bytes` (2 bytes) and `ref_block_hash` (8 bytes), hex. */
export const TEST_TRON_REF_BLOCK = { bytes: '7e57', hash: '7e577e577e577e57' } as const;
export const TEST_NEAR_RECEIVER = 'tendr-test-payment.test.invalid';
