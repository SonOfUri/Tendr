//! Withdrawals, refunds, limits, the refund cap, timelocks and auto-sweep.

use near_sdk::mock::MockAction;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{test_vm_config, NearToken, PromiseResult, RuntimeFeesConfig};

use super::*;
use crate::money::TIMELOCK_DELAY;

/// A PoA token bridged to Base (the chain of `add_saved`'s address).
const USDC: &str = "nep141:base-usdc.poa.tendr.testnet";
const USDC_TOKEN: &str = "base-usdc.poa.tendr.testnet";
const INTENTS: &str = "intents-mock.tendr.testnet";
const DEPOSIT: &str = "dep1.1click.testnet";
const REFUND_TO: &str = "0x00000000000000000000000000000000000000aa";
/// When `funded` leaves the clock: sav_1 has just become usable.
const T1: u64 = T0 + DAY;

fn swap() -> WithdrawRoute {
    WithdrawRoute::Swap {
        deposit_account: DEPOSIT.parse().unwrap(),
    }
}

fn withdraw(amount: u128, route: WithdrawRoute) -> Action {
    Action::Withdraw {
        asset: USDC.into(),
        amount: U128(amount),
        saved_address_id: "sav_1".into(),
        route,
    }
}

fn refund(amount: u128) -> Action {
    Action::Refund {
        asset: USDC.into(),
        amount: U128(amount),
        destination_chain: "base".into(),
        destination: REFUND_TO.into(),
        payment_id: "pay_1".into(),
        route: poa(),
    }
}

fn limits(per_tx: Option<u128>, per_day: Option<u128>) -> Action {
    Action::SetLimits {
        asset: USDC.into(),
        per_tx: per_tx.map(U128),
        per_day: per_day.map(U128),
    }
}

fn refund_cap(daily: u128) -> Action {
    Action::SetRefundCap {
        asset: USDC.into(),
        daily: U128(daily),
    }
}

fn auto_sweep(trigger_above: u128, keep: u128) -> Action {
    Action::SetAutoSweep {
        asset: USDC.into(),
        trigger_above: U128(trigger_above),
        keep: U128(keep),
        saved_address_id: "sav_1".into(),
    }
}

/// A 2-of-3 account (1-of-3 when `threshold` is 1) whose saved address
/// `sav_1` is usable; the clock is left at [`T1`].
fn funded(threshold: u8) -> (MerchantAccount, Person, Person, Person) {
    let (mut c, a, b, cc) = three_of(threshold);
    pass(&mut c, &a, &b, add_saved("sav_1"), 200);
    ctx(T1);
    (c, a, b, cc)
}

/// Proposes with `a`; for a 2-of-N account `b` adds the second approval.
fn pass(c: &mut MerchantAccount, a: &Person, b: &Person, action: Action, n: u8) -> ProposalId {
    let id = propose(c, a, action, n);
    if c.get_config().threshold == 2 {
        let epoch = c.get_config().signer_epoch.0;
        c.approve(id, b.approve(&id, epoch));
    }
    id
}

/// Runs a callback as the contract itself, with `result` as promise 0.
fn callback_ctx(now: u64, result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(CONTRACT.parse().unwrap())
            .block_timestamp(now)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

/// Finishes an outgoing transfer at `now`. Later calls run in the callback's
/// context (predecessor: the contract) until the next `ctx`.
fn complete(c: &mut MerchantAccount, id: ProposalId, now: u64, ok: bool) {
    let result = if ok {
        PromiseResult::Successful(Vec::new())
    } else {
        PromiseResult::Failed
    };
    callback_ctx(now, result);
    c.on_transfer_done(id);
}

/// One function call in a created receipt.
#[derive(Debug)]
struct Call {
    receiver: String,
    method: String,
    args: serde_json::Value,
    deposit: NearToken,
}

fn calls() -> Vec<Call> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } => Some(Call {
                    receiver: receiver.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap(),
                    deposit: attached_deposit,
                }),
                _ => None,
            })
        })
        .collect()
}

fn event_names(logs: &[String]) -> Vec<String> {
    events(logs)
        .iter()
        .map(|e| e["event"].as_str().unwrap().to_string())
        .collect()
}

fn last_event(name: &str) -> serde_json::Value {
    events(&get_logs())
        .into_iter()
        .rev()
        .find(|e| e["event"] == name)
        .unwrap_or_else(|| panic!("no {name} event"))
}

fn ready_at(c: &MerchantAccount, id: &ProposalId) -> Option<u64> {
    c.get_proposal(*id).unwrap().ready_at.map(|t| t.0)
}

#[test]
fn withdraw_requires_usable_saved_address() {
    let (mut c, a, _b, _c) = three_of(1);
    let msg = panics(|| {
        propose(&mut c, &a, withdraw(10, poa()), 1);
    });
    assert!(
        msg.contains("saved address is unknown or not yet active"),
        "{msg}"
    );

    run(&mut c, &a, add_saved("sav_1"), 2);
    ctx(T0 + DAY - 1);
    let msg = panics(|| {
        propose(&mut c, &a, withdraw(10, poa()), 3);
    });
    assert!(
        msg.contains("saved address is unknown or not yet active"),
        "{msg}"
    );
    assert!(calls().is_empty());

    ctx(T0 + DAY);
    let id = propose(&mut c, &a, withdraw(10, poa()), 4);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    assert_eq!(calls()[0].method, "ft_withdraw");
    complete(&mut c, id, T0 + DAY, true);
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    assert_eq!(event_names(&get_logs()), ["proposal_executed"]);
}

#[test]
fn withdraw_rechecks_saved_address_at_execute() {
    let (mut c, a, b, _c) = funded(2);
    let id = pass(&mut c, &a, &b, withdraw(10, swap()), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    assert_eq!(ready_at(&c, &id), Some(T1 + TIMELOCK_DELAY));

    let rm = Action::RemoveSavedAddress { id: "sav_1".into() };
    pass(&mut c, &a, &b, rm, 2);
    assert!(c.list_saved_addresses().is_empty());

    ctx(T1 + TIMELOCK_DELAY);
    c.execute(id);
    assert_eq!(status(&c, &id), ProposalStatus::Failed);
    let ev = last_event("proposal_failed");
    assert_eq!(
        ev["data"]["reason"],
        "saved address is unknown or not yet active"
    );
    assert!(calls().is_empty());
}

#[test]
fn per_tx_and_per_day_limits_enforced() {
    let (mut c, a, _b, _c) = funded(1);
    run(&mut c, &a, limits(Some(100), Some(150)), 1);

    let msg = panics(|| {
        propose(&mut c, &a, withdraw(101, poa()), 2);
    });
    assert!(msg.contains("per-withdrawal limit"), "{msg}");

    let w1 = propose(&mut c, &a, withdraw(100, poa()), 3);
    complete(&mut c, w1, T1, true);
    assert_eq!(c.get_limits(USDC.into()).spent_24h, U128(100));

    let msg = panics(|| {
        propose(&mut c, &a, withdraw(51, poa()), 4);
    });
    assert!(msg.contains("daily withdrawal limit"), "{msg}");

    // A withdrawal in flight reserves its amount, so a concurrent one cannot
    // slip past the daily limit before the first one's callback lands.
    let t = T1 + HOUR;
    ctx(t);
    let w2 = propose(&mut c, &a, withdraw(50, poa()), 5);
    assert_eq!(status(&c, &w2), ProposalStatus::Executing);
    assert_eq!(c.get_limits(USDC.into()).spent_24h, U128(150));
    let msg = panics(|| {
        propose(&mut c, &a, withdraw(1, poa()), 6);
    });
    assert!(msg.contains("daily withdrawal limit"), "{msg}");
    complete(&mut c, w2, t, true);
    assert_eq!(c.get_limits(USDC.into()).spent_24h, U128(150));

    // Rolling, not calendar: the first 100 leaves the window 24h after it was
    // charged, the later 50 an hour after that.
    ctx(T1 + DAY - 1);
    let msg = panics(|| {
        propose(&mut c, &a, withdraw(1, poa()), 7);
    });
    assert!(msg.contains("daily withdrawal limit"), "{msg}");
    ctx(T1 + DAY);
    assert_eq!(c.get_limits(USDC.into()).spent_24h, U128(50));
    let w3 = propose(&mut c, &a, withdraw(100, poa()), 8);
    assert_eq!(status(&c, &w3), ProposalStatus::Executing);
}

#[test]
fn failed_transfer_marks_failed_and_is_not_charged() {
    let (mut c, a, _b, _c) = funded(1);
    run(&mut c, &a, limits(None, Some(100)), 1);
    let id = propose(&mut c, &a, withdraw(100, poa()), 2);
    complete(&mut c, id, T1, false);
    assert_eq!(status(&c, &id), ProposalStatus::Failed);
    assert_eq!(event_names(&get_logs()), ["proposal_failed"]);
    assert_eq!(c.get_limits(USDC.into()).spent_24h, U128(0));
    // The released reservation can be used again.
    let again = propose(&mut c, &a, withdraw(100, poa()), 3);
    assert_eq!(status(&c, &again), ProposalStatus::Executing);
    // A verifier reporting 0 withdrawn (refunded) counts as a failure too.
    callback_ctx(T1, PromiseResult::Successful(b"\"0\"".to_vec()));
    c.on_transfer_done(again);
    assert_eq!(status(&c, &again), ProposalStatus::Failed);
}

#[test]
fn transfer_in_flight_cannot_be_cancelled_or_rerun() {
    let (mut c, a, b, _c) = funded(1);
    let id = propose(&mut c, &a, withdraw(10, poa()), 1);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not pending"), "{msg}");
    let msg = panics(|| c.cancel(id, b.cancel(&id, 0)));
    assert!(msg.contains("not pending"), "{msg}");
    // (`#[private]` on the callback is enforced by the generated Wasm export,
    // which unit tests bypass; the sandbox tests cover it.)
    complete(&mut c, id, T1, true);
    let msg = panics(|| {
        callback_ctx(T1, PromiseResult::Successful(Vec::new()));
        c.on_transfer_done(id);
    });
    assert!(msg.contains("not executing"), "{msg}");
}

#[test]
fn lowering_limit_immediate_raising_waits_24h() {
    let (mut c, a, b, _c) = funded(2);
    // From "no limit" to a limit is a lowering.
    let lower = pass(&mut c, &a, &b, limits(Some(100), Some(1000)), 1);
    assert_eq!(status(&c, &lower), ProposalStatus::Executed);
    assert_eq!(c.get_limits(USDC.into()).per_tx, Some(U128(100)));

    let raise = pass(&mut c, &a, &b, limits(Some(200), Some(1000)), 2);
    assert_eq!(status(&c, &raise), ProposalStatus::Pending);
    assert_eq!(ready_at(&c, &raise), Some(T1 + TIMELOCK_DELAY));
    let ev = last_event("timelock_started");
    assert_eq!(ev["data"]["ready_at"], (T1 + TIMELOCK_DELAY).to_string());
    let view = c.get_limits(USDC.into());
    assert_eq!(view.per_tx, Some(U128(100)));
    let pending = view.pending_raise.unwrap();
    assert_eq!(pending.per_tx, Some(U128(200)));
    assert_eq!(pending.per_day, Some(U128(1000)));
    assert_eq!(pending.ready_at, U64(T1 + TIMELOCK_DELAY));
    assert_eq!(pending.proposal_id, raise);

    // Removing a limit is a raise too.
    let unlimited = pass(&mut c, &a, &b, limits(Some(100), None), 3);
    assert_eq!(status(&c, &unlimited), ProposalStatus::Pending);
    // Lowering stays immediate while raises wait.
    let lower2 = pass(&mut c, &a, &b, limits(Some(50), Some(1000)), 4);
    assert_eq!(status(&c, &lower2), ProposalStatus::Executed);
    assert_eq!(c.get_limits(USDC.into()).per_tx, Some(U128(50)));

    ctx(T1 + TIMELOCK_DELAY - 1);
    let msg = panics(|| c.execute(raise));
    assert!(msg.contains("timelocked"), "{msg}");
    ctx(T1 + TIMELOCK_DELAY);
    c.execute(raise);
    assert_eq!(status(&c, &raise), ProposalStatus::Executed);
    let view = c.get_limits(USDC.into());
    assert_eq!(view.per_tx, Some(U128(200)));
    // The other raise is still waiting.
    assert_eq!(view.pending_raise.unwrap().proposal_id, unlimited);
}

#[test]
fn refund_cap_raise_waits_24h() {
    let (mut c, a, b, _c) = three_of(2);
    // The default cap is 0, so setting the first cap is a raise.
    assert_eq!(c.get_limits(USDC.into()).refund_cap, U128(0));
    let id = pass(&mut c, &a, &b, refund_cap(100), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    assert_eq!(
        c.get_limits(USDC.into()).pending_raise.unwrap().refund_cap,
        U128(100)
    );
    ctx(T0 + TIMELOCK_DELAY);
    c.execute(id);
    assert_eq!(c.get_limits(USDC.into()).refund_cap, U128(100));
    // Lowering is immediate.
    let id = pass(&mut c, &a, &b, refund_cap(40), 2);
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    assert_eq!(c.get_limits(USDC.into()).refund_cap, U128(40));
}

#[test]
fn limit_lowered_while_timelocked_withdrawal_pending_fails_at_execute() {
    let (mut c, a, b, _c) = funded(2);
    let id = pass(&mut c, &a, &b, withdraw(100, swap()), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    pass(&mut c, &a, &b, limits(Some(50), None), 2);

    ctx(T1 + TIMELOCK_DELAY);
    c.execute(id);
    assert_eq!(status(&c, &id), ProposalStatus::Failed);
    let ev = last_event("proposal_failed");
    assert_eq!(
        ev["data"]["reason"],
        "amount exceeds the per-withdrawal limit"
    );
    assert!(calls().is_empty());
}

#[test]
fn swap_withdrawal_timelocked_24h_and_cancellable() {
    let (mut c, a, b, cc) = funded(2);
    let id = pass(&mut c, &a, &b, withdraw(10, swap()), 1);
    let names = event_names(&get_logs());
    assert_eq!(names.last().unwrap(), "timelock_started");
    assert!(calls().is_empty());
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("timelocked"), "{msg}");

    // Any single signer may cancel during the wait.
    c.cancel(id, cc.cancel(&id, 0));
    assert_eq!(status(&c, &id), ProposalStatus::Cancelled);
    ctx(T1 + TIMELOCK_DELAY);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not pending"), "{msg}");

    // An uncancelled one executes once the wait is over.
    ctx(T1);
    let id = pass(&mut c, &a, &b, withdraw(10, swap()), 2);
    ctx(T1 + TIMELOCK_DELAY);
    c.execute(id);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    let calls = calls();
    assert_eq!(calls[0].method, "mt_transfer");
    complete(&mut c, id, T1 + TIMELOCK_DELAY, true);
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
}

#[test]
fn timelocked_proposals_count_toward_pending_cap() {
    let (mut c, a, b, _c) = funded(2);
    for n in 0..MAX_PENDING_PER_SIGNER {
        pass(&mut c, &a, &b, withdraw(1, swap()), n);
    }
    let msg = panics(|| {
        propose(&mut c, &a, withdraw(1, swap()), 100);
    });
    assert!(msg.contains("too many pending proposals"), "{msg}");
}

#[test]
fn timelock_restarts_when_signer_epoch_changes() {
    let (mut c, a, b, cc) = funded(2);
    let id = pass(&mut c, &a, &b, withdraw(10, swap()), 1);
    assert_eq!(ready_at(&c, &id), Some(T1 + TIMELOCK_DELAY));

    // A signer change voids the approvals that started the timelock.
    let t = T1 + HOUR;
    ctx(t);
    pass(
        &mut c,
        &a,
        &b,
        Action::RemoveSigner { id: cc.id.clone() },
        2,
    );
    assert_eq!(c.get_config().signer_epoch, U64(1));

    // Past the old ready_at, the stale approvals cannot execute it.
    ctx(T1 + TIMELOCK_DELAY);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not enough approvals"), "{msg}");

    // Reaching the threshold again at the new epoch restarts the wait.
    let t2 = T1 + TIMELOCK_DELAY + HOUR;
    ctx(t2);
    c.approve(id, b.approve(&id, 1));
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    c.approve(id, a.approve(&id, 1));
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    assert_eq!(ready_at(&c, &id), Some(t2 + TIMELOCK_DELAY));
    let ev = last_event("timelock_started");
    assert_eq!(ev["data"]["ready_at"], (t2 + TIMELOCK_DELAY).to_string());

    ctx(t2 + TIMELOCK_DELAY - 1);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("timelocked"), "{msg}");
    ctx(t2 + TIMELOCK_DELAY);
    c.execute(id);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
}

#[test]
fn timelocked_execute_requires_current_epoch_approvals() {
    let (mut c, a, b, cc) = funded(2);
    let id = pass(&mut c, &a, &b, withdraw(10, swap()), 1);
    // Threshold 2 -> 3 bumps the epoch; one re-approval is not enough.
    pass(&mut c, &a, &b, Action::SetThreshold(3), 2);
    ctx(T1 + TIMELOCK_DELAY);
    c.approve(id, a.approve(&id, 1));
    c.approve(id, cc.approve(&id, 1));
    assert_eq!(valid(&c, &id), 2);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not enough approvals"), "{msg}");
    // The stale ready_at is not shown as a live timelock.
    assert_eq!(ready_at(&c, &id), None);
}

#[test]
fn refund_under_cap_executes_immediately() {
    let (mut c, a, _b, _c) = three_of(1);
    let cap = propose(&mut c, &a, refund_cap(100), 1);
    ctx(T0 + TIMELOCK_DELAY);
    c.execute(cap);
    // No saved address is needed: the destination is the payment's sender.
    assert!(c.list_saved_addresses().is_empty());
    let id = propose(&mut c, &a, refund(60), 2);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    let calls = calls();
    assert_eq!(calls[0].method, "ft_withdraw");
    assert_eq!(calls[0].args["memo"], format!("WITHDRAW_TO:{REFUND_TO}"));
    complete(&mut c, id, T0 + TIMELOCK_DELAY, true);
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    assert_eq!(c.get_limits(USDC.into()).refunded_24h, U128(60));
}

#[test]
fn refund_with_default_cap_is_timelocked() {
    let (mut c, a, _b, _c) = three_of(1);
    let id = propose(&mut c, &a, refund(1), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    assert_eq!(ready_at(&c, &id), Some(T0 + TIMELOCK_DELAY));
}

/// A 1-of-3 account with a refund cap of 100 in force; clock at the returned time.
fn with_refund_cap() -> (MerchantAccount, Person, u64) {
    let (mut c, a, _b, _c) = three_of(1);
    let cap = propose(&mut c, &a, refund_cap(100), 200);
    let t = T0 + TIMELOCK_DELAY;
    ctx(t);
    c.execute(cap);
    (c, a, t)
}

#[test]
fn refunds_summing_over_cap_timelock_the_crossing_one() {
    let (mut c, a, t) = with_refund_cap();
    let r1 = propose(&mut c, &a, refund(60), 1);
    assert_eq!(status(&c, &r1), ProposalStatus::Executing);
    // While r1 is in flight its amount already counts.
    let r2 = propose(&mut c, &a, refund(50), 2);
    assert_eq!(status(&c, &r2), ProposalStatus::Pending);
    assert_eq!(event_names(&get_logs()).last().unwrap(), "timelock_started");
    complete(&mut c, r1, t, true);

    let r3 = propose(&mut c, &a, refund(40), 3);
    assert_eq!(status(&c, &r3), ProposalStatus::Executing);
    complete(&mut c, r3, t, true);
    assert_eq!(c.get_limits(USDC.into()).refunded_24h, U128(100));

    // The crossing refund runs after its wait and is charged as well.
    ctx(t + TIMELOCK_DELAY);
    c.execute(r2);
    assert_eq!(status(&c, &r2), ProposalStatus::Executing);
    complete(&mut c, r2, t + TIMELOCK_DELAY, true);
    assert_eq!(status(&c, &r2), ProposalStatus::Executed);
    assert_eq!(c.get_limits(USDC.into()).refunded_24h, U128(50));
}

#[test]
fn refund_cap_window_is_rolling_24h() {
    let (mut c, a, t) = with_refund_cap();
    let r1 = propose(&mut c, &a, refund(60), 1);
    complete(&mut c, r1, t, true);

    ctx(t + DAY - 1);
    let r2 = propose(&mut c, &a, refund(50), 2);
    assert_eq!(status(&c, &r2), ProposalStatus::Pending);
    assert_eq!(c.get_limits(USDC.into()).refunded_24h, U128(60));

    ctx(t + DAY);
    assert_eq!(c.get_limits(USDC.into()).refunded_24h, U128(0));
    let r3 = propose(&mut c, &a, refund(50), 3);
    assert_eq!(status(&c, &r3), ProposalStatus::Executing);
}

#[test]
fn refund_validates_route_and_chain() {
    let (mut c, a, _b, _c) = three_of(1);
    let mut bad_chain = refund(1);
    if let Action::Refund {
        destination_chain, ..
    } = &mut bad_chain
    {
        *destination_chain = "Doge".into();
    }
    let msg = panics(|| {
        propose(&mut c, &a, bad_chain, 1);
    });
    assert!(msg.contains("unsupported chain"), "{msg}");

    let mut not_nep141 = refund(1);
    if let Action::Refund { asset, .. } = &mut not_nep141 {
        *asset = "nep245:mt.tendr.testnet:1".into();
    }
    let msg = panics(|| {
        propose(&mut c, &a, not_nep141, 2);
    });
    assert!(msg.contains("poa route needs a nep141 asset"), "{msg}");

    let msg = panics(|| {
        propose(&mut c, &a, refund(0), 3);
    });
    assert!(msg.contains("amount must be positive"), "{msg}");
}

#[test]
fn poa_route_must_use_the_asset_token_contract() {
    let (mut c, a, _b, _c) = funded(1);
    // `ft_withdraw` pays `receiver_id`; any account but the PoA token itself
    // would receive the funds on NEAR instead of the saved address.
    let elsewhere = WithdrawRoute::Poa {
        token_contract: "attacker.testnet".parse().unwrap(),
    };
    let msg = panics(|| {
        propose(&mut c, &a, withdraw(10, elsewhere.clone()), 1);
    });
    assert!(msg.contains("asset's token contract"), "{msg}");
    let mut r = refund(10);
    if let Action::Refund { route, .. } = &mut r {
        *route = elsewhere;
    }
    let msg = panics(|| {
        propose(&mut c, &a, r, 2);
    });
    assert!(msg.contains("asset's token contract"), "{msg}");
}

#[test]
fn clear_auto_sweep_releases_a_stuck_sweep() {
    let (mut c, a, _b, _c) = funded(1);
    run(&mut c, &a, auto_sweep(1000, 100), 1);
    as_anyone(T1);
    c.trigger_sweep(USDC.into());
    // Its callback never lands; signers clear and re-set the rule.
    ctx(T1);
    run(&mut c, &a, Action::ClearAutoSweep { asset: USDC.into() }, 2);
    run(&mut c, &a, auto_sweep(1000, 100), 3);
    assert!(!c.get_auto_sweep(USDC.into()).unwrap().in_flight);
    as_anyone(T1);
    c.trigger_sweep(USDC.into());
}

#[test]
fn outgoing_call_attaches_one_yocto_and_uses_route_args() {
    let (mut c, a, b, _c) = funded(2);
    let id = pass(&mut c, &a, &b, withdraw(7, poa()), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    let poa_calls = calls();
    assert_eq!(poa_calls.len(), 2, "{poa_calls:?}");
    let call = &poa_calls[0];
    assert_eq!(call.receiver, INTENTS);
    assert_eq!(call.method, "ft_withdraw");
    assert_eq!(call.deposit, NearToken::from_yoctonear(1));
    assert_eq!(
        call.args,
        serde_json::json!({
            "token": USDC_TOKEN,
            "receiver_id": USDC_TOKEN,
            "amount": "7",
            "memo": format!("WITHDRAW_TO:{ADDR}"),
        })
    );
    let callback = &poa_calls[1];
    assert_eq!(callback.receiver, CONTRACT);
    assert_eq!(callback.method, "on_transfer_done");
    assert_eq!(callback.deposit, NearToken::from_yoctonear(0));
    assert_eq!(callback.args["proposal_id"], hex(&id.0));

    let id = pass(&mut c, &a, &b, withdraw(9, swap()), 2);
    ctx(T1 + TIMELOCK_DELAY);
    c.execute(id);
    let swap_calls = calls();
    let call = &swap_calls[0];
    assert_eq!(call.receiver, INTENTS);
    assert_eq!(call.method, "mt_transfer");
    assert_eq!(call.deposit, NearToken::from_yoctonear(1));
    assert_eq!(
        call.args,
        serde_json::json!({
            "receiver_id": DEPOSIT,
            "token_id": USDC,
            "amount": "9",
        })
    );
}

/// Delivers an `mt_batch_balance_of` result to the sweep callback.
fn sweep_balance(c: &mut MerchantAccount, now: u64, balance: Option<u128>) {
    let result = match balance {
        Some(b) => PromiseResult::Successful(serde_json::to_vec(&vec![U128(b)]).unwrap()),
        None => PromiseResult::Failed,
    };
    callback_ctx(now, result);
    c.on_sweep_balance(USDC.into());
}

fn as_anyone(now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("anyone.testnet".parse().unwrap())
        .block_timestamp(now)
        .build());
}

#[test]
fn sweep_only_to_saved_address_and_only_above_trigger() {
    let (mut c, a, _b, _c) = three_of(1);
    let msg = panics(|| {
        propose(&mut c, &a, auto_sweep(1000, 100), 1);
    });
    assert!(msg.contains("unknown saved address"), "{msg}");
    run(&mut c, &a, add_saved("sav_1"), 2);
    let msg = panics(|| {
        propose(&mut c, &a, auto_sweep(100, 101), 3);
    });
    assert!(msg.contains("keep must not exceed trigger_above"), "{msg}");
    run(&mut c, &a, auto_sweep(1000, 100), 4);
    let view = c.get_auto_sweep(USDC.into()).unwrap();
    assert_eq!(view.trigger_above, U128(1000));
    assert_eq!(view.keep, U128(100));
    assert_eq!(view.saved_address_id, "sav_1");

    // The destination is still inside its 24h delay.
    as_anyone(T0 + DAY - 1);
    let msg = panics(|| c.trigger_sweep(USDC.into()));
    assert!(
        msg.contains("sweep destination is unknown or not yet active"),
        "{msg}"
    );

    // Anyone may trigger; the contract reads its own balance first.
    as_anyone(T1);
    c.trigger_sweep(USDC.into());
    let read = calls();
    assert_eq!(read[0].receiver, INTENTS);
    assert_eq!(read[0].method, "mt_batch_balance_of");
    assert_eq!(
        read[0].args,
        serde_json::json!({ "account_id": CONTRACT, "token_ids": [USDC] })
    );
    assert_eq!(read[1].method, "on_sweep_balance");
    let msg = panics(|| c.trigger_sweep(USDC.into()));
    assert!(msg.contains("sweep already in flight"), "{msg}");

    // At the trigger: nothing is sent, and the in-flight flag clears.
    sweep_balance(&mut c, T1, Some(1000));
    assert!(calls().is_empty());
    assert!(!c.get_auto_sweep(USDC.into()).unwrap().in_flight);

    // A failed balance read sends nothing either.
    as_anyone(T1);
    c.trigger_sweep(USDC.into());
    sweep_balance(&mut c, T1, None);
    assert!(calls().is_empty());

    // Above the trigger: everything above `keep` goes to the saved address.
    as_anyone(T1);
    c.trigger_sweep(USDC.into());
    sweep_balance(&mut c, T1, Some(1500));
    let send = calls();
    assert_eq!(send[0].receiver, INTENTS);
    assert_eq!(send[0].method, "ft_withdraw");
    assert_eq!(send[0].deposit, NearToken::from_yoctonear(1));
    assert_eq!(
        send[0].args,
        serde_json::json!({
            "token": USDC_TOKEN,
            "receiver_id": USDC_TOKEN,
            "amount": "1400",
            "memo": format!("WITHDRAW_TO:{ADDR}"),
        })
    );
    assert_eq!(send[1].method, "on_sweep_done");
    assert!(c.get_auto_sweep(USDC.into()).unwrap().in_flight);
    callback_ctx(T1, PromiseResult::Successful(b"\"1400\"".to_vec()));
    c.on_sweep_done(USDC.into(), U128(1400), "sav_1".into());
    let ev = last_event("sweep_executed");
    assert_eq!(ev["data"]["amount"], "1400");
    assert_eq!(ev["data"]["saved_address_id"], "sav_1");
    assert!(!c.get_auto_sweep(USDC.into()).unwrap().in_flight);

    // Clearing the rule stops sweeps.
    ctx(T1);
    run(&mut c, &a, Action::ClearAutoSweep { asset: USDC.into() }, 5);
    assert!(c.get_auto_sweep(USDC.into()).is_none());
    as_anyone(T1);
    let msg = panics(|| c.trigger_sweep(USDC.into()));
    assert!(msg.contains("no auto-sweep for this asset"), "{msg}");
}

#[test]
fn removed_saved_address_id_cannot_be_reused() {
    let (mut c, a, b, _c) = funded(2);
    // A swap withdrawal to sav_1 waits in its timelock...
    let w = pass(&mut c, &a, &b, withdraw(10, swap()), 1);
    pass(
        &mut c,
        &a,
        &b,
        Action::RemoveSavedAddress { id: "sav_1".into() },
        2,
    );
    // ...and sav_1 can never name another address.
    let other = Action::AddSavedAddress {
        id: "sav_1".into(),
        chain: "base".into(),
        address: "0x00000000000000000000000000000000000000bb".into(),
    };
    let msg = panics(|| {
        propose(&mut c, &a, other, 3);
    });
    assert!(msg.contains("saved address id was used before"), "{msg}");
    ctx(T1 + TIMELOCK_DELAY);
    c.execute(w);
    assert_eq!(status(&c, &w), ProposalStatus::Failed);
}

/// Adds saved address `id` on `chain` (1-of-N) and returns once it is usable.
fn saved_on(c: &mut MerchantAccount, a: &Person, id: &str, chain: &str, address: &str, n: u8) {
    let add = Action::AddSavedAddress {
        id: id.into(),
        chain: chain.into(),
        address: address.into(),
    };
    run(c, a, add, n);
}

fn withdraw_asset(asset: &str, to: &str, amount: u128) -> Action {
    let token = asset.strip_prefix("nep141:").unwrap();
    Action::Withdraw {
        asset: asset.into(),
        amount: U128(amount),
        saved_address_id: to.into(),
        route: WithdrawRoute::Poa {
            token_contract: token.parse().unwrap(),
        },
    }
}

#[test]
fn poa_withdrawal_needs_a_bridge_token_for_the_destination_chain() {
    let (mut c, a, _b, _c) = three_of(1);
    saved_on(&mut c, &a, "eth_1", "eth", ADDR, 1);
    saved_on(&mut c, &a, "base_1", "base", ADDR, 2);
    ctx(T1);
    // A plain NEP-141 (not a PoA token): ft_withdraw would park the funds in
    // the token contract's own balance.
    let msg = panics(|| {
        propose(
            &mut c,
            &a,
            withdraw_asset("nep141:usdc.tendr.testnet", "eth_1", 5),
            3,
        );
    });
    assert!(msg.contains("asset is not a PoA bridge token"), "{msg}");
    // A PoA token under another suffix is not one of ours either.
    let msg = panics(|| {
        propose(
            &mut c,
            &a,
            withdraw_asset("nep141:eth-usdc.omft.near", "eth_1", 5),
            4,
        );
    });
    assert!(msg.contains("asset is not a PoA bridge token"), "{msg}");
    // An unknown chain prefix.
    let msg = panics(|| {
        let asset = "nep141:doge-usdc.poa.tendr.testnet";
        propose(&mut c, &a, withdraw_asset(asset, "eth_1", 5), 5);
    });
    assert!(msg.contains("asset is not a PoA bridge token"), "{msg}");
    // A Base token cannot go to an Ethereum address.
    let msg = panics(|| {
        propose(&mut c, &a, withdraw_asset(USDC, "eth_1", 5), 6);
    });
    assert!(
        msg.contains("does not serve the destination chain"),
        "{msg}"
    );
    // Prefix without a dash (`eth.<suffix>`) and the arb -> arbitrum mapping.
    let eth = "nep141:eth.poa.tendr.testnet";
    let id = propose(&mut c, &a, withdraw_asset(eth, "eth_1", 5), 7);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    assert_eq!(calls()[0].args["receiver_id"], "eth.poa.tendr.testnet");
    saved_on(&mut c, &a, "arb_1", "arbitrum", ADDR, 8);
    ctx(T1 + DAY);
    let arb = "nep141:arb-0xaf88.poa.tendr.testnet";
    let id = propose(&mut c, &a, withdraw_asset(arb, "arb_1", 5), 9);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
}

#[test]
fn near_chain_withdrawal_transfers_to_the_account_without_memo() {
    let (mut c, a, _b, _c) = three_of(1);
    saved_on(&mut c, &a, "near_1", "near", "merchant.testnet", 1);
    ctx(T1);
    // Any NEP-141 works for a same-chain payout.
    let asset = "nep141:usdc.tendr.testnet";
    let id = propose(&mut c, &a, withdraw_asset(asset, "near_1", 42), 2);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    let call = &calls()[0];
    assert_eq!(call.receiver, INTENTS);
    assert_eq!(call.method, "ft_withdraw");
    assert_eq!(call.deposit, NearToken::from_yoctonear(1));
    assert_eq!(
        call.args,
        serde_json::json!({
            "token": "usdc.tendr.testnet",
            "receiver_id": "merchant.testnet",
            "amount": "42",
        })
    );
}

#[test]
fn near_chain_destination_must_be_an_account_id() {
    let (mut c, a, _b, _c) = three_of(1);
    let bad = Action::AddSavedAddress {
        id: "near_bad".into(),
        chain: "near".into(),
        address: "Not An Account!".into(),
    };
    let msg = panics(|| {
        propose(&mut c, &a, bad, 1);
    });
    assert!(msg.contains("valid NEAR account id"), "{msg}");
    let mut r = refund(1);
    if let Action::Refund {
        destination_chain,
        destination,
        ..
    } = &mut r
    {
        *destination_chain = "near".into();
        *destination = "UPPER.testnet".into();
    }
    let msg = panics(|| {
        propose(&mut c, &a, r, 3);
    });
    assert!(msg.contains("valid NEAR account id"), "{msg}");
}

#[test]
fn refund_poa_token_must_match_destination_chain() {
    let (mut c, a, _b, _c) = three_of(1);
    let mut r = refund(1);
    if let Action::Refund {
        destination_chain, ..
    } = &mut r
    {
        *destination_chain = "sol".into();
    }
    let msg = panics(|| {
        propose(&mut c, &a, r, 1);
    });
    assert!(
        msg.contains("does not serve the destination chain"),
        "{msg}"
    );
}

#[test]
fn sweep_rule_with_mismatched_chain_rejected() {
    let (mut c, a, _b, _c) = three_of(1);
    saved_on(&mut c, &a, "sol_1", "sol", "So1anaAddre55", 1);
    let rule = Action::SetAutoSweep {
        asset: USDC.into(),
        trigger_above: U128(10),
        keep: U128(1),
        saved_address_id: "sol_1".into(),
    };
    let msg = panics(|| {
        propose(&mut c, &a, rule, 2);
    });
    assert!(
        msg.contains("does not serve the destination chain"),
        "{msg}"
    );
    let plain = Action::SetAutoSweep {
        asset: "nep141:usdc.tendr.testnet".into(),
        trigger_above: U128(10),
        keep: U128(1),
        saved_address_id: "sol_1".into(),
    };
    let msg = panics(|| {
        propose(&mut c, &a, plain, 3);
    });
    assert!(msg.contains("asset is not a PoA bridge token"), "{msg}");
}

#[test]
fn duplicate_saved_address_rejected() {
    let (mut c, a, _b, _c) = three_of(1);
    run(&mut c, &a, add_saved("sav_1"), 1);
    let msg = panics(|| {
        propose(&mut c, &a, add_saved("sav_2"), 2);
    });
    assert!(msg.contains("duplicate saved address"), "{msg}");
    // Case-sensitive, no normalization: a differently cased address is distinct.
    let upper = Action::AddSavedAddress {
        id: "sav_3".into(),
        chain: "base".into(),
        address: ADDR.to_uppercase(),
    };
    run(&mut c, &a, upper, 3);
    // The same address on another chain is distinct too.
    let other_chain = Action::AddSavedAddress {
        id: "sav_4".into(),
        chain: "eth".into(),
        address: ADDR.into(),
    };
    run(&mut c, &a, other_chain, 4);
}
