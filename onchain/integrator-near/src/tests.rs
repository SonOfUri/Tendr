use super::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{
    serde_json, test_vm_config, testing_env, AccountId, Gas, PromiseResult, RuntimeFeesConfig,
};

const CONTRACT: &str = "game.near";
const RELAYER: &str = "relayer.near";
const TOKEN: &str = "usdt.tether-token.near";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn call_as(predecessor: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .prepaid_gas(Gas::from_tgas(50))
        .build());
}

/// Runs `on_balance` as the token answered: the contract's own callback, `balance` as promise 0
/// (None: the `ft_balance_of` call failed).
fn callback(balance: Option<u128>) {
    let result = match balance {
        Some(b) => PromiseResult::Successful(serde_json::to_vec(&U128(b)).unwrap()),
        None => PromiseResult::Failed,
    };
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc(CONTRACT))
            .predecessor_account_id(acc(CONTRACT))
            .prepaid_gas(Gas::from_tgas(15))
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn contract() -> TendrDepositReceiver {
    call_as("owner.near");
    TendrDepositReceiver::new(acc(RELAYER))
}

/// The whole hook as the chain runs it: the relayer's call, then the token's answer.
fn hook(c: &mut TendrDepositReceiver, amount: u128, tx: &str, balance: Option<u128>) -> U128 {
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{\"player\":\"A\"}".into(),
        acc(TOKEN),
        U128(amount),
        tx.into(),
    );
    callback(balance);
    c.on_balance(
        Ok(U128(balance.unwrap_or(0))),
        Deposit {
            payment_id: "pay_1".into(),
            session_id: "ses_1".into(),
            hook_data: "{\"player\":\"A\"}".into(),
            token: acc(TOKEN),
            amount: U128(amount),
            tx_hash: tx.into(),
        },
    )
}

#[test]
#[should_panic(expected = "only the Tendr relayer")]
fn only_the_relayer_may_call() {
    let mut c = contract();
    call_as("attacker.near");
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{}".into(),
        acc(TOKEN),
        U128(100),
        "tx1".into(),
    );
}

#[test]
fn credits_the_settled_amount_and_logs_the_event() {
    let mut c = contract();
    assert_eq!(hook(&mut c, 100, "tx1", Some(100)), U128(100));
    assert_eq!(c.accounted(acc(TOKEN)), U128(100));
    assert!(c.notified("tx1".into()));
    let logs = get_logs();
    let event = logs
        .iter()
        .find(|l| l.starts_with("EVENT_JSON:"))
        .expect("event");
    assert!(event.contains("\"event\":\"tendr_deposit\""));
    assert!(event.contains("\"credited\":\"100\""));
    assert!(event.contains("\"payment_id\":\"pay_1\""));
}

#[test]
fn a_forged_amount_above_the_unaccounted_balance_credits_only_the_real_balance() {
    let mut c = contract();
    assert_eq!(hook(&mut c, 100, "tx1", Some(60)), U128(60));
    assert_eq!(c.accounted(acc(TOKEN)), U128(60));
    // Nothing new arrived: a further hook credits nothing.
    assert_eq!(hook(&mut c, 50, "tx2", Some(60)), U128(0));
    // A later deposit is credited normally.
    assert_eq!(hook(&mut c, 25, "tx3", Some(85)), U128(25));
    assert_eq!(c.accounted(acc(TOKEN)), U128(85));
}

#[test]
fn a_balance_below_accounted_credits_nothing() {
    let mut c = contract();
    hook(&mut c, 100, "tx1", Some(100));
    assert_eq!(hook(&mut c, 10, "tx2", Some(70)), U128(0));
    assert_eq!(c.accounted(acc(TOKEN)), U128(100));
}

#[test]
#[should_panic(expected = "already notified")]
fn a_duplicate_tx_hash_is_refused_at_the_call() {
    let mut c = contract();
    hook(&mut c, 100, "tx1", Some(200));
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_2".into(),
        "ses_2".into(),
        "{}".into(),
        acc(TOKEN),
        U128(100),
        "tx1".into(),
    );
}

/// Two calls for one transaction in flight together: the second callback refuses it.
#[test]
#[should_panic(expected = "already notified")]
fn a_duplicate_tx_hash_is_refused_in_the_callback() {
    let mut c = contract();
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{}".into(),
        acc(TOKEN),
        U128(100),
        "tx1".into(),
    );
    // The second call (its own transaction) passes the call's check: nothing is credited yet.
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{}".into(),
        acc(TOKEN),
        U128(100),
        "tx1".into(),
    );
    callback(Some(200));
    let args = |c: &mut TendrDepositReceiver| {
        c.on_balance(
            Ok(U128(200)),
            Deposit {
                payment_id: "pay_1".into(),
                session_id: "ses_1".into(),
                hook_data: "{}".into(),
                token: acc(TOKEN),
                amount: U128(100),
                tx_hash: "tx1".into(),
            },
        )
    };
    assert_eq!(args(&mut c), U128(100));
    args(&mut c);
}

/// The token's answer failed: the callback fails (the relayer sees a failure and retries) and
/// nothing is recorded, so the retry is not refused as a duplicate.
#[test]
fn a_failed_balance_lookup_records_nothing() {
    let mut c = contract();
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{}".into(),
        acc(TOKEN),
        U128(100),
        "tx1".into(),
    );
    callback(None);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.on_balance(
            Err(near_sdk::PromiseError::Failed),
            Deposit {
                payment_id: "pay_1".into(),
                session_id: "ses_1".into(),
                hook_data: "{}".into(),
                token: acc(TOKEN),
                amount: U128(100),
                tx_hash: "tx1".into(),
            },
        )
    }));
    assert!(r.is_err());
    assert!(!c.notified("tx1".into()));
    assert_eq!(c.accounted(acc(TOKEN)), U128(0));
}

#[test]
#[should_panic(expected = "tx_hash")]
fn an_empty_tx_hash_is_refused() {
    let mut c = contract();
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{}".into(),
        acc(TOKEN),
        U128(1),
        String::new(),
    );
}

/// Misattribution limit (documented): with two deposits pending, a forged call can credit A
/// with B's deposit, never more than arrived.
#[test]
fn misattribution_is_bounded_by_the_balance() {
    let mut c = contract();
    assert_eq!(hook(&mut c, 200, "forged", Some(200)), U128(200));
    assert_eq!(hook(&mut c, 100, "txB", Some(200)), U128(0));
}

/// Gas: the call schedules `ft_balance_of` (FT_BALANCE_OF_GAS) and `on_balance`
/// (ON_BALANCE_GAS); both must fit inside what relayer-near attaches (50 Tgas,
/// apps/api/src/near/tx.ts NEAR_HOOK_ATTACHED_GAS) with room for the call itself.
#[test]
fn the_hook_fits_the_attached_gas() {
    let mut c = contract();
    call_as(RELAYER);
    let _ = c.on_tendr_deposit(
        "pay_1".into(),
        "ses_1".into(),
        "{\"player\":\"A\"}".into(),
        acc(TOKEN),
        U128(100),
        "tx1".into(),
    );
    let call = near_sdk::env::used_gas();
    callback(Some(100));
    c.on_balance(
        Ok(U128(100)),
        Deposit {
            payment_id: "pay_1".into(),
            session_id: "ses_1".into(),
            hook_data: "{\"player\":\"A\"}".into(),
            token: acc(TOKEN),
            amount: U128(100),
            tx_hash: "tx1".into(),
        },
    );
    let cb = near_sdk::env::used_gas();
    println!(
        "on_tendr_deposit used {} Ggas (host functions + gas given to its two receipts), \
         on_balance {} Ggas (host functions)",
        call.as_gas() / 1_000_000_000,
        cb.as_gas() / 1_000_000_000
    );
    let budget = FT_BALANCE_OF_GAS.as_gas() + ON_BALANCE_GAS.as_gas();
    assert!(budget + Gas::from_tgas(10).as_gas() <= Gas::from_tgas(50).as_gas());
    assert!(call.as_gas() < Gas::from_tgas(50).as_gas());
    assert!(cb.as_gas() < ON_BALANCE_GAS.as_gas());
}
