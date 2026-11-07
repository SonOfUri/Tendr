//! Saved withdrawal addresses and the checkout settlement choice.
//!
//! A saved address cannot receive funds until [`SAVED_ADDRESS_DELAY`] after
//! it was added, so a compromised quorum cannot add an address and sweep to
//! it in one sitting. Removal is immediate.

use near_sdk::json_types::U64;
use near_sdk::near;

use crate::action::PayoutMode;
use crate::HOUR;

/// How long a new saved address waits before it can receive funds.
pub const SAVED_ADDRESS_DELAY: u64 = 24 * HOUR;
/// Most saved addresses one account may hold; bounds contract storage.
pub const MAX_SAVED_ADDRESSES: usize = 50;
/// Chains named before Intents chain ids were accepted as any short slug.
/// Kept so older tests and callers can list the original set.
pub const SUPPORTED_CHAINS: [&str; 11] = [
    "near",
    "eth",
    "base",
    "arbitrum",
    "polygon",
    "bsc",
    "optimism",
    "avalanche",
    "sol",
    "tron",
    "btc",
];

/// A 1Click `blockchain` id. Any new Intents chain that fits this shape is allowed;
/// the API still checks the id against the live catalog.
pub fn is_supported_chain(chain: &str) -> bool {
    let bytes = chain.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 16
        && bytes
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedAddress {
    pub id: String,
    pub chain: String,
    pub address: String,
    /// Block timestamp (ns) from which the address may receive funds.
    pub active_from: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedAddressView {
    pub id: String,
    pub chain: String,
    pub address: String,
    pub active_from: U64,
}

impl From<&SavedAddress> for SavedAddressView {
    fn from(a: &SavedAddress) -> Self {
        Self {
            id: a.id.clone(),
            chain: a.chain.clone(),
            address: a.address.clone(),
            active_from: U64(a.active_from),
        }
    }
}

/// Where checkout settles, as last set by an executed `SetSettlement`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub dest_asset: String,
    pub payout_mode: PayoutMode,
    pub saved_address_id: Option<String>,
}
