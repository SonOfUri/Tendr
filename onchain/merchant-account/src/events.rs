//! NEP-297 events: `EVENT_JSON:{"standard":"tendr-merchant-account","version":"1.0.0","event":…,"data":…}`.
//!
//! The worker reads these from chain to drive notices and the Postgres
//! mirror, so a compromised website cannot suppress them.

use near_sdk::json_types::U64;
use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json};

use crate::action::{Action, PayoutMode};
use crate::approval::ProposalId;

pub const EVENT_STANDARD: &str = "tendr-merchant-account";
pub const EVENT_VERSION: &str = "1.0.0";

/// Every event this contract emits. `data` is the variant's fields.
#[derive(Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum Event<'a> {
    ProposalCreated {
        proposal_id: ProposalId,
        signer_id: &'a str,
        action: &'a Action,
        expires_at: U64,
    },
    ProposalApproved {
        proposal_id: ProposalId,
        signer_id: &'a str,
        signer_epoch: U64,
        approvals: u8,
        threshold: u8,
    },
    ProposalCancelled {
        proposal_id: ProposalId,
        signer_id: &'a str,
    },
    ProposalExecuted {
        proposal_id: ProposalId,
        action: &'a Action,
    },
    ProposalFailed {
        proposal_id: ProposalId,
        reason: &'a str,
    },
    TimelockStarted {
        proposal_id: ProposalId,
        action: &'a Action,
        ready_at: U64,
    },
    SignersChanged {
        proposal_id: Option<ProposalId>,
        signer_ids: Vec<&'a str>,
        threshold: u8,
        signer_epoch: U64,
        recovery_key_set: bool,
    },
    RecoveryStarted {
        new_signer_ids: Vec<&'a str>,
        new_threshold: u8,
        executes_at: U64,
    },
    RecoveryCancelled {
        signer_id: &'a str,
    },
    RecoveryExecuted {
        new_signer_ids: Vec<&'a str>,
        new_threshold: u8,
        signer_epoch: U64,
    },
    SweepExecuted {
        asset: &'a str,
        amount: near_sdk::json_types::U128,
        saved_address_id: &'a str,
    },
    SettlementChanged {
        proposal_id: ProposalId,
        dest_asset: &'a str,
        payout_mode: PayoutMode,
        saved_address_id: Option<&'a str>,
    },
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a> {
    standard: &'static str,
    version: &'static str,
    #[serde(flatten)]
    event: &'a Event<'a>,
}

impl Event<'_> {
    /// The full `EVENT_JSON:` log line.
    pub fn to_log(&self) -> String {
        let json = serde_json::to_string(&Envelope {
            standard: EVENT_STANDARD,
            version: EVENT_VERSION,
            event: self,
        })
        .expect("event serializes");
        format!("EVENT_JSON:{json}")
    }

    pub fn emit(&self) {
        env::log_str(&self.to_log());
    }
}
