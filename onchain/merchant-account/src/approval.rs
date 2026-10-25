//! Proposal ids and the approval payload a signer's passkey signs.
//!
//! The WebAuthn challenge is `sha256(borsh(ApprovalPayload))`. The payload
//! binds the approval to this contract (so an assertion for store A cannot be
//! replayed on store B), to one proposal, to the current signer epoch (so a
//! signer or threshold change voids pending approvals) and to one intent (so a
//! cancel can never count as an approval).

use near_sdk::serde_with::base64::Base64;
use near_sdk::serde_with::hex::Hex;
use near_sdk::{env, near};

use crate::action::Action;
use crate::webauthn::{Assertion, SignerKey};

/// Domain separator for approval payloads.
pub const APPROVAL_DOMAIN: &str = "tendr-merchant-account-v1";

/// `sha256(borsh(action) ‖ salt)`, shown as lowercase hex in JSON.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProposalId(#[serde_as(as = "Hex")] pub [u8; 32]);

impl ProposalId {
    pub fn new(action: &Action, salt: &[u8; 32]) -> Self {
        let mut bytes = near_sdk::borsh::to_vec(action).expect("borsh");
        bytes.extend_from_slice(salt);
        Self(env::sha256_array(&bytes))
    }
}

/// 32 random bytes chosen by the proposer so the same action can be proposed twice.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Salt(#[serde_as(as = "Base64")] pub [u8; 32]);

/// What the signer is agreeing to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalIntent {
    Approve,
    Cancel,
}

/// The struct whose borsh hash is the WebAuthn challenge.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalPayload {
    pub domain: String,
    pub contract_id: String,
    pub proposal_id: [u8; 32],
    pub signer_epoch: u64,
    pub intent: ApprovalIntent,
}

impl ApprovalPayload {
    pub fn new(
        contract_id: &str,
        proposal_id: &ProposalId,
        signer_epoch: u64,
        intent: ApprovalIntent,
    ) -> Self {
        Self {
            domain: APPROVAL_DOMAIN.to_string(),
            contract_id: contract_id.to_string(),
            proposal_id: proposal_id.0,
            signer_epoch,
            intent,
        }
    }

    /// The 32-byte WebAuthn challenge for this payload.
    pub fn challenge(&self) -> [u8; 32] {
        env::sha256_array(near_sdk::borsh::to_vec(self).expect("borsh"))
    }
}

/// One signer's WebAuthn assertion over an [`ApprovalPayload`] challenge.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedApproval {
    pub signer_id: String,
    pub key: SignerKey,
    pub assertion: Assertion,
}
