//! Money out: withdrawals, refunds, per-asset limits, the rolling refund
//! cap, and auto-sweep.
//!
//! Funds sit in the intents verifier under this account. The contract moves
//! them by calling the verifier itself with 1 yocto attached (predecessor
//! authorization), with parameters fixed by an approved proposal:
//!
//! - `Poa` route: `ft_withdraw { token, receiver_id: token_contract, amount,
//!   memo: "WITHDRAW_TO:<address>" }`, for `nep141:` assets only;
//! - `Swap` route: `mt_transfer { receiver_id: deposit_account, token_id,
//!   amount }` to a 1Click deposit account.
//!
//! Rolling 24 h windows are lists of `(timestamp, amount)` per asset, charged
//! only when the verifier reports success. While a transfer is in flight its
//! amount is *reserved*, so a second withdrawal executed before the first
//! callback lands still sees it; the callback releases the reservation and,
//! on success, charges the window.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

use crate::action::{Action, Invalid, WithdrawRoute};
use crate::approval::ProposalId;
use crate::events::Event;
use crate::saved::{self, SavedAddress};
use crate::{MerchantAccount, MerchantAccountExt, ProposalStatus, HOUR};

/// Wait before a timelocked proposal may execute: swap withdrawals, refunds
/// that cross the refund cap, and raises of a limit or the refund cap.
pub const TIMELOCK_DELAY: u64 = 24 * HOUR;
/// Length of the rolling windows behind `per_day` and the refund cap.
pub const WINDOW: u64 = 24 * HOUR;
/// Most entries one window keeps; older ones are merged beyond this.
pub const MAX_WINDOW_ENTRIES: usize = 200;
/// Refund cap of an asset no `SetRefundCap` has touched: every refund waits
/// [`TIMELOCK_DELAY`] until the signers choose a cap.
pub const DEFAULT_REFUND_CAP: u128 = 0;

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
/// Gas for the verifier's `ft_withdraw` / `mt_transfer`.
const TRANSFER_GAS: Gas = Gas::from_tgas(50);
const TRANSFER_CALLBACK_GAS: Gas = Gas::from_tgas(25);
const BALANCE_GAS: Gas = Gas::from_tgas(10);
/// Covers the sweep transfer (50), its callback (25) and this callback's own
/// work, with headroom.
const SWEEP_BALANCE_CALLBACK_GAS: Gas = Gas::from_tgas(100);
/// PoA token account suffix used when `InitConfig.poa_suffix` is not given.
pub const DEFAULT_POA_SUFFIX: &str = "omft.near";
/// Chain prefix of a PoA token account (`<prefix>-….<poa_suffix>` or
/// `<prefix>.<poa_suffix>`) → the destination chain it bridges to.
/// The exact omft prefixes are verified by the mainnet check script (Task 15).
pub const POA_CHAIN_PREFIXES: [(&str, &str); 10] = [
    ("eth", "eth"),
    ("base", "base"),
    ("arb", "arbitrum"),
    ("sol", "sol"),
    ("tron", "tron"),
    ("btc", "btc"),
    ("bsc", "bsc"),
    ("pol", "polygon"),
    ("op", "optimism"),
    ("avax", "avalanche"),
];
/// Longest promise result read; a verifier answer is far shorter.
const MAX_RESULT_LEN: usize = 1024;

/// A rolling 24 h sum of `(timestamp, amount)` entries, oldest first.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Window {
    entries: Vec<(u64, u128)>,
}

impl Window {
    /// Sum of the entries charged within the last 24 h before `now`.
    pub fn sum(&self, now: u64) -> u128 {
        self.entries
            .iter()
            .filter(|(t, _)| live(*t, now))
            .fold(0, |s, (_, a)| s.saturating_add(*a))
    }

    /// Records `amount` at `now`, dropping entries older than 24 h.
    ///
    /// Past [`MAX_WINDOW_ENTRIES`] the two oldest entries merge into one that
    /// carries the newer timestamp: the merged amount then stays counted at
    /// least as long as either part would have, so the sum can over-count
    /// for a while but never under-counts.
    pub fn charge(&mut self, now: u64, amount: u128) {
        self.entries.retain(|(t, _)| live(*t, now));
        self.entries.push((now, amount));
        while self.entries.len() > MAX_WINDOW_ENTRIES {
            let (_, oldest) = self.entries.remove(0);
            let next = &mut self.entries[0];
            next.1 = next.1.saturating_add(oldest);
        }
    }

    #[cfg(test)]
    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }
}

fn live(charged_at: u64, now: u64) -> bool {
    charged_at.saturating_add(WINDOW) > now
}

/// An auto-sweep rule. The destination's chain and address are copied at
/// set time, so re-using the saved-address id for another address never
/// redirects the sweep.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoSweep {
    pub trigger_above: u128,
    pub keep: u128,
    pub saved_address_id: String,
    pub chain: String,
    pub address: String,
}

/// Everything the contract tracks per asset id.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetState {
    /// Most one withdrawal may move; `None` is unlimited.
    pub per_tx: Option<u128>,
    /// Most withdrawals may move in any 24 h; `None` is unlimited.
    pub per_day: Option<u128>,
    /// Refunds above this in any 24 h wait [`TIMELOCK_DELAY`].
    pub refund_cap: u128,
    pub withdrawn: Window,
    pub refunded: Window,
    /// Withdrawals sent but not yet confirmed by their callback.
    pub withdraw_in_flight: u128,
    /// Refunds sent but not yet confirmed by their callback.
    pub refund_in_flight: u128,
    pub sweep: Option<AutoSweep>,
    pub sweep_in_flight: bool,
}

impl Default for AssetState {
    fn default() -> Self {
        Self {
            per_tx: None,
            per_day: None,
            refund_cap: DEFAULT_REFUND_CAP,
            withdrawn: Window::default(),
            refunded: Window::default(),
            withdraw_in_flight: 0,
            refund_in_flight: 0,
            sweep: None,
            sweep_in_flight: false,
        }
    }
}

impl AssetState {
    /// Withdrawn in the last 24 h plus withdrawals in flight.
    pub fn spent(&self, now: u64) -> u128 {
        self.withdrawn
            .sum(now)
            .saturating_add(self.withdraw_in_flight)
    }

    /// Refunded in the last 24 h plus refunds in flight.
    pub fn refunded_total(&self, now: u64) -> u128 {
        self.refunded.sum(now).saturating_add(self.refund_in_flight)
    }
}

/// A timelocked raise of an asset's limits, as the limits will read once it
/// executes.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRaise {
    pub proposal_id: ProposalId,
    pub per_tx: Option<U128>,
    pub per_day: Option<U128>,
    pub refund_cap: U128,
    pub ready_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LimitsView {
    pub per_tx: Option<U128>,
    pub per_day: Option<U128>,
    pub refund_cap: U128,
    /// The timelocked raise that becomes ready first, if any.
    pub pending_raise: Option<PendingRaise>,
    /// Withdrawn in the last 24 h, including withdrawals in flight.
    pub spent_24h: U128,
    /// Refunded in the last 24 h, including refunds in flight.
    pub refunded_24h: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AutoSweepView {
    pub trigger_above: U128,
    pub keep: U128,
    pub saved_address_id: String,
    pub chain: String,
    pub address: String,
    pub in_flight: bool,
}

/// The NEP-141 token account behind a `nep141:` asset id.
fn poa_token(asset: &str) -> Result<AccountId, Invalid> {
    asset
        .strip_prefix("nep141:")
        .and_then(|t| t.parse().ok())
        .ok_or("poa route needs a nep141 asset")
}

fn positive(amount: U128) -> Result<(), Invalid> {
    if amount.0 == 0 {
        return Err("amount must be positive");
    }
    Ok(())
}

/// Whether moving a limit from `old` to `new` loosens it (`None` = unlimited).
fn raises(old: Option<u128>, new: Option<U128>) -> bool {
    match (old, new) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(o), Some(n)) => n.0 > o,
    }
}

/// Whether the outgoing call behind the pending callback succeeded.
///
/// `ft_withdraw` returns the amount withdrawn; the verifier returns 0 when
/// the token transfer failed and it refunded the balance. `mt_transfer`
/// returns nothing. A result too long to read means the call itself
/// succeeded, so it counts as sent (charging the window is the safe side).
fn transfer_succeeded() -> bool {
    match env::promise_result_checked(0, MAX_RESULT_LEN) {
        Err(PromiseError::Failed) => false,
        Err(_) => true,
        Ok(bytes) if bytes.is_empty() => true,
        Ok(bytes) => serde_json::from_slice::<U128>(&bytes).map_or(true, |v| v.0 > 0),
    }
}

/// The asset, amount and kind (refund or not) a money action moves.
fn transfer_parts(action: &Action) -> (&str, u128, bool) {
    match action {
        Action::Withdraw { asset, amount, .. } => (asset, amount.0, false),
        Action::Refund { asset, amount, .. } => (asset, amount.0, true),
        _ => env::panic_str("not a money action"),
    }
}

impl MerchantAccount {
    /// The tracked state of `asset`, or defaults if nothing touched it yet.
    pub(crate) fn asset(&self, asset: &str) -> AssetState {
        self.assets.get(asset).cloned().unwrap_or_default()
    }

    fn update_asset(&mut self, asset: &str, f: impl FnOnce(&mut AssetState)) {
        let mut state = self.asset(asset);
        f(&mut state);
        self.assets.insert(asset.to_owned(), state);
    }

    /// The saved address a sweep may send to at `now`: the rule's id, still
    /// usable, and still the chain and address the rule was set with.
    fn sweep_destination(&self, sweep: &AutoSweep, now: u64) -> Option<&SavedAddress> {
        self.saved_address_usable(&sweep.saved_address_id, now)
            .filter(|a| a.chain == sweep.chain && a.address == sweep.address)
    }

    /// Where a `Poa`-route `ft_withdraw` of `asset` to `address` on `chain`
    /// goes, as `(receiver_id, memo)`.
    ///
    /// - `near`: a plain NEP-141 transfer to the NEAR account `address`, no
    ///   memo; any `nep141:` asset.
    /// - any other chain: the asset must be a PoA bridge token (account ends
    ///   in `.<poa_suffix>`) whose chain prefix maps to `chain`; the tokens go
    ///   to the token contract, which bridges them to `WITHDRAW_TO:<address>`.
    ///   `ft_withdraw` to a non-PoA token contract would just park the funds
    ///   in that contract's own balance, so it is refused.
    pub(crate) fn poa_target(
        &self,
        asset: &str,
        chain: &str,
        address: &str,
    ) -> Result<(AccountId, Option<String>), Invalid> {
        let token = poa_token(asset)?;
        if chain == "near" {
            let to = address
                .parse()
                .map_err(|_| "near destination must be a valid NEAR account id")?;
            return Ok((to, None));
        }
        let prefix = token
            .as_str()
            .strip_suffix(self.poa_suffix.as_str())
            .and_then(|s| s.strip_suffix('.'))
            .filter(|s| !s.is_empty())
            .ok_or("asset is not a PoA bridge token")?;
        let label = prefix.split(['-', '.']).next().unwrap_or_default();
        let bridged = POA_CHAIN_PREFIXES
            .iter()
            .find(|(p, _)| *p == label)
            .map(|(_, c)| *c)
            .ok_or("asset is not a PoA bridge token")?;
        if bridged != chain {
            return Err("asset's PoA bridge does not serve the destination chain");
        }
        Ok((token, Some(format!("WITHDRAW_TO:{address}"))))
    }

    /// Checks `route` can deliver `asset` to `address` on `chain`.
    ///
    /// A `Poa` route must name the asset's own token contract: `ft_withdraw`
    /// hands the tokens to `receiver_id`, so any other account would receive
    /// them on NEAR. Its real receiver comes from [`Self::poa_target`].
    fn check_route(
        &self,
        asset: &str,
        route: &WithdrawRoute,
        chain: &str,
        address: &str,
    ) -> Result<(), Invalid> {
        match route {
            WithdrawRoute::Poa { token_contract } => {
                if &poa_token(asset)? != token_contract {
                    return Err("poa route must withdraw through the asset's token contract");
                }
                self.poa_target(asset, chain, address).map(|_| ())
            }
            WithdrawRoute::Swap { .. } => Ok(()),
        }
    }

    /// Validates a limits, sweep or money action against current state.
    pub(crate) fn check_money(&self, action: &Action, now: u64) -> Result<(), Invalid> {
        match action {
            Action::Withdraw {
                asset,
                amount,
                saved_address_id,
                route,
            } => {
                positive(*amount)?;
                let dest = self
                    .saved_address_usable(saved_address_id, now)
                    .ok_or("saved address is unknown or not yet active")?;
                self.check_route(asset, route, &dest.chain, &dest.address)?;
                let state = self.asset(asset);
                if state.per_tx.is_some_and(|max| amount.0 > max) {
                    return Err("amount exceeds the per-withdrawal limit");
                }
                if state
                    .per_day
                    .is_some_and(|max| state.spent(now).saturating_add(amount.0) > max)
                {
                    return Err("amount exceeds the daily withdrawal limit");
                }
                Ok(())
            }
            // No saved address: the destination is the payment's sender,
            // pinned by the API. The refund cap decides the timelock instead.
            Action::Refund {
                asset,
                amount,
                destination_chain,
                destination,
                route,
                ..
            } => {
                positive(*amount)?;
                if !saved::SUPPORTED_CHAINS.contains(&destination_chain.as_str()) {
                    return Err("unsupported chain");
                }
                self.check_route(asset, route, destination_chain, destination)
            }
            Action::SetLimits { .. } | Action::SetRefundCap { .. } => Ok(()),
            Action::SetAutoSweep {
                asset,
                trigger_above,
                keep,
                saved_address_id,
            } => {
                if keep.0 > trigger_above.0 {
                    return Err("keep must not exceed trigger_above");
                }
                let dest = self
                    .saved_addresses
                    .iter()
                    .find(|a| &a.id == saved_address_id)
                    .ok_or("unknown saved address")?;
                // Sweeps leave through the PoA route.
                self.poa_target(asset, &dest.chain, &dest.address)
                    .map(|_| ())
            }
            Action::ClearAutoSweep { asset } => {
                if self.asset(asset).sweep.is_none() {
                    return Err("no auto-sweep for this asset");
                }
                Ok(())
            }
            _ => Err("not a money action"),
        }
    }

    /// Whether `action`, approved now, must wait [`TIMELOCK_DELAY`].
    pub(crate) fn money_needs_timelock(&self, action: &Action, now: u64) -> bool {
        match action {
            Action::Withdraw { route, .. } => matches!(route, WithdrawRoute::Swap { .. }),
            Action::Refund { asset, amount, .. } => {
                let state = self.asset(asset);
                state.refunded_total(now).saturating_add(amount.0) > state.refund_cap
            }
            Action::SetLimits {
                asset,
                per_tx,
                per_day,
            } => {
                let state = self.asset(asset);
                raises(state.per_tx, *per_tx) || raises(state.per_day, *per_day)
            }
            Action::SetRefundCap { asset, daily } => daily.0 > self.asset(asset).refund_cap,
            _ => false,
        }
    }

    /// Applies an already checked limits or sweep action.
    pub(crate) fn apply_money_setting(&mut self, action: &Action) {
        match action {
            Action::SetLimits {
                asset,
                per_tx,
                per_day,
            } => self.update_asset(asset, |s| {
                s.per_tx = per_tx.map(|v| v.0);
                s.per_day = per_day.map(|v| v.0);
            }),
            Action::SetRefundCap { asset, daily } => {
                self.update_asset(asset, |s| s.refund_cap = daily.0)
            }
            Action::SetAutoSweep {
                asset,
                trigger_above,
                keep,
                saved_address_id,
            } => {
                let dest = self
                    .saved_addresses
                    .iter()
                    .find(|a| &a.id == saved_address_id)
                    .expect("checked saved address exists")
                    .clone();
                self.update_asset(asset, |s| {
                    s.sweep = Some(AutoSweep {
                        trigger_above: trigger_above.0,
                        keep: keep.0,
                        saved_address_id: dest.id,
                        chain: dest.chain,
                        address: dest.address,
                    })
                });
            }
            // Also clears the in-flight flag, so the signers can recover a
            // sweep whose callback never landed. A late callback then finds
            // no rule and sends nothing.
            Action::ClearAutoSweep { asset } => self.update_asset(asset, |s| {
                s.sweep = None;
                s.sweep_in_flight = false;
            }),
            _ => env::panic_str("not a money setting"),
        }
    }

    /// The verifier call that moves `amount` of `asset` out by `route` to
    /// `address` on `chain`. The route was checked with [`Self::check_route`].
    fn outgoing_call(
        &self,
        asset: &str,
        amount: u128,
        route: &WithdrawRoute,
        chain: &str,
        address: &str,
    ) -> Promise {
        let (method, args) = match route {
            WithdrawRoute::Poa { .. } => {
                let (receiver_id, memo) = self
                    .poa_target(asset, chain, address)
                    .unwrap_or_else(|e| env::panic_str(e));
                let mut args = json!({
                    "token": poa_token(asset).expect("checked nep141 asset"),
                    "receiver_id": receiver_id,
                    "amount": U128(amount),
                });
                if let Some(memo) = memo {
                    args["memo"] = json!(memo);
                }
                ("ft_withdraw", args)
            }
            WithdrawRoute::Swap { deposit_account } => (
                "mt_transfer",
                json!({
                    "receiver_id": deposit_account,
                    "token_id": asset,
                    "amount": U128(amount),
                }),
            ),
        };
        Promise::new(self.intents_contract.clone()).function_call(
            method,
            args.to_string(),
            ONE_YOCTO,
            TRANSFER_GAS,
        )
    }

    /// Sends a checked withdrawal or refund, reserving its amount until the
    /// callback. The proposal waits in `Executing` meanwhile.
    pub(crate) fn start_transfer(&mut self, id: ProposalId, action: &Action) {
        let (asset, amount, is_refund) = transfer_parts(action);
        let (route, chain, to) = match action {
            Action::Withdraw {
                saved_address_id,
                route,
                ..
            } => {
                let dest = self
                    .saved_address_usable(saved_address_id, env::block_timestamp())
                    .expect("checked saved address is usable");
                (route, dest.chain.clone(), dest.address.clone())
            }
            Action::Refund {
                destination,
                destination_chain,
                route,
                ..
            } => (route, destination_chain.clone(), destination.clone()),
            _ => unreachable!("transfer_parts accepts money actions only"),
        };
        let call = self.outgoing_call(asset, amount, route, &chain, &to);
        self.update_asset(asset, |s| {
            if is_refund {
                s.refund_in_flight = s.refund_in_flight.saturating_add(amount);
            } else {
                s.withdraw_in_flight = s.withdraw_in_flight.saturating_add(amount);
            }
        });
        self.finish(&id, ProposalStatus::Executing);
        call.then(
            Self::ext(env::current_account_id())
                .with_static_gas(TRANSFER_CALLBACK_GAS)
                .on_transfer_done(id),
        )
        .detach();
    }

    fn pending_raise(&self, asset: &str, state: &AssetState, now: u64) -> Option<PendingRaise> {
        self.timelocked
            .iter()
            .filter_map(|id| {
                let p = self.proposals.get(id)?;
                if p.status != ProposalStatus::Pending || now >= p.created_at + crate::PROPOSAL_TTL
                {
                    return None;
                }
                let ready_at = self.live_ready_at(p)?;
                let mut raise = PendingRaise {
                    proposal_id: *id,
                    per_tx: state.per_tx.map(U128),
                    per_day: state.per_day.map(U128),
                    refund_cap: U128(state.refund_cap),
                    ready_at: U64(ready_at),
                };
                match &p.action {
                    Action::SetLimits {
                        asset: a,
                        per_tx,
                        per_day,
                    } if a == asset => {
                        raise.per_tx = *per_tx;
                        raise.per_day = *per_day;
                    }
                    Action::SetRefundCap { asset: a, daily } if a == asset => {
                        raise.refund_cap = *daily;
                    }
                    _ => return None,
                }
                Some(raise)
            })
            .min_by_key(|r| r.ready_at.0)
    }
}

#[near]
impl MerchantAccount {
    /// Limits, refund cap and rolling usage of `asset`.
    pub fn get_limits(&self, asset: String) -> LimitsView {
        let now = env::block_timestamp();
        let state = self.asset(&asset);
        LimitsView {
            per_tx: state.per_tx.map(U128),
            per_day: state.per_day.map(U128),
            refund_cap: U128(state.refund_cap),
            pending_raise: self.pending_raise(&asset, &state, now),
            spent_24h: U128(state.spent(now)),
            refunded_24h: U128(state.refunded_total(now)),
        }
    }

    pub fn get_auto_sweep(&self, asset: String) -> Option<AutoSweepView> {
        let state = self.asset(&asset);
        state.sweep.map(|s| AutoSweepView {
            trigger_above: U128(s.trigger_above),
            keep: U128(s.keep),
            saved_address_id: s.saved_address_id,
            chain: s.chain,
            address: s.address,
            in_flight: state.sweep_in_flight,
        })
    }

    /// Runs the auto-sweep rule of `asset`. Anyone may call it: the rule and
    /// its destination are fixed by an approved proposal, and the amount
    /// comes from the verifier's own balance report.
    pub fn trigger_sweep(&mut self, asset: String) {
        let state = self.asset(&asset);
        let sweep = state
            .sweep
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no auto-sweep for this asset"));
        require!(!state.sweep_in_flight, "sweep already in flight");
        require!(
            self.sweep_destination(sweep, env::block_timestamp())
                .is_some(),
            "sweep destination is unknown or not yet active"
        );
        self.update_asset(&asset, |s| s.sweep_in_flight = true);
        let args = json!({
            "account_id": env::current_account_id(),
            "token_ids": [&asset],
        });
        Promise::new(self.intents_contract.clone())
            .function_call(
                "mt_batch_balance_of",
                args.to_string(),
                NO_DEPOSIT,
                BALANCE_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SWEEP_BALANCE_CALLBACK_GAS)
                    .on_sweep_balance(asset),
            )
            .detach();
    }

    /// Settles a withdrawal or refund: charges its window on success, marks
    /// the proposal failed otherwise, and releases the reservation.
    #[private]
    pub fn on_transfer_done(&mut self, proposal_id: ProposalId) -> bool {
        let proposal = self
            .proposals
            .get(&proposal_id)
            .unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(
            proposal.status == ProposalStatus::Executing,
            "proposal is not executing"
        );
        let action = proposal.action.clone();
        let (asset, amount, is_refund) = transfer_parts(&action);
        let ok = transfer_succeeded();
        let now = env::block_timestamp();
        self.update_asset(asset, |s| {
            let (window, in_flight) = if is_refund {
                (&mut s.refunded, &mut s.refund_in_flight)
            } else {
                (&mut s.withdrawn, &mut s.withdraw_in_flight)
            };
            *in_flight = in_flight.saturating_sub(amount);
            if ok {
                window.charge(now, amount);
            }
        });
        let status = if ok {
            ProposalStatus::Executed
        } else {
            ProposalStatus::Failed
        };
        self.proposals
            .get_mut(&proposal_id)
            .expect("proposal exists")
            .status = status;
        if ok {
            Event::ProposalExecuted {
                proposal_id,
                action: &action,
            }
            .emit();
        } else {
            Event::ProposalFailed {
                proposal_id,
                reason: "outgoing transfer failed",
            }
            .emit();
        }
        ok
    }

    /// Second step of a sweep: sends `balance − keep` if the balance is
    /// above the trigger and the destination is still the rule's.
    #[private]
    pub fn on_sweep_balance(&mut self, asset: String) {
        let now = env::block_timestamp();
        let balance = env::promise_result_checked(0, MAX_RESULT_LEN)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<U128>>(&b).ok())
            .and_then(|v| v.first().map(|x| x.0));
        let state = self.asset(&asset);
        let plan = match (state.sweep.as_ref(), balance) {
            (Some(rule), Some(balance)) if balance > rule.trigger_above => self
                .sweep_destination(rule, now)
                // Re-checked here too: the PoA bridge must still serve the
                // destination chain under the current configuration.
                .filter(|dest| self.poa_target(&asset, &dest.chain, &dest.address).is_ok())
                .map(|dest| {
                    (
                        balance - rule.keep,
                        rule.saved_address_id.clone(),
                        dest.chain.clone(),
                        dest.address.clone(),
                    )
                }),
            _ => None,
        };
        let Some((amount, saved_address_id, chain, address)) = plan else {
            self.update_asset(&asset, |s| s.sweep_in_flight = false);
            return;
        };
        let token_contract = poa_token(&asset).expect("checked nep141 asset");
        self.outgoing_call(
            &asset,
            amount,
            &WithdrawRoute::Poa { token_contract },
            &chain,
            &address,
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(TRANSFER_CALLBACK_GAS)
                .on_sweep_done(asset, U128(amount), saved_address_id),
        )
        .detach();
    }

    /// Last step of a sweep: clears the in-flight flag and reports success.
    #[private]
    pub fn on_sweep_done(&mut self, asset: String, amount: U128, saved_address_id: String) -> bool {
        self.update_asset(&asset, |s| s.sweep_in_flight = false);
        let ok = transfer_succeeded();
        if ok {
            Event::SweepExecuted {
                asset: &asset,
                amount,
                saved_address_id: &saved_address_id,
            }
            .emit();
        }
        ok
    }
}

#[cfg(test)]
mod window_tests {
    use super::*;

    const T: u64 = 1_700_000_000_000_000_000;

    #[test]
    fn rolling_sum_drops_entries_after_24h() {
        let mut w = Window::default();
        w.charge(T, 10);
        w.charge(T + HOUR, 5);
        assert_eq!(w.sum(T + WINDOW - 1), 15);
        assert_eq!(w.sum(T + WINDOW), 5);
        assert_eq!(w.sum(T + HOUR + WINDOW), 0);
        // Writes prune.
        w.charge(T + WINDOW, 1);
        assert_eq!(w.entry_count(), 2);
    }

    #[test]
    fn overflowing_entries_merge_without_undercounting() {
        let mut w = Window::default();
        for i in 0..(MAX_WINDOW_ENTRIES as u64 + 5) {
            w.charge(T + i, 1);
        }
        assert_eq!(w.entry_count(), MAX_WINDOW_ENTRIES);
        let total = MAX_WINDOW_ENTRIES as u128 + 5;
        assert_eq!(w.sum(T + 300), total);
        // The first six charges were merged into the entry stamped T + 5, so
        // the oldest (T) still counts until T + 5 + 24h: over-count, never under.
        assert_eq!(w.sum(T + WINDOW), total);
        assert_eq!(w.sum(T + 5 + WINDOW), total - 6);
    }
}
