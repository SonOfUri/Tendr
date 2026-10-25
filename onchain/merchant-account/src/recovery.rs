//! Recovery: the recovery kit's Ed25519 key replaces the signer set and
//! threshold after [`RECOVERY_DELAY`], unless any current signer cancels.
//!
//! The recovery key can do nothing else. It is never a signer key (the
//! contract rejects that at init, `AddSigner`, `AddSignerKey` and here), so it
//! can never propose, approve or move money.
//!
//! The recovery kit signs `sha256(borsh(RecoveryPayload))`: the 32-byte hash is
//! the Ed25519 message, checked with the `ed25519_verify` host function.

use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::{env, near, require};

use crate::action::{self, Invalid, Signer};
use crate::approval::{ApprovalIntent, ProposalId, SignedApproval};
use crate::events::Event;
use crate::webauthn::SignerKey;
use crate::{or_panic, MerchantAccount, MerchantAccountExt, HOUR};

/// A started recovery executes this long after it starts.
pub const RECOVERY_DELAY: u64 = 72 * HOUR;

/// Domain separator for recovery payloads.
pub const RECOVERY_DOMAIN: &str = "tendr-merchant-account-recovery-v1";

/// The proposal id a signer's cancel of the pending recovery is made over.
/// Real proposal ids are sha256 outputs, so this never names a proposal.
pub const RECOVERY_CANCEL_ID: ProposalId = ProposalId([0; 32]);

/// The struct whose borsh hash the recovery key signs.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryPayload {
    pub domain: String,
    pub contract_id: String,
    pub new_signers: Vec<Signer>,
    pub new_threshold: u8,
    pub nonce: u64,
}

impl RecoveryPayload {
    pub fn new(contract_id: &str, new_signers: &[Signer], new_threshold: u8, nonce: u64) -> Self {
        Self {
            domain: RECOVERY_DOMAIN.to_string(),
            contract_id: contract_id.to_string(),
            new_signers: new_signers.to_vec(),
            new_threshold,
            nonce,
        }
    }

    /// The 32-byte message the recovery key signs.
    pub fn hash(&self) -> [u8; 32] {
        env::sha256_array(near_sdk::borsh::to_vec(self).expect("borsh"))
    }
}

/// A started recovery, waiting for its delay to pass.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct PendingRecovery {
    pub new_signers: Vec<Signer>,
    pub new_threshold: u8,
    pub nonce: u64,
    pub started_at: u64,
    pub executes_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveryView {
    pub new_signer_ids: Vec<String>,
    pub new_threshold: u8,
    pub executes_at: U64,
}

/// Checks a complete replacement signer set: the same per-signer rules as
/// `AddSigner` (id shape, key count, P-256 on-curve), ids and keys unique
/// within the set, no key equal to `recovery_key`, and
/// `1 <= threshold <= signers`.
pub fn validate_signer_set(
    signers: &[Signer],
    threshold: u8,
    recovery_key: Option<&[u8; 32]>,
) -> Result<(), Invalid> {
    if signers.is_empty() {
        return Err("at least one signer is required");
    }
    if signers.len() > action::MAX_SIGNERS {
        return Err("too many signers");
    }
    for (i, signer) in signers.iter().enumerate() {
        action::validate_signer(signer)?;
        let earlier = &signers[..i];
        if earlier.iter().any(|s| s.id == signer.id) {
            return Err("duplicate signer");
        }
        for key in &signer.keys {
            if earlier.iter().any(|s| s.keys.contains(key)) {
                return Err("key already registered");
            }
            if matches!((key, recovery_key), (SignerKey::Ed25519(k), Some(r)) if k == r) {
                return Err("key is the recovery key");
            }
        }
    }
    if threshold == 0 || usize::from(threshold) > signers.len() {
        return Err("threshold must be between 1 and the number of signers");
    }
    Ok(())
}

#[near]
impl MerchantAccount {
    /// Starts a recovery authorised by the recovery key. Anyone may submit
    /// it (the relayer pays gas); the signature carries the authority.
    /// `nonce` must exceed every nonce used before on this account.
    pub fn start_recovery(
        &mut self,
        new_signers: Vec<Signer>,
        new_threshold: u8,
        nonce: U64,
        signature: Base64VecU8,
    ) {
        let recovery_key = self
            .recovery_key
            .unwrap_or_else(|| env::panic_str("no recovery key is set"));
        require!(self.recovery.is_none(), "recovery already pending");
        require!(
            nonce.0 > self.recovery_nonce,
            "recovery nonce must exceed the last one used"
        );
        or_panic(validate_signer_set(
            &new_signers,
            new_threshold,
            Some(&recovery_key),
        ));
        let signature: [u8; 64] = signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("invalid recovery signature"));
        let message = RecoveryPayload::new(
            env::current_account_id().as_str(),
            &new_signers,
            new_threshold,
            nonce.0,
        )
        .hash();
        require!(
            env::ed25519_verify(&signature, message, &recovery_key),
            "invalid recovery signature"
        );

        let now = env::block_timestamp();
        let executes_at = now + RECOVERY_DELAY;
        self.recovery_nonce = nonce.0;
        Event::RecoveryStarted {
            new_signer_ids: new_signers.iter().map(|s| s.id.as_str()).collect(),
            new_threshold,
            executes_at: U64(executes_at),
        }
        .emit();
        self.recovery = Some(PendingRecovery {
            new_signers,
            new_threshold,
            nonce: nonce.0,
            started_at: now,
            executes_at,
        });
    }

    /// Any one current signer cancels the pending recovery, with a `Cancel`
    /// approval over proposal id `[0; 32]` at the current epoch.
    pub fn cancel_recovery(&mut self, approval: SignedApproval) {
        require!(self.recovery.is_some(), "no recovery is pending");
        self.verify_approval(&RECOVERY_CANCEL_ID, ApprovalIntent::Cancel, &approval);
        self.recovery = None;
        Event::RecoveryCancelled {
            signer_id: &approval.signer_id,
        }
        .emit();
    }

    /// Replaces the signers and threshold once the delay has passed. Anyone
    /// may call it. Pending approvals and timelocks are voided by the epoch
    /// bump; transfers already in flight settle through their callbacks.
    pub fn execute_recovery(&mut self) {
        let recovery = self
            .recovery
            .clone()
            .unwrap_or_else(|| env::panic_str("no recovery is pending"));
        require!(
            env::block_timestamp() >= recovery.executes_at,
            "recovery is not ready"
        );
        self.recovery = None;
        self.replace_signers(recovery.new_signers, recovery.new_threshold);
        Event::RecoveryExecuted {
            new_signer_ids: self.signers.iter().map(|s| s.id.as_str()).collect(),
            new_threshold: self.threshold,
            signer_epoch: U64(self.signer_epoch),
        }
        .emit();
        self.emit_signers_changed(None);
    }

    pub fn get_recovery(&self) -> Option<RecoveryView> {
        self.recovery.as_ref().map(|r| RecoveryView {
            new_signer_ids: r.new_signers.iter().map(|s| s.id.clone()).collect(),
            new_threshold: r.new_threshold,
            executes_at: U64(r.executes_at),
        })
    }

    /// The last recovery nonce used; the next `start_recovery` must exceed it.
    pub fn get_recovery_nonce(&self) -> U64 {
        U64(self.recovery_nonce)
    }
}

impl MerchantAccount {
    /// Swaps in a whole new signer set and threshold (validated again here)
    /// and bumps the signer epoch, voiding every pending approval and
    /// timelock. The recovery key is unchanged.
    pub(crate) fn replace_signers(&mut self, signers: Vec<Signer>, threshold: u8) {
        or_panic(validate_signer_set(
            &signers,
            threshold,
            self.recovery_key.as_ref(),
        ));
        self.signers = signers;
        self.threshold = threshold;
        self.signer_epoch += 1;
    }
}

/// Testnet only: Tendr's admin account mirrors the live signer set onto the
/// test contract, so signers never approve a change twice. Not compiled into
/// live builds, so the method is absent from their ABI.
#[cfg(feature = "testnet-admin")]
#[near]
impl MerchantAccount {
    pub fn admin_sync_signers(&mut self, signers: Vec<Signer>, threshold: u8) {
        require!(
            self.testnet_admin.as_ref() == Some(&env::predecessor_account_id()),
            "only the testnet admin may sync signers"
        );
        self.replace_signers(signers, threshold);
        self.emit_signers_changed(None);
    }
}
