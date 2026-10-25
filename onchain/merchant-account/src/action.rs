//! Proposal actions and their stateless validation.
//!
//! The borsh encoding of [`Action`] is part of the approval format: the
//! proposal id is `sha256(borsh(action) ‖ salt)`, and the TypeScript encoder
//! (apps/api `encoding.ts`) must produce the same bytes. Variant order is
//! fixed; new variants may only be appended.

use near_sdk::json_types::U128;
use near_sdk::serde_with::base64::Base64;
use near_sdk::{near, AccountId};

use crate::webauthn::SignerKey;

/// Most signers one account may have.
pub const MAX_SIGNERS: usize = 20;
/// Most keys (devices) one signer may register.
pub const MAX_KEYS_PER_SIGNER: usize = 10;
/// Most allowed WebAuthn origins.
pub const MAX_ORIGINS: usize = 10;
/// Longest accepted origin string.
pub const MAX_ORIGIN_LEN: usize = 256;

/// A person who can approve proposals, with one key per registered device.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signer {
    /// The API's person id, `per_<ULID>`.
    pub id: String,
    pub keys: Vec<SignerKey>,
}

/// How a withdrawal or refund leaves the intents balance (executed in Task 4).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WithdrawRoute {
    /// PoA bridge withdrawal via `ft_withdraw` to `token_contract`.
    Poa { token_contract: AccountId },
    /// 1Click swap: `mt_transfer` to the swap's `deposit_account`.
    Swap { deposit_account: AccountId },
}

/// Where checkout settles (spec §5).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PayoutMode {
    Intents,
    Wallet,
}

/// One change a proposal makes. Borsh variant order is fixed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    AddSigner(Signer),
    RemoveSigner {
        id: String,
    },
    AddSignerKey {
        id: String,
        key: SignerKey,
    },
    RemoveSignerKey {
        id: String,
        key: SignerKey,
    },
    SetThreshold(u8),
    SetOrigins(Vec<String>),
    RotateRecoveryKey(#[serde_as(as = "Option<Base64>")] Option<[u8; 32]>),
    AddSavedAddress {
        id: String,
        chain: String,
        address: String,
    },
    RemoveSavedAddress {
        id: String,
    },
    SetLimits {
        asset: String,
        per_tx: Option<U128>,
        per_day: Option<U128>,
    },
    SetRefundCap {
        asset: String,
        daily: U128,
    },
    SetAutoSweep {
        asset: String,
        trigger_above: U128,
        keep: U128,
        saved_address_id: String,
    },
    ClearAutoSweep {
        asset: String,
    },
    Withdraw {
        asset: String,
        amount: U128,
        saved_address_id: String,
        route: WithdrawRoute,
    },
    Refund {
        asset: String,
        amount: U128,
        destination_chain: String,
        destination: String,
        payment_id: String,
        route: WithdrawRoute,
    },
    Upgrade {
        #[serde_as(as = "Base64")]
        code_hash: [u8; 32],
    },
    SetSettlement {
        dest_asset: String,
        payout_mode: PayoutMode,
        saved_address_id: Option<String>,
    },
}

/// Broad action groups, used to decide what is supported and what bumps the epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    /// Signers, keys, threshold, origins, recovery key.
    Security,
    SavedAddress,
    Limits,
    Sweep,
    Money,
    Upgrade,
    Settlement,
}

impl Action {
    pub fn kind(&self) -> ActionKind {
        match self {
            Action::AddSigner(_)
            | Action::RemoveSigner { .. }
            | Action::AddSignerKey { .. }
            | Action::RemoveSignerKey { .. }
            | Action::SetThreshold(_)
            | Action::SetOrigins(_)
            | Action::RotateRecoveryKey(_) => ActionKind::Security,
            Action::AddSavedAddress { .. } | Action::RemoveSavedAddress { .. } => {
                ActionKind::SavedAddress
            }
            Action::SetLimits { .. } | Action::SetRefundCap { .. } => ActionKind::Limits,
            Action::SetAutoSweep { .. } | Action::ClearAutoSweep { .. } => ActionKind::Sweep,
            Action::Withdraw { .. } | Action::Refund { .. } => ActionKind::Money,
            Action::Upgrade { .. } => ActionKind::Upgrade,
            Action::SetSettlement { .. } => ActionKind::Settlement,
        }
    }

    /// Whether executing this action invalidates every pending approval.
    ///
    /// Changes to who signs or how many must sign bump the signer epoch.
    /// Origins and adding/removing a device key of an existing signer do not.
    pub fn bumps_epoch(&self) -> bool {
        matches!(
            self,
            Action::AddSigner(_)
                | Action::RemoveSigner { .. }
                | Action::SetThreshold(_)
                | Action::RotateRecoveryKey(_)
        )
    }

    /// Whether this action can be proposed yet. Money, upgrade and settlement
    /// actions are enabled by later tasks.
    pub fn is_proposable(&self) -> bool {
        !matches!(
            self.kind(),
            ActionKind::Money | ActionKind::Upgrade | ActionKind::Settlement
        )
    }
}

/// A validation failure; the message is shown in the panic or `proposal_failed`.
pub type Invalid = &'static str;

/// Checks a signer id has the API's `per_<ULID>` shape: `per_` followed by 26
/// uppercase Crockford base32 characters, the first at most `7`.
pub fn validate_signer_id(id: &str) -> Result<(), Invalid> {
    const BAD: Invalid = "signer id must be per_ followed by a ULID";
    let ulid = id.strip_prefix("per_").ok_or(BAD)?.as_bytes();
    let crockford = |c: &u8| matches!(c, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z');
    if ulid.len() != 26 || !ulid.iter().all(crockford) || ulid[0] > b'7' {
        return Err(BAD);
    }
    Ok(())
}

/// Checks a key can ever verify: a P-256 key must be a point on the curve.
///
/// nearcore has no host function for point validation, so this decompresses
/// the point with the `p256` crate's field arithmetic (no ECDSA code).
pub fn validate_key(key: &SignerKey) -> Result<(), Invalid> {
    match key {
        // Only the compressed tags: `from_sec1_bytes` would also accept the
        // 33-byte "compact" form (tag 0x05), which is not what we store.
        SignerKey::P256(bytes) if matches!(bytes[0], 0x02 | 0x03) => {
            p256::PublicKey::from_sec1_bytes(bytes)
                .map(|_| ())
                .map_err(|_| "P-256 key is not a valid compressed curve point")
        }
        SignerKey::P256(_) => Err("P-256 key is not a valid compressed curve point"),
        SignerKey::Ed25519(_) => Ok(()),
    }
}

/// Checks a signer's id and keys. Uniqueness against other signers is the
/// contract's job.
pub fn validate_signer(signer: &Signer) -> Result<(), Invalid> {
    validate_signer_id(&signer.id)?;
    if signer.keys.is_empty() {
        return Err("signer needs at least one key");
    }
    if signer.keys.len() > MAX_KEYS_PER_SIGNER {
        return Err("too many keys for one signer");
    }
    for (i, key) in signer.keys.iter().enumerate() {
        validate_key(key)?;
        if signer.keys[..i].contains(key) {
            return Err("duplicate key");
        }
    }
    Ok(())
}

/// Checks the allowed-origin list: 1..=MAX_ORIGINS distinct `http(s)://`
/// origins without a path or trailing slash.
pub fn validate_origins(origins: &[String]) -> Result<(), Invalid> {
    if origins.is_empty() || origins.len() > MAX_ORIGINS {
        return Err("origins must list 1 to 10 entries");
    }
    for (i, o) in origins.iter().enumerate() {
        let host = o
            .strip_prefix("https://")
            .or_else(|| o.strip_prefix("http://"))
            .unwrap_or("");
        if host.is_empty()
            || o.len() > MAX_ORIGIN_LEN
            || host.contains('/')
            || o.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("invalid origin");
        }
        if origins[..i].contains(o) {
            return Err("duplicate origin");
        }
    }
    Ok(())
}
