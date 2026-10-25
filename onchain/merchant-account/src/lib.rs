//! Per-merchant NEAR threshold account contract.
//!
//! The account has no access keys; this contract is the only thing that can
//! act for it. Every change is a *proposal* that executes once it holds
//! `threshold` approvals from distinct signers at the current signer epoch.
//! Each approval is a WebAuthn assertion over
//! `sha256(borsh(ApprovalPayload))` (see [`approval`]).

pub mod action;
pub mod approval;
pub mod events;
pub mod saved;
pub mod webauthn;

use near_sdk::json_types::U64;
// schemars' derive for `#[serde_as(as = "Option<Base64>")]` fields emits bare
// `serde::` paths when building the ABI.
#[allow(unused_imports)]
use near_sdk::serde;
use near_sdk::serde_with::base64::Base64;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

use crate::action::{Action, ActionKind, Invalid, PayoutMode, Signer};
use crate::approval::{ApprovalIntent, ApprovalPayload, ProposalId, Salt, SignedApproval};
use crate::events::Event;
use crate::saved::{SavedAddress, SavedAddressView, Settlement};
use crate::webauthn::SignerKey;

/// Nanoseconds in one hour.
pub const HOUR: u64 = 3_600 * 1_000_000_000;
/// A proposal that has not executed this long after creation expires.
pub const PROPOSAL_TTL: u64 = 7 * 24 * HOUR;
/// Most proposals `list_proposals` returns per call.
pub const MAX_LIST_LIMIT: u32 = 100;
/// Longest accepted RP ID (a DNS name).
pub const MAX_RP_ID_LEN: usize = 253;
/// Most pending (including timelocked) proposals one signer may have created.
/// With the per-field size bounds this caps the storage any one signer can
/// make the account pay for.
pub const MAX_PENDING_PER_SIGNER: u8 = 10;

/// Arguments to [`MerchantAccount::new`].
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct InitConfig {
    pub signers: Vec<Signer>,
    pub threshold: u8,
    /// Ed25519 public key of the recovery kit.
    #[serde_as(as = "Option<Base64>")]
    pub recovery_key: Option<[u8; 32]>,
    /// WebAuthn RP ID; the contract pins `sha256(rp_id)`.
    pub rp_id: String,
    pub origins: Vec<String>,
    pub intents_contract: AccountId,
    /// Accepted only when built with the `testnet-admin` feature.
    pub testnet_admin: Option<AccountId>,
}

/// Lifecycle of a proposal. A pending proposal with `ready_at` set is timelocked.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Executed,
    Failed,
    Cancelled,
    Expired,
}

/// One signer's approval, recorded with the key and epoch it was made under.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedApproval {
    pub signer_id: String,
    pub key: SignerKey,
    pub signer_epoch: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub action: Action,
    /// The signer who proposed it; counts toward their pending cap.
    pub creator: String,
    pub created_at: u64,
    /// At most one entry per signer: re-approving at a new epoch replaces it.
    pub approvals: Vec<RecordedApproval>,
    /// Set when the threshold is reached on an action that needs a timelock.
    pub ready_at: Option<u64>,
    pub status: ProposalStatus,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalView {
    pub signer_id: String,
    pub key: SignerKey,
    pub signer_epoch: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposalView {
    pub id: ProposalId,
    pub action: Action,
    pub creator: String,
    pub created_at: U64,
    pub expires_at: U64,
    pub approvals: Vec<ApprovalView>,
    /// Approvals that count now: current epoch, signer and key still registered.
    pub valid_approvals: u8,
    pub ready_at: Option<U64>,
    /// `expired` once the TTL passes, even before anyone calls `execute`.
    pub status: ProposalStatus,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub signers: Vec<Signer>,
    pub threshold: u8,
    pub signer_epoch: U64,
    pub origins: Vec<String>,
    pub rp_id: String,
    pub recovery_key_set: bool,
    pub intents_contract: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MerchantAccount {
    signers: Vec<Signer>,
    threshold: u8,
    /// Bumped by every change to who signs or how many must sign; approvals
    /// made under an older epoch stop counting.
    signer_epoch: u64,
    origins: Vec<String>,
    rp_id: String,
    rp_id_hash: [u8; 32],
    recovery_key: Option<[u8; 32]>,
    intents_contract: AccountId,
    testnet_admin: Option<AccountId>,
    proposals: IterableMap<ProposalId, Proposal>,
    /// Pending proposals per creating signer, for `MAX_PENDING_PER_SIGNER`.
    pending_per_signer: LookupMap<String, u8>,
    saved_addresses: Vec<SavedAddress>,
    settlement: Option<Settlement>,
}

#[near]
impl MerchantAccount {
    #[init]
    pub fn new(config: InitConfig) -> Self {
        let InitConfig {
            signers,
            threshold,
            recovery_key,
            rp_id,
            origins,
            intents_contract,
            testnet_admin,
        } = config;

        if testnet_admin.is_some() && !cfg!(feature = "testnet-admin") {
            env::panic_str("testnet_admin requires the testnet-admin feature");
        }
        require!(
            !rp_id.is_empty() && rp_id.len() <= MAX_RP_ID_LEN,
            "invalid rp_id"
        );
        or_panic(action::validate_origins(&origins));

        let mut this = Self {
            signers: Vec::new(),
            threshold: 0,
            signer_epoch: 0,
            origins,
            rp_id_hash: env::sha256_array(rp_id.as_bytes()),
            rp_id,
            recovery_key,
            intents_contract,
            testnet_admin,
            proposals: IterableMap::new(StorageKey::Proposals),
            pending_per_signer: LookupMap::new(StorageKey::PendingPerSigner),
            saved_addresses: Vec::new(),
            settlement: None,
        };
        require!(!signers.is_empty(), "at least one signer is required");
        for signer in signers {
            or_panic(this.check_add_signer(&signer));
            this.signers.push(signer);
        }
        or_panic(this.check_threshold(threshold, this.signers.len()));
        this.threshold = threshold;
        if let Some(pk) = recovery_key {
            or_panic(this.check_recovery_key(&pk));
        }
        this
    }

    /// Creates a proposal and records the proposer's approval. Only a current
    /// signer can create one, so nobody else can fill storage with proposals.
    pub fn propose(&mut self, action: Action, salt: Salt, approval: SignedApproval) -> ProposalId {
        or_panic(action::validate_bounds(&action));
        if !action.is_proposable() {
            env::panic_str("not yet supported");
        }
        or_panic(self.check_action(&action));
        let id = ProposalId::new(&action, &salt.0);
        require!(self.proposals.get(&id).is_none(), "proposal already exists");
        self.verify_approval(&id, ApprovalIntent::Approve, &approval);
        let pending = self
            .pending_per_signer
            .get(&approval.signer_id)
            .copied()
            .unwrap_or(0);
        require!(
            pending < MAX_PENDING_PER_SIGNER,
            "too many pending proposals for this signer"
        );
        self.pending_per_signer
            .insert(approval.signer_id.clone(), pending + 1);

        let created_at = env::block_timestamp();
        Event::ProposalCreated {
            proposal_id: id,
            signer_id: &approval.signer_id,
            action: &action,
            expires_at: U64(created_at + PROPOSAL_TTL),
        }
        .emit();
        self.proposals.insert(
            id,
            Proposal {
                action,
                creator: approval.signer_id.clone(),
                created_at,
                approvals: Vec::new(),
                ready_at: None,
                status: ProposalStatus::Pending,
            },
        );
        self.record_approval(id, approval);
        id
    }

    pub fn approve(&mut self, proposal_id: ProposalId, approval: SignedApproval) {
        let proposal = self.open_proposal(&proposal_id);
        require!(
            env::block_timestamp() < proposal.created_at + PROPOSAL_TTL,
            "proposal expired"
        );
        self.verify_approval(&proposal_id, ApprovalIntent::Approve, &approval);
        self.record_approval(proposal_id, approval);
    }

    /// Runs a ready proposal, or marks it expired once its TTL has passed.
    /// Anyone may call it; readiness is re-checked against current signers,
    /// threshold and epoch.
    pub fn execute(&mut self, proposal_id: ProposalId) {
        let proposal = self.open_proposal(&proposal_id);
        let now = env::block_timestamp();
        if now >= proposal.created_at + PROPOSAL_TTL {
            self.expire(proposal_id);
            return;
        }
        require!(
            self.valid_approvals(&proposal) >= self.threshold,
            "not enough approvals at the current signer epoch"
        );
        let unlocked = match proposal.ready_at {
            Some(ready_at) => now >= ready_at,
            None => Self::timelock_delay(&proposal.action).is_none(),
        };
        require!(unlocked, "proposal is timelocked");
        self.execute_now(proposal_id);
    }

    /// Any one current signer may cancel a pending proposal. A proposal past
    /// its TTL is marked expired instead, so the record shows why it ended.
    pub fn cancel(&mut self, proposal_id: ProposalId, approval: SignedApproval) {
        let proposal = self.open_proposal(&proposal_id);
        self.verify_approval(&proposal_id, ApprovalIntent::Cancel, &approval);
        if env::block_timestamp() >= proposal.created_at + PROPOSAL_TTL {
            self.expire(proposal_id);
            return;
        }
        self.finish(&proposal_id, ProposalStatus::Cancelled);
        Event::ProposalCancelled {
            proposal_id,
            signer_id: &approval.signer_id,
        }
        .emit();
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            signers: self.signers.clone(),
            threshold: self.threshold,
            signer_epoch: U64(self.signer_epoch),
            origins: self.origins.clone(),
            rp_id: self.rp_id.clone(),
            recovery_key_set: self.recovery_key.is_some(),
            intents_contract: self.intents_contract.clone(),
        }
    }

    pub fn list_saved_addresses(&self) -> Vec<SavedAddressView> {
        self.saved_addresses.iter().map(Into::into).collect()
    }

    /// The current checkout settlement choice; `None` until one is set.
    pub fn get_settlement(&self) -> Option<Settlement> {
        self.settlement.clone()
    }

    pub fn get_proposal(&self, id: ProposalId) -> Option<ProposalView> {
        self.proposals.get(&id).map(|p| self.view(id, p))
    }

    /// Proposals in creation order, at most [`MAX_LIST_LIMIT`] per call.
    pub fn list_proposals(&self, from_index: u32, limit: u32) -> Vec<ProposalView> {
        self.proposals
            .iter()
            .skip(from_index as usize)
            .take(limit.min(MAX_LIST_LIMIT) as usize)
            .map(|(id, p)| self.view(*id, p))
            .collect()
    }
}

#[derive(near_sdk::BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Proposals,
    PendingPerSigner,
}

fn or_panic(r: Result<(), Invalid>) {
    if let Err(msg) = r {
        env::panic_str(msg);
    }
}

impl MerchantAccount {
    fn signer(&self, id: &str) -> Option<&Signer> {
        self.signers.iter().find(|s| s.id == id)
    }

    fn key_registered(&self, key: &SignerKey) -> bool {
        self.signers.iter().any(|s| s.keys.contains(key))
    }

    /// The pending proposal `id`, or a panic.
    fn open_proposal(&self, id: &ProposalId) -> Proposal {
        let p = self
            .proposals
            .get(id)
            .unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(
            p.status == ProposalStatus::Pending,
            "proposal is not pending"
        );
        p.clone()
    }

    /// Moves a pending proposal to a final status and releases its slot in
    /// the creator's pending cap.
    fn finish(&mut self, id: &ProposalId, status: ProposalStatus) {
        let p = self.proposals.get_mut(id).expect("proposal exists");
        debug_assert_eq!(p.status, ProposalStatus::Pending);
        p.status = status;
        let creator = p.creator.clone();
        match self.pending_per_signer.get(&creator).copied() {
            Some(n) if n > 1 => {
                self.pending_per_signer.insert(creator, n - 1);
            }
            _ => {
                self.pending_per_signer.remove(&creator);
            }
        }
    }

    fn expire(&mut self, proposal_id: ProposalId) {
        self.finish(&proposal_id, ProposalStatus::Expired);
        Event::ProposalFailed {
            proposal_id,
            reason: "expired",
        }
        .emit();
    }

    /// Panics unless `approval` is a valid assertion by a current signer's
    /// registered key over this contract's payload for `id`, the current
    /// epoch and `intent`.
    fn verify_approval(&self, id: &ProposalId, intent: ApprovalIntent, approval: &SignedApproval) {
        let signer = self
            .signer(&approval.signer_id)
            .unwrap_or_else(|| env::panic_str("unknown signer"));
        require!(
            signer.keys.contains(&approval.key),
            "key is not registered to this signer"
        );
        let challenge = ApprovalPayload::new(
            env::current_account_id().as_str(),
            id,
            self.signer_epoch,
            intent,
        )
        .challenge();
        if let Err(e) = webauthn::verify_assertion(
            &approval.key,
            &approval.assertion,
            &challenge,
            &self.rp_id_hash,
            &self.origins,
        ) {
            env::panic_str(&format!("invalid approval: {e}"));
        }
    }

    /// Approvals that count now: made at the current epoch, by a current
    /// signer, with a key still registered to that signer.
    fn valid_approvals(&self, p: &Proposal) -> u8 {
        let n = p
            .approvals
            .iter()
            .filter(|a| {
                a.signer_epoch == self.signer_epoch
                    && self
                        .signer(&a.signer_id)
                        .is_some_and(|s| s.keys.contains(&a.key))
            })
            .count();
        u8::try_from(n).unwrap_or(u8::MAX)
    }

    /// Records a verified approval and acts once the threshold is reached.
    fn record_approval(&mut self, id: ProposalId, approval: SignedApproval) {
        let epoch = self.signer_epoch;
        let proposal = self.proposals.get_mut(&id).expect("proposal exists");
        let entry = RecordedApproval {
            signer_id: approval.signer_id,
            key: approval.key,
            signer_epoch: epoch,
        };
        match proposal
            .approvals
            .iter_mut()
            .find(|a| a.signer_id == entry.signer_id)
        {
            Some(existing) if existing.signer_epoch == epoch => {
                env::panic_str("signer already approved this proposal")
            }
            Some(existing) => *existing = entry.clone(),
            None => proposal.approvals.push(entry.clone()),
        }
        let proposal = proposal.clone();
        let approvals = self.valid_approvals(&proposal);
        Event::ProposalApproved {
            proposal_id: id,
            signer_id: &entry.signer_id,
            signer_epoch: U64(epoch),
            approvals,
            threshold: self.threshold,
        }
        .emit();
        if approvals < self.threshold {
            return;
        }
        match Self::timelock_delay(&proposal.action) {
            None => self.execute_now(id),
            Some(_) if proposal.ready_at.is_some() => {}
            Some(delay) => {
                let ready_at = env::block_timestamp() + delay;
                self.proposals
                    .get_mut(&id)
                    .expect("proposal exists")
                    .ready_at = Some(ready_at);
                Event::TimelockStarted {
                    proposal_id: id,
                    action: &proposal.action,
                    ready_at: U64(ready_at),
                }
                .emit();
            }
        }
    }

    /// How long an approved action waits before it may execute. Timelocked
    /// money actions arrive in Task 4.
    fn timelock_delay(_action: &Action) -> Option<u64> {
        None
    }

    /// Applies an approved proposal. A proposal that is no longer valid
    /// against current state is marked failed instead of reverting, so the
    /// final approval still lands and the outcome is on chain.
    fn execute_now(&mut self, id: ProposalId) {
        let action = self
            .proposals
            .get(&id)
            .expect("proposal exists")
            .action
            .clone();
        match self.apply(&action) {
            Ok(()) => {
                self.finish(&id, ProposalStatus::Executed);
                Event::ProposalExecuted {
                    proposal_id: id,
                    action: &action,
                }
                .emit();
                if let Action::SetSettlement {
                    dest_asset,
                    payout_mode,
                    saved_address_id,
                } = &action
                {
                    Event::SettlementChanged {
                        proposal_id: id,
                        dest_asset,
                        payout_mode: *payout_mode,
                        saved_address_id: saved_address_id.as_deref(),
                    }
                    .emit();
                }
                if action.bumps_epoch() {
                    self.signer_epoch += 1;
                }
                // Key additions/removals keep the epoch but still change who
                // can sign, so they are announced too. Origins are not.
                let signers_touched = action.kind() == ActionKind::Security
                    && !matches!(action, Action::SetOrigins(_));
                if signers_touched {
                    self.emit_signers_changed(Some(id));
                }
            }
            Err(reason) => {
                self.finish(&id, ProposalStatus::Failed);
                Event::ProposalFailed {
                    proposal_id: id,
                    reason,
                }
                .emit();
            }
        }
    }

    fn emit_signers_changed(&self, proposal_id: Option<ProposalId>) {
        Event::SignersChanged {
            proposal_id,
            signer_ids: self.signers.iter().map(|s| s.id.as_str()).collect(),
            threshold: self.threshold,
            signer_epoch: U64(self.signer_epoch),
            recovery_key_set: self.recovery_key.is_some(),
        }
        .emit();
    }

    /// Validates `action` against current state; mutates nothing.
    fn check_action(&self, action: &Action) -> Result<(), Invalid> {
        action::validate_bounds(action)?;
        match action {
            Action::AddSigner(signer) => self.check_add_signer(signer),
            Action::RemoveSigner { id } => {
                if self.signer(id).is_none() {
                    return Err("unknown signer");
                }
                self.check_threshold(self.threshold, self.signers.len() - 1)
            }
            Action::AddSignerKey { id, key } => {
                action::validate_key(key)?;
                let signer = self.signer(id).ok_or("unknown signer")?;
                if signer.keys.len() >= action::MAX_KEYS_PER_SIGNER {
                    return Err("too many keys for one signer");
                }
                self.check_new_key(key)
            }
            Action::RemoveSignerKey { id, key } => {
                let signer = self.signer(id).ok_or("unknown signer")?;
                if !signer.keys.contains(key) {
                    return Err("key is not registered to this signer");
                }
                if signer.keys.len() == 1 {
                    return Err("signer needs at least one key");
                }
                Ok(())
            }
            Action::SetThreshold(t) => self.check_threshold(*t, self.signers.len()),
            Action::SetOrigins(origins) => action::validate_origins(origins),
            Action::RotateRecoveryKey(Some(pk)) => self.check_recovery_key(pk),
            Action::RotateRecoveryKey(None) => Ok(()),
            Action::AddSavedAddress { id, chain, .. } => {
                if !saved::SUPPORTED_CHAINS.contains(&chain.as_str()) {
                    return Err("unsupported chain");
                }
                if self.saved_addresses.iter().any(|a| &a.id == id) {
                    return Err("duplicate saved address id");
                }
                if self.saved_addresses.len() >= saved::MAX_SAVED_ADDRESSES {
                    return Err("too many saved addresses");
                }
                Ok(())
            }
            Action::RemoveSavedAddress { id } => {
                if !self.saved_addresses.iter().any(|a| &a.id == id) {
                    return Err("unknown saved address");
                }
                let in_use = self
                    .settlement
                    .as_ref()
                    .and_then(|s| s.saved_address_id.as_ref());
                if in_use == Some(id) {
                    return Err("saved address is the current settlement destination");
                }
                Ok(())
            }
            Action::SetSettlement {
                payout_mode,
                saved_address_id,
                ..
            } => match (payout_mode, saved_address_id) {
                (PayoutMode::Intents, None) => Ok(()),
                (PayoutMode::Intents, Some(_)) => Err("intents settlement takes no saved address"),
                (PayoutMode::Wallet, None) => Err("wallet settlement needs a saved address"),
                (PayoutMode::Wallet, Some(id)) => self
                    .saved_address_usable(id, env::block_timestamp())
                    .map(|_| ())
                    .ok_or("saved address is unknown or not yet active"),
            },
            // Not proposable until Tasks 4-5 implement them.
            _ => Err("not yet supported"),
        }
    }

    /// Re-validates and applies `action`.
    fn apply(&mut self, action: &Action) -> Result<(), Invalid> {
        self.check_action(action)?;
        match action {
            Action::AddSigner(signer) => self.signers.push(signer.clone()),
            Action::RemoveSigner { id } => self.signers.retain(|s| &s.id != id),
            Action::AddSignerKey { id, key } => {
                self.signer_mut(id).keys.push(key.clone());
            }
            Action::RemoveSignerKey { id, key } => {
                self.signer_mut(id).keys.retain(|k| k != key);
            }
            Action::SetThreshold(t) => self.threshold = *t,
            Action::SetOrigins(origins) => self.origins = origins.clone(),
            Action::RotateRecoveryKey(pk) => self.recovery_key = *pk,
            Action::AddSavedAddress { id, chain, address } => {
                self.saved_addresses.push(SavedAddress {
                    id: id.clone(),
                    chain: chain.clone(),
                    address: address.clone(),
                    active_from: env::block_timestamp() + saved::SAVED_ADDRESS_DELAY,
                });
            }
            Action::RemoveSavedAddress { id } => self.saved_addresses.retain(|a| &a.id != id),
            Action::SetSettlement {
                dest_asset,
                payout_mode,
                saved_address_id,
            } => {
                self.settlement = Some(Settlement {
                    dest_asset: dest_asset.clone(),
                    payout_mode: *payout_mode,
                    saved_address_id: saved_address_id.clone(),
                });
            }
            _ => return Err("not yet supported"),
        }
        Ok(())
    }

    /// The saved address `id` if it may receive funds at `now`.
    pub(crate) fn saved_address_usable(&self, id: &str, now: u64) -> Option<&SavedAddress> {
        self.saved_addresses
            .iter()
            .find(|a| a.id == id && a.active_from <= now)
    }

    fn signer_mut(&mut self, id: &str) -> &mut Signer {
        self.signers
            .iter_mut()
            .find(|s| s.id == id)
            .expect("checked signer exists")
    }

    fn check_add_signer(&self, signer: &Signer) -> Result<(), Invalid> {
        action::validate_signer(signer)?;
        if self.signer(&signer.id).is_some() {
            return Err("duplicate signer");
        }
        if self.signers.len() >= action::MAX_SIGNERS {
            return Err("too many signers");
        }
        signer.keys.iter().try_for_each(|k| self.check_new_key(k))
    }

    /// A key may belong to one signer only, and never double as the
    /// recovery key; otherwise one device could count twice.
    fn check_new_key(&self, key: &SignerKey) -> Result<(), Invalid> {
        if self.key_registered(key) {
            return Err("key already registered");
        }
        if matches!((key, &self.recovery_key), (SignerKey::Ed25519(k), Some(r)) if k == r) {
            return Err("key is the recovery key");
        }
        Ok(())
    }

    fn check_recovery_key(&self, pk: &[u8; 32]) -> Result<(), Invalid> {
        if self.key_registered(&SignerKey::Ed25519(*pk)) {
            return Err("recovery key is also a signer key");
        }
        Ok(())
    }

    fn check_threshold(&self, threshold: u8, signers: usize) -> Result<(), Invalid> {
        if threshold == 0 || usize::from(threshold) > signers {
            return Err("threshold must be between 1 and the number of signers");
        }
        Ok(())
    }

    fn view(&self, id: ProposalId, p: &Proposal) -> ProposalView {
        let expires_at = p.created_at + PROPOSAL_TTL;
        let status = if p.status == ProposalStatus::Pending && env::block_timestamp() >= expires_at
        {
            ProposalStatus::Expired
        } else {
            p.status
        };
        ProposalView {
            id,
            action: p.action.clone(),
            creator: p.creator.clone(),
            created_at: U64(p.created_at),
            expires_at: U64(expires_at),
            approvals: p
                .approvals
                .iter()
                .map(|a| ApprovalView {
                    signer_id: a.signer_id.clone(),
                    key: a.key.clone(),
                    signer_epoch: U64(a.signer_epoch),
                })
                .collect(),
            valid_approvals: self.valid_approvals(p),
            ready_at: p.ready_at.map(U64),
            status,
        }
    }
}

#[cfg(test)]
mod tests;
