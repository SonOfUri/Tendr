//! Test-only stand-in for the NEAR Intents verifier (`intents.near`).
//!
//! It keeps per-account multi-token balances and implements the calls the
//! merchant-account contract makes, with the same argument names and the
//! same 1-yocto requirement as the real verifier. Every money call is
//! recorded as `(method, predecessor, attached_deposit, args)` so tests can
//! check exactly what the merchant contract sent.
//!
//! `deposit` mints balance out of thin air for anyone. That is why this
//! contract is deployed only to testnet (`intents-mock.tendr.testnet`) and
//! the sandbox, never to mainnet.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken};

/// One recorded call. `args` is the call's arguments as a JSON string.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallRecord {
    pub method: String,
    pub predecessor: AccountId,
    /// Attached deposit in yoctoNEAR.
    pub attached_deposit: U128,
    pub args: String,
}

#[near(contract_state)]
pub struct MockIntents {
    balances: LookupMap<(AccountId, String), u128>,
    calls: Vector<CallRecord>,
}

impl Default for MockIntents {
    fn default() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            calls: Vector::new(b"c"),
        }
    }
}

fn assert_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        "Requires attached deposit of exactly 1 yoctoNEAR"
    );
}

#[near]
impl MockIntents {
    /// Moves `amount` of `token_id` from the caller to `receiver_id`.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        self.record(
            "mt_transfer",
            json!({
                "receiver_id": receiver_id,
                "token_id": token_id,
                "amount": amount,
                "approval": approval,
                "memo": memo,
            }),
        );
        let sender = env::predecessor_account_id();
        self.debit(&sender, &token_id, amount.0);
        self.credit(&receiver_id, &token_id, amount.0);
    }

    /// Withdraws `nep141:<token>` from the caller's balance. Returns the
    /// amount withdrawn, as the real verifier does.
    #[payable]
    pub fn ft_withdraw(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: Option<String>,
        storage_deposit: Option<U128>,
    ) -> U128 {
        assert_one_yocto();
        self.record(
            "ft_withdraw",
            json!({
                "token": token,
                "receiver_id": receiver_id,
                "amount": amount,
                "memo": memo,
                "msg": msg,
                "storage_deposit": storage_deposit,
            }),
        );
        let sender = env::predecessor_account_id();
        self.debit(&sender, &format!("nep141:{token}"), amount.0);
        amount
    }

    /// Withdraws `nep245:<token>:<id>` balances from the caller.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn mt_withdraw(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        memo: Option<String>,
        msg: Option<String>,
        storage_deposit: Option<U128>,
    ) -> Vec<U128> {
        assert_one_yocto();
        require!(token_ids.len() == amounts.len(), "length mismatch");
        self.record(
            "mt_withdraw",
            json!({
                "token": token,
                "receiver_id": receiver_id,
                "token_ids": token_ids,
                "amounts": amounts,
                "memo": memo,
                "msg": msg,
                "storage_deposit": storage_deposit,
            }),
        );
        let sender = env::predecessor_account_id();
        for (id, amount) in token_ids.iter().zip(&amounts) {
            self.debit(&sender, &format!("nep245:{token}:{id}"), amount.0);
        }
        amounts
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .iter()
            .map(|t| U128(self.balance(&account_id, t)))
            .collect()
    }

    /// Every recorded money call, oldest first.
    pub fn get_calls(&self) -> Vec<CallRecord> {
        self.calls.iter().cloned().collect()
    }

    /// Test-only: credits `amount` of `token_id` to `account_id`. Public on
    /// purpose (the simulated provider calls it); see the module docs.
    pub fn deposit(&mut self, account_id: AccountId, token_id: String, amount: U128) {
        self.credit(&account_id, &token_id, amount.0);
    }
}

impl MockIntents {
    fn balance(&self, account: &AccountId, token: &str) -> u128 {
        self.balances
            .get(&(account.clone(), token.to_owned()))
            .copied()
            .unwrap_or(0)
    }

    fn credit(&mut self, account: &AccountId, token: &str, amount: u128) {
        let balance = self.balance(account, token);
        let new = balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("balance overflow"));
        self.balances
            .insert((account.clone(), token.to_owned()), new);
    }

    fn debit(&mut self, account: &AccountId, token: &str, amount: u128) {
        let balance = self.balance(account, token);
        let new = balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("insufficient balance"));
        self.balances
            .insert((account.clone(), token.to_owned()), new);
    }

    fn record(&mut self, method: &str, args: serde_json::Value) {
        self.calls.push(CallRecord {
            method: method.to_owned(),
            predecessor: env::predecessor_account_id(),
            attached_deposit: U128(env::attached_deposit().as_yoctonear()),
            args: args.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const USDC: &str = "nep141:usdc.tendr.testnet";

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn as_caller(caller: &str, yocto: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acct("intents-mock.tendr.testnet"))
            .predecessor_account_id(acct(caller))
            .attached_deposit(NearToken::from_yoctonear(yocto))
            .build());
    }

    fn funded() -> MockIntents {
        as_caller("anyone.testnet", 0);
        let mut m = MockIntents::default();
        m.deposit(acct("shop.tendr.testnet"), USDC.into(), U128(1_000));
        m
    }

    #[test]
    fn mt_transfer_moves_balance_and_records_the_call() {
        let mut m = funded();
        as_caller("shop.tendr.testnet", 1);
        m.mt_transfer(
            acct("dep.1click.testnet"),
            USDC.into(),
            U128(300),
            None,
            None,
        );
        let balances = m.mt_batch_balance_of(
            acct("shop.tendr.testnet"),
            vec![USDC.into(), "nep141:other.testnet".into()],
        );
        assert_eq!(balances, vec![U128(700), U128(0)]);
        assert_eq!(
            m.mt_balance_of(acct("dep.1click.testnet"), USDC.into()),
            U128(300)
        );
        let calls = m.get_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, "mt_transfer");
        assert_eq!(calls[0].predecessor, acct("shop.tendr.testnet"));
        assert_eq!(calls[0].attached_deposit, U128(1));
        let args: serde_json::Value = serde_json::from_str(&calls[0].args).unwrap();
        assert_eq!(args["receiver_id"], "dep.1click.testnet");
        assert_eq!(args["token_id"], USDC);
        assert_eq!(args["amount"], "300");
    }

    #[test]
    fn ft_withdraw_debits_the_nep141_balance() {
        let mut m = funded();
        as_caller("shop.tendr.testnet", 1);
        let out = m.ft_withdraw(
            acct("usdc.tendr.testnet"),
            acct("usdc.tendr.testnet"),
            U128(250),
            Some("WITHDRAW_TO:0xabc".into()),
            None,
            None,
        );
        assert_eq!(out, U128(250));
        assert_eq!(
            m.mt_balance_of(acct("shop.tendr.testnet"), USDC.into()),
            U128(750)
        );
        let args: serde_json::Value = serde_json::from_str(&m.get_calls()[0].args).unwrap();
        assert_eq!(args["memo"], "WITHDRAW_TO:0xabc");
        assert_eq!(args["token"], "usdc.tendr.testnet");
    }

    #[test]
    fn mt_withdraw_debits_nep245_balances() {
        as_caller("anyone.testnet", 0);
        let mut m = MockIntents::default();
        m.deposit(
            acct("shop.tendr.testnet"),
            "nep245:mt.testnet:7".into(),
            U128(5),
        );
        as_caller("shop.tendr.testnet", 1);
        let out = m.mt_withdraw(
            acct("mt.testnet"),
            acct("bob.testnet"),
            vec!["7".into()],
            vec![U128(5)],
            None,
            None,
            None,
        );
        assert_eq!(out, vec![U128(5)]);
        assert_eq!(
            m.mt_balance_of(acct("shop.tendr.testnet"), "nep245:mt.testnet:7".into()),
            U128(0)
        );
        assert_eq!(m.get_calls()[0].method, "mt_withdraw");
    }

    fn panics(f: impl FnOnce()) -> String {
        let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
        err.downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    #[test]
    fn requires_one_yocto_and_sufficient_balance() {
        let mut m = funded();
        as_caller("shop.tendr.testnet", 0);
        let msg = panics(|| {
            m.mt_transfer(acct("bob.testnet"), USDC.into(), U128(1), None, None);
        });
        assert!(msg.contains("exactly 1 yoctoNEAR"), "{msg}");
        as_caller("shop.tendr.testnet", 1);
        let msg = panics(|| {
            m.mt_transfer(acct("bob.testnet"), USDC.into(), U128(1_001), None, None);
        });
        assert!(msg.contains("insufficient balance"), "{msg}");
        // Someone else cannot spend the shop's balance.
        as_caller("bob.testnet", 1);
        let msg = panics(|| {
            m.ft_withdraw(
                acct("usdc.tendr.testnet"),
                acct("usdc.tendr.testnet"),
                U128(1),
                None,
                None,
                None,
            );
        });
        assert!(msg.contains("insufficient balance"), "{msg}");
    }
}
