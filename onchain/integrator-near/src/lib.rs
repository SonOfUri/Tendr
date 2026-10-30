//! Reference NEAR contract for Tendr integrator hooks (gasless spec §4).
//!
//! An integrator settles its Tendr payments into its own contract. Once a payment has settled
//! there, Tendr's relayer (`relayer-near`) calls
//! `on_tendr_deposit({ payment_id, session_id, hook_data, token, amount, tx_hash })` with the
//! payment's details and the `hook_data` the integrator gave at session creation (its player or
//! order reference, JSON text). This contract shows the checks every integrator contract MUST
//! keep; put your own bookkeeping in `credit`.
//!
//! Required checks (keep all of them):
//! 1. Sender: only Tendr's published relayer account may call (`relayer`).
//! 2. Balance: credit at most what arrived and is not yet accounted for:
//!    `min(amount, ft_balance_of(self) − accounted[token])`, then `accounted[token] += credited`.
//!    A NEAR contract cannot read a token balance synchronously, so the call asks the token
//!    (`ft_balance_of`) and credits in the `on_balance` callback, where the read, the check and the
//!    update happen in one receipt.
//! 3. Duplicates: each settlement transaction (`tx_hash`) is credited once (checked at the call and
//!    again, atomically, in the callback). Keep the panic message exactly `already notified`:
//!    on a retry or resend Tendr reads it as "already delivered".
//!
//! Storage: `notified` and `accounted` grow forever and NEAR charges storage staking from this
//! contract's balance (about 0.001 NEAR per notified transaction); keep enough NEAR in it.
//! 4. Outflows: whatever moves tokens out (withdrawals, payouts) must lower `accounted[token]` by
//!    the same amount; and because the balance is read one receipt before the callback runs, an
//!    outflow between the two can make the read stale: an outflow must also make pending callbacks
//!    credit nothing (e.g. an epoch counter the callback checks). This reference has no outflow.
//!
//! Misattribution limit (read this): these checks stop a compromised relayer key from crediting
//! money that never arrived, but NOT from crediting it to the wrong reference. With two deposits
//! pending (player A's and player B's), a forged call naming player A and both amounts credits A
//! with B's deposit, and B's own call then credits nothing: the settlement transfer itself carries
//! no reference. Integrators who need stronger guarantees reconcile each credit against Tendr's
//! signed `payment.succeeded` / `hook.succeeded` webhooks (same payment, amount and transaction).
//!
//! Gas: Tendr attaches 50 Tgas and deducts its estimate (30 Tgas burnt) from the payment's own
//! proceeds. A call that fails on chain (a panic, a failed token lookup) is not retried: reported to
//! the integrator as `hook.failed`.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, PanicOnDefault, Promise, PromiseError,
};

/// Gas for the token's `ft_balance_of` (a view call).
pub const FT_BALANCE_OF_GAS: Gas = Gas::from_tgas(5);
/// Gas for the `on_balance` callback.
pub const ON_BALANCE_GAS: Gas = Gas::from_tgas(15);

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

/// One hook call's arguments, carried to the `on_balance` callback.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Deposit {
    pub payment_id: String,
    pub session_id: String,
    pub hook_data: String,
    pub token: AccountId,
    pub amount: U128,
    pub tx_hash: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TendrDepositReceiver {
    /// Tendr's relayer (`relayer-near`) account: the only allowed caller.
    relayer: AccountId,
    /// Per token, how much has been credited.
    accounted: LookupMap<AccountId, u128>,
    /// Settlement transactions already credited.
    notified: LookupSet<String>,
}

#[near]
impl TendrDepositReceiver {
    #[init]
    pub fn new(relayer: AccountId) -> Self {
        Self {
            relayer,
            accounted: LookupMap::new(b"a"),
            notified: LookupSet::new(b"n"),
        }
    }

    /// Tendr's hook: a payment settled into this contract. Asks the token for this contract's
    /// balance; `on_balance` credits `min(amount, balance − accounted)`.
    pub fn on_tendr_deposit(
        &mut self,
        payment_id: String,
        session_id: String,
        hook_data: String,
        token: AccountId,
        amount: U128,
        tx_hash: String,
    ) -> Promise {
        require!(
            env::predecessor_account_id() == self.relayer,
            "only the Tendr relayer may call"
        );
        require!(!tx_hash.is_empty(), "tx_hash is required");
        require!(!self.notified.contains(&tx_hash), "already notified");
        let deposit = Deposit {
            payment_id,
            session_id,
            hook_data,
            token: token.clone(),
            amount,
            tx_hash,
        };
        ext_ft::ext(token)
            .with_static_gas(FT_BALANCE_OF_GAS)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_BALANCE_GAS)
                    .on_balance(deposit),
            )
    }

    /// The token's answer. Fails (nothing recorded, so a resend is accepted) when the lookup
    /// failed or the transaction was credited meanwhile; otherwise credits and returns the amount.
    #[private]
    pub fn on_balance(
        &mut self,
        #[callback_result] balance: Result<U128, PromiseError>,
        deposit: Deposit,
    ) -> U128 {
        let balance = match balance {
            Ok(b) => b.0,
            Err(_) => env::panic_str("the token balance lookup failed"),
        };
        let Deposit {
            payment_id,
            session_id,
            hook_data,
            token,
            amount,
            tx_hash,
        } = deposit;
        require!(self.notified.insert(tx_hash.clone()), "already notified");
        let done = self.accounted.get(&token).copied().unwrap_or(0);
        let credited = amount.0.min(balance.saturating_sub(done));
        self.accounted.insert(token.clone(), done + credited);
        self.credit(&hook_data, &token, credited);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({
                "standard": "tendr_deposit",
                "version": "1.0.0",
                "event": "tendr_deposit",
                "data": [{
                    "payment_id": payment_id,
                    "session_id": session_id,
                    "hook_data": hook_data,
                    "token": token,
                    "amount": amount,
                    "credited": U128(credited),
                    "tx_hash": tx_hash,
                }],
            })
        ));
        U128(credited)
    }

    /// How much of `token` has been credited.
    pub fn accounted(&self, token: AccountId) -> U128 {
        U128(self.accounted.get(&token).copied().unwrap_or(0))
    }

    /// Whether settlement transaction `tx_hash` was credited.
    pub fn notified(&self, tx_hash: String) -> bool {
        self.notified.contains(&tx_hash)
    }

    pub fn relayer(&self) -> AccountId {
        self.relayer.clone()
    }
}

impl TendrDepositReceiver {
    /// The integrator's own bookkeeping (e.g. a player balance). `credited` may be 0.
    fn credit(&mut self, _hook_data: &str, _token: &AccountId, _credited: u128) {}
}

#[cfg(test)]
mod tests;
