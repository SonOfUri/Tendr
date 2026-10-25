//! 72-hour recovery, upgrades through a proposal, and the testnet admin.

use near_sdk::json_types::Base64VecU8;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{test_vm_config, PromiseResult, RuntimeFeesConfig};

use super::*;
use crate::money::TIMELOCK_DELAY;
use crate::recovery::{recovery_id, RecoveryPayload, MAX_RECOVERY_VALIDITY, RECOVERY_DELAY};

/// The recovery kit's Ed25519 key.
fn kit() -> ed25519_dalek::SigningKey {
    ed25519_key(9)
}

fn kit_pk() -> [u8; 32] {
    kit().verifying_key().to_bytes()
}

/// A `threshold`-of-3 account with the recovery kit set.
fn with_kit(threshold: u8) -> (MerchantAccount, Person, Person, Person) {
    ctx(T0);
    let (a, b, cc) = (person(1, 1), person(2, 1), person(3, 1));
    let mut cfg = config(&[&a, &b, &cc], threshold);
    cfg.recovery_key = Some(kit_pk());
    (MerchantAccount::new(cfg), a, b, cc)
}

/// `valid_until` the helpers sign: inside the 30-day window for every
/// start time these tests use.
const VALID_UNTIL: u64 = T0 + 20 * DAY;

/// A recovery signature by `key` over a full payload.
#[allow(clippy::too_many_arguments)]
fn sign_with(
    key: &ed25519_dalek::SigningKey,
    contract: &str,
    signers: &[Signer],
    threshold: u8,
    nonce: u64,
    key_epoch: u64,
    valid_until: u64,
) -> Base64VecU8 {
    let payload = RecoveryPayload::new(contract, signers, threshold, nonce, key_epoch, valid_until);
    let sig = ed25519_dalek::Signer::sign(key, &payload.hash());
    Base64VecU8(sig.to_bytes().to_vec())
}

/// The kit's signature at recovery-key epoch 0, valid until [`VALID_UNTIL`].
fn kit_sign(contract: &str, signers: &[Signer], threshold: u8, nonce: u64) -> Base64VecU8 {
    sign_with(&kit(), contract, signers, threshold, nonce, 0, VALID_UNTIL)
}

fn key_epoch(c: &MerchantAccount) -> u64 {
    c.get_config().recovery_key_epoch.0
}

/// Starts a recovery signed by the kit for this contract at its current
/// recovery-key epoch.
fn start(c: &mut MerchantAccount, signers: &[Signer], threshold: u8, nonce: u64) {
    let sig = sign_with(
        &kit(),
        CONTRACT,
        signers,
        threshold,
        nonce,
        key_epoch(c),
        VALID_UNTIL,
    );
    c.start_recovery(
        signers.to_vec(),
        threshold,
        U64(nonce),
        U64(VALID_UNTIL),
        sig,
    );
}

/// The recovery id of the recovery started with `nonce` on [`CONTRACT`] at
/// recovery-key epoch 0.
fn rid(nonce: u64) -> ProposalId {
    ProposalId(recovery_id(CONTRACT, 0, nonce))
}

/// A signer's cancel of the recovery started with `nonce`.
fn recovery_cancel(p: &Person, epoch: u64, nonce: u64) -> SignedApproval {
    p.approval_for(CONTRACT, 0, &rid(nonce), epoch, ApprovalIntent::Cancel)
}

fn event_names() -> Vec<String> {
    events(&get_logs())
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

/// Adds saved address `sav_1` with `a` and `b` (enough for a 2-of-N account).
fn add_sav_1(c: &mut MerchantAccount, a: &Person, b: &Person) {
    let id = propose(c, a, add_saved("sav_1"), 200);
    let epoch = c.get_config().signer_epoch.0;
    c.approve(id, b.approve(&id, epoch));
    assert_eq!(status(c, &id), ProposalStatus::Executed);
}

/// An approval made with the recovery kit's key, in `signer_id`'s name.
fn kit_approval(signer_id: &str, id: &ProposalId, epoch: u64) -> SignedApproval {
    let challenge = ApprovalPayload::new(CONTRACT, id, epoch, ApprovalIntent::Approve).challenge();
    SignedApproval {
        signer_id: signer_id.to_string(),
        key: SignerKey::Ed25519(kit_pk()),
        assertion: sign_ed25519_challenge(&kit(), &challenge),
    }
}

#[test]
fn recovery_key_cannot_propose_or_approve_money() {
    let (mut c, a, b, _c) = with_kit(2);
    add_sav_1(&mut c, &a, &b);
    let id_b = person_id(2);
    let withdraw = Action::Withdraw {
        asset: "nep141:base-usdc.poa.tendr.testnet".into(),
        amount: U128(10),
        saved_address_id: "sav_1".into(),
        route: poa(),
    };

    ctx(T0 + DAY);
    let epoch = c.get_config().signer_epoch.0;
    // Proposing with the kit, in a signer's name or under its own.
    for signer_id in [a.id.as_str(), "recovery", ""] {
        let wid = ProposalId::new(&withdraw, &salt(1).0);
        let msg = panics(|| {
            c.propose(
                withdraw.clone(),
                salt(1),
                kit_approval(signer_id, &wid, epoch),
            );
        });
        assert!(
            msg.contains("key is not registered") || msg.contains("unknown signer"),
            "{signer_id}: {msg}"
        );
    }

    // Approving a signer's withdrawal with the kit.
    let wid = propose(&mut c, &a, withdraw.clone(), 2);
    let msg = panics(|| c.approve(wid, kit_approval(&id_b, &wid, epoch)));
    assert!(msg.contains("key is not registered"), "{msg}");
    assert_eq!(valid(&c, &wid), 1);
    assert_eq!(status(&c, &wid), ProposalStatus::Pending);
}

#[test]
fn recovery_executes_only_after_72h() {
    let (mut c, _a, _b, _c) = with_kit(2);
    let d = new_signer(4);
    start(&mut c, &[d.signer()], 1, 1);
    assert_eq!(
        last_event("recovery_started")["data"]["executes_at"],
        (T0 + RECOVERY_DELAY).to_string()
    );
    let r = c.get_recovery().unwrap();
    assert_eq!(r.new_signer_ids, vec![d.id.clone()]);
    assert_eq!(r.new_threshold, 1);
    assert_eq!(r.executes_at, U64(T0 + RECOVERY_DELAY));
    assert_eq!(RECOVERY_DELAY, 72 * HOUR);

    ctx(T0 + RECOVERY_DELAY - 1);
    let msg = panics(|| c.execute_recovery());
    assert!(msg.contains("recovery is not ready"), "{msg}");
    assert_eq!(signer_ids(&c).len(), 3);

    ctx(T0 + RECOVERY_DELAY);
    c.execute_recovery();
    assert_eq!(signer_ids(&c), vec![d.id.clone()]);
    assert_eq!(c.get_config().threshold, 1);
    assert!(c.get_recovery().is_none());
    let msg = panics(|| c.execute_recovery());
    assert!(msg.contains("no recovery"), "{msg}");
}

#[test]
fn any_signer_cancels_recovery() {
    let (mut c, _a, b, _c) = with_kit(3);
    let d = new_signer(4);
    start(&mut c, &[d.signer()], 1, 1);

    // An approve intent, a stranger, or the wrong id cannot cancel.
    let approve = b.approval_for(CONTRACT, 0, &rid(1), 0, ApprovalIntent::Approve);
    let msg = panics(|| c.cancel_recovery(approve));
    assert!(msg.contains("invalid approval"), "{msg}");
    let msg = panics(|| c.cancel_recovery(recovery_cancel(&d, 0, 1)));
    assert!(msg.contains("unknown signer"), "{msg}");
    for wrong in [ProposalId([0; 32]), ProposalId([1; 32])] {
        let wrong_id = b.approval_for(CONTRACT, 0, &wrong, 0, ApprovalIntent::Cancel);
        let msg = panics(|| c.cancel_recovery(wrong_id));
        assert!(msg.contains("invalid approval"), "{msg}");
    }

    // The view names the id the cancel is made over.
    assert_eq!(c.get_recovery().unwrap().recovery_id, rid(1));
    // One signer of a 3-of-3 account is enough.
    c.cancel_recovery(recovery_cancel(&b, 0, 1));
    assert!(c.get_recovery().is_none());
    assert_eq!(last_event("recovery_cancelled")["data"]["signer_id"], b.id);

    ctx(T0 + RECOVERY_DELAY);
    let msg = panics(|| c.execute_recovery());
    assert!(msg.contains("no recovery"), "{msg}");
    assert_eq!(signer_ids(&c).len(), 3);
    let msg = panics(|| c.cancel_recovery(recovery_cancel(&b, 0, 1)));
    assert!(msg.contains("no recovery"), "{msg}");
}

#[test]
fn old_cancel_cannot_cancel_a_later_recovery() {
    let (mut c, a, b, _c) = with_kit(2);
    let d = new_signer(4);
    start(&mut c, &[d.signer()], 1, 1);
    let old = recovery_cancel(&b, 0, 1);
    c.cancel_recovery(old.clone());

    // Recovery 2 at the same epoch: the captured cancel for 1 does not apply.
    start(&mut c, &[d.signer()], 1, 2);
    let msg = panics(|| c.cancel_recovery(old.clone()));
    assert!(msg.contains("invalid approval"), "{msg}");
    assert!(c.get_recovery().is_some());
    // Nor does a cancel made in advance for a later nonce.
    let msg = panics(|| c.cancel_recovery(recovery_cancel(&a, 0, 3)));
    assert!(msg.contains("invalid approval"), "{msg}");

    ctx(T0 + RECOVERY_DELAY);
    c.execute_recovery();
    assert_eq!(signer_ids(&c), vec![d.id.clone()]);
}

#[test]
fn cancel_for_another_contracts_recovery_rejected() {
    let (mut c, _a, b, _c) = with_kit(2);
    let d = new_signer(4);
    start(&mut c, &[d.signer()], 1, 1);
    let other = ProposalId(recovery_id("b.tendr.testnet", 0, 1));
    assert_ne!(other, rid(1));
    // Signed over the other contract's recovery id, for this contract.
    let here = b.approval_for(CONTRACT, 0, &other, 0, ApprovalIntent::Cancel);
    let msg = panics(|| c.cancel_recovery(here));
    assert!(msg.contains("invalid approval"), "{msg}");
    // A cancel made for the other contract entirely.
    let there = b.approval_for("b.tendr.testnet", 0, &other, 0, ApprovalIntent::Cancel);
    let msg = panics(|| c.cancel_recovery(there));
    assert!(msg.contains("invalid approval"), "{msg}");
    assert!(c.get_recovery().is_some());
}

#[test]
fn recovery_replaces_signers_bumps_epoch_and_voids_pending() {
    let (mut c, a, b, cc) = with_kit(2);
    // A withdrawal in flight, a pending proposal and a running timelock.
    add_sav_1(&mut c, &a, &b);
    let epoch = c.get_config().signer_epoch.0;
    ctx(T0 + DAY);
    let withdraw = Action::Withdraw {
        asset: "nep141:base-usdc.poa.tendr.testnet".into(),
        amount: U128(10),
        saved_address_id: "sav_1".into(),
        route: poa(),
    };
    let in_flight = propose(&mut c, &a, withdraw, 1);
    c.approve(in_flight, b.approve(&in_flight, epoch));
    assert_eq!(status(&c, &in_flight), ProposalStatus::Executing);

    let pending = propose(&mut c, &a, Action::SetThreshold(3), 2);
    let upgrade = propose(&mut c, &a, Action::Upgrade { code_hash: [7; 32] }, 3);
    c.approve(upgrade, cc.approve(&upgrade, epoch));
    assert!(c.get_proposal(upgrade).unwrap().ready_at.is_some());
    assert_eq!(c.pending_per_signer.get(&a.id).copied(), Some(2));

    let (d, e) = (new_signer(4), new_signer(5));
    start(&mut c, &[d.signer(), e.signer()], 2, 1);
    ctx(T0 + DAY + RECOVERY_DELAY);
    c.execute_recovery();

    let cfg = c.get_config();
    assert_eq!(signer_ids(&c), vec![d.id.clone(), e.id.clone()]);
    assert_eq!(cfg.threshold, 2);
    assert_eq!(cfg.signer_epoch, U64(epoch + 1));
    assert!(cfg.recovery_key_set, "the recovery key stays");
    let names = event_names();
    assert!(
        names.contains(&"recovery_executed".to_string()),
        "{names:?}"
    );
    assert!(names.contains(&"signers_changed".to_string()), "{names:?}");
    let ev = last_event("recovery_executed");
    assert_eq!(ev["data"]["signer_epoch"], (epoch + 1).to_string());
    assert_eq!(
        last_event("signers_changed")["data"]["proposal_id"],
        serde_json::Value::Null
    );

    // Old approvals and the timelock no longer count; old signers are out.
    assert_eq!(valid(&c, &pending), 0);
    let up = c.get_proposal(upgrade).unwrap();
    assert_eq!((up.valid_approvals, up.ready_at), (0, None));
    let msg = panics(|| c.approve(pending, a.approve(&pending, epoch + 1)));
    assert!(msg.contains("unknown signer"), "{msg}");
    let msg = panics(|| c.execute(upgrade));
    assert!(msg.contains("not enough approvals"), "{msg}");

    // The transfer in flight settles normally.
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(CONTRACT.parse().unwrap())
            .block_timestamp(T0 + DAY + RECOVERY_DELAY)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(Vec::new())],
    );
    assert!(c.on_transfer_done(in_flight));
    assert_eq!(status(&c, &in_flight), ProposalStatus::Executed);

    // The removed creator's pending slots are released when their
    // proposals end, whoever ends them.
    ctx(T0 + DAY + RECOVERY_DELAY);
    c.cancel(pending, d.cancel(&pending, epoch + 1));
    c.cancel(upgrade, e.cancel(&upgrade, epoch + 1));
    assert_eq!(c.pending_per_signer.get(&a.id), None);
}

#[test]
fn recovery_nonce_replay_rejected() {
    let (mut c, a, _b, _c) = with_kit(2);
    let d = new_signer(4);
    let signers = [d.signer()];
    let sig = kit_sign(CONTRACT, &signers, 1, 5);
    c.start_recovery(signers.to_vec(), 1, U64(5), U64(VALID_UNTIL), sig.clone());

    // Only one recovery at a time.
    let msg = panics(|| start(&mut c, &signers, 1, 6));
    assert!(msg.contains("recovery already pending"), "{msg}");

    c.cancel_recovery(recovery_cancel(&a, 0, 5));
    // The cancelled recovery's signature cannot start it again.
    let msg =
        panics(|| c.start_recovery(signers.to_vec(), 1, U64(5), U64(VALID_UNTIL), sig.clone()));
    assert!(msg.contains("nonce"), "{msg}");
    let msg = panics(|| start(&mut c, &signers, 1, 4));
    assert!(msg.contains("nonce"), "{msg}");
    assert_eq!(c.get_recovery_nonce(), U64(5));

    // The signature binds every field and this contract.
    let msg =
        panics(|| c.start_recovery(signers.to_vec(), 1, U64(6), U64(VALID_UNTIL), sig.clone()));
    assert!(msg.contains("invalid recovery signature"), "{msg}");
    let other = kit_sign("b.tendr.testnet", &signers, 1, 6);
    let msg = panics(|| c.start_recovery(signers.to_vec(), 1, U64(6), U64(VALID_UNTIL), other));
    assert!(msg.contains("invalid recovery signature"), "{msg}");
    let short = Base64VecU8(vec![0; 63]);
    let msg = panics(|| c.start_recovery(signers.to_vec(), 1, U64(6), U64(VALID_UNTIL), short));
    assert!(msg.contains("invalid recovery signature"), "{msg}");

    start(&mut c, &signers, 1, 6);
    assert!(c.get_recovery().is_some());
}

#[test]
fn rotation_recovers_from_a_max_nonce_and_voids_old_key_epochs() {
    let (mut c, a, b, _c) = with_kit(2);
    let d = new_signer(4);
    let signers = [d.signer()];

    // A kit thief burns the nonce space; the signers cancel.
    start(&mut c, &signers, 1, u64::MAX);
    let ev = last_event("recovery_started");
    assert_eq!(ev["data"]["nonce"], u64::MAX.to_string());
    assert_eq!(ev["data"]["recovery_key_epoch"], "0");
    assert_eq!(ev["data"]["recovery_id"], hex(&rid(u64::MAX).0));
    c.cancel_recovery(recovery_cancel(&a, 0, u64::MAX));
    let msg = panics(|| start(&mut c, &signers, 1, u64::MAX));
    assert!(msg.contains("nonce"), "{msg}");
    let old_payload = sign_with(&kit(), CONTRACT, &signers, 1, 1, 0, VALID_UNTIL);

    // Rotating to a new kit starts recovery-key epoch 1 with a fresh nonce.
    let kit2 = ed25519_key(10);
    let pk2 = kit2.verifying_key().to_bytes();
    let rot = propose(&mut c, &a, Action::RotateRecoveryKey(Some(pk2)), 1);
    c.approve(rot, b.approve(&rot, 0));
    assert_eq!(key_epoch(&c), 0, "rotation waits for its timelock");
    run_timelock(&mut c, &rot);
    assert_eq!(key_epoch(&c), 1);
    assert_eq!(c.get_recovery_nonce(), U64(0));
    let sig = sign_with(&kit2, CONTRACT, &signers, 1, 1, 1, VALID_UNTIL);
    c.start_recovery(signers.to_vec(), 1, U64(1), U64(VALID_UNTIL), sig);
    let r = c.get_recovery().unwrap();
    assert_eq!((r.nonce, r.recovery_key_epoch), (U64(1), U64(1)));
    // Its id differs from nonce 1 under epoch 0, so old cancels do not fit.
    assert_eq!(r.recovery_id, ProposalId(recovery_id(CONTRACT, 1, 1)));
    let epoch = c.get_config().signer_epoch.0;
    let msg = panics(|| c.cancel_recovery(recovery_cancel(&a, epoch, 1)));
    assert!(msg.contains("invalid approval"), "{msg}");
    let cancel = a.approval_for(CONTRACT, 0, &r.recovery_id, epoch, ApprovalIntent::Cancel);
    c.cancel_recovery(cancel);

    // Rotating back to the first kit: epoch 2. Its epoch-0 payload is dead.
    let back = propose(&mut c, &a, Action::RotateRecoveryKey(Some(kit_pk())), 2);
    c.approve(back, b.approve(&back, epoch));
    run_timelock(&mut c, &back);
    assert_eq!(key_epoch(&c), 2);
    let msg = panics(|| {
        c.start_recovery(
            signers.to_vec(),
            1,
            U64(1),
            U64(VALID_UNTIL),
            old_payload.clone(),
        )
    });
    assert!(msg.contains("invalid recovery signature"), "{msg}");
    start(&mut c, &signers, 1, 1);
    assert!(c.get_recovery().is_some());
}

#[test]
fn recovery_payload_valid_until_enforced() {
    let (mut c, _a, _b, _c) = with_kit(2);
    let signers = [new_signer(4).signer()];
    let start_until = |c: &mut MerchantAccount, valid_until: u64| {
        let sig = sign_with(&kit(), CONTRACT, &signers, 1, 1, 0, valid_until);
        c.start_recovery(signers.to_vec(), 1, U64(1), U64(valid_until), sig);
    };
    let msg = panics(|| start_until(&mut c, T0 - 1));
    assert!(msg.contains("expired"), "{msg}");
    let msg = panics(|| start_until(&mut c, T0 + MAX_RECOVERY_VALIDITY + 1));
    assert!(msg.contains("30 days"), "{msg}");
    // A payload signed for one valid_until cannot claim another.
    let sig = sign_with(&kit(), CONTRACT, &signers, 1, 1, 0, T0 + DAY);
    let msg = panics(|| c.start_recovery(signers.to_vec(), 1, U64(1), U64(T0 + 2 * DAY), sig));
    assert!(msg.contains("invalid recovery signature"), "{msg}");
    assert!(c.get_recovery().is_none());
    // Both bounds are inclusive.
    start_until(&mut c, T0 + MAX_RECOVERY_VALIDITY);
    assert_eq!(MAX_RECOVERY_VALIDITY, 30 * DAY);
}

#[test]
fn recovery_rejects_threshold_above_new_signer_count() {
    let (mut c, _a, _b, _c) = with_kit(2);
    let (d, e) = (new_signer(4), new_signer(5));
    let two = [d.signer(), e.signer()];
    let msg = panics(|| start(&mut c, &two, 3, 1));
    assert!(msg.contains("threshold must be between 1"), "{msg}");
    let msg = panics(|| start(&mut c, &two, 0, 1));
    assert!(msg.contains("threshold must be between 1"), "{msg}");
    let msg = panics(|| start(&mut c, &[], 1, 1));
    assert!(msg.contains("at least one signer"), "{msg}");
    assert!(c.get_recovery().is_none());
}

#[test]
fn recovery_validates_new_signers_like_add_signer() {
    let (mut c, _a, _b, _c) = with_kit(2);
    let d = new_signer(4);

    let mut bad_id = d.signer();
    bad_id.id = "usr_1".into();
    let mut kit_as_key = d.signer();
    kit_as_key.keys.push(SignerKey::Ed25519(kit_pk()));
    let mut no_keys = d.signer();
    no_keys.keys.clear();
    let mut bad_point = d.signer();
    bad_point.keys = vec![invalid_p256_keys()[2].clone()];
    let mut shares_key = new_signer(5).signer();
    shares_key.keys = d.signer().keys;
    let too_many: Vec<Signer> = (0..=action::MAX_SIGNERS as u8)
        .map(|n| Signer {
            id: person_id(10 + n),
            keys: vec![SignerKey::Ed25519(
                ed25519_key(100 + n).verifying_key().to_bytes(),
            )],
        })
        .collect();

    let cases: Vec<(Vec<Signer>, &str)> = vec![
        (vec![bad_id], "per_"),
        (vec![kit_as_key], "recovery key"),
        (vec![no_keys], "at least one key"),
        (vec![bad_point], "curve point"),
        (vec![d.signer(), shares_key], "key already registered"),
        (vec![d.signer(), d.signer()], "duplicate signer"),
        (too_many, "too many signers"),
    ];
    for (signers, want) in cases {
        let msg = panics(|| start(&mut c, &signers, 1, 1));
        assert!(msg.contains(want), "want {want}: {msg}");
    }
    assert!(c.get_recovery().is_none());
}

#[test]
fn recovery_needs_a_recovery_key() {
    let (mut c, _a, _b, _c) = three_of(2);
    let d = new_signer(4);
    let msg = panics(|| start(&mut c, &[d.signer()], 1, 1));
    assert!(msg.contains("no recovery key"), "{msg}");
}

#[test]
fn rotating_the_recovery_key_drops_a_pending_recovery() {
    let (mut c, a, b, _c) = with_kit(2);
    let d = new_signer(4);
    start(&mut c, &[d.signer()], 1, 1);
    let new_kit = ed25519_key(10).verifying_key().to_bytes();
    let id = propose(&mut c, &a, Action::RotateRecoveryKey(Some(new_kit)), 1);
    c.approve(id, b.approve(&id, 0));
    run_timelock(&mut c, &id);
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    assert!(c.get_recovery().is_none());
    let ev = last_event("recovery_cancelled");
    assert_eq!(ev["data"]["reason"], "recovery_key_rotated");
    assert!(ev["data"].get("signer_id").is_none(), "{ev}");
    assert_eq!(key_epoch(&c), 1);
    ctx(T0 + RECOVERY_DELAY);
    let msg = panics(|| c.execute_recovery());
    assert!(msg.contains("no recovery"), "{msg}");
}

/// The use-global-contract and function-call actions of created receipts.
fn upgrade_actions() -> Vec<(String, String)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::UseGlobalContract { contract_id, .. } => {
                    Some((receiver.clone(), format!("use:{contract_id:?}")))
                }
                MockAction::FunctionCallWeight { method_name, .. } => Some((
                    receiver.clone(),
                    format!("call:{}", String::from_utf8(method_name).unwrap()),
                )),
                _ => None,
            })
        })
        .collect()
}

#[test]
fn upgrade_requires_threshold() {
    let (mut c, a, b, _c) = three_of(2);
    let hash = [7u8; 32];
    let id = propose(&mut c, &a, Action::Upgrade { code_hash: hash }, 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not enough approvals"), "{msg}");
    assert!(upgrade_actions().is_empty());

    // The threshold starts a 24 h timelock rather than upgrading.
    c.approve(id, b.approve(&id, 0));
    assert_eq!(
        c.get_proposal(id).unwrap().ready_at,
        Some(U64(T0 + TIMELOCK_DELAY))
    );
    assert_eq!(
        last_event("timelock_started")["data"]["proposal_id"],
        hex(&id.0)
    );
    assert!(upgrade_actions().is_empty());
    ctx(T0 + TIMELOCK_DELAY - 1);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("timelocked"), "{msg}");

    ctx(T0 + TIMELOCK_DELAY);
    c.execute(id);
    assert_eq!(status(&c, &id), ProposalStatus::Executing);
    let acts = upgrade_actions();
    assert_eq!(acts[0].0, CONTRACT, "{acts:?}");
    assert!(acts[0].1.starts_with("use:CodeHash("), "{acts:?}");
    assert!(
        acts[0]
            .1
            .contains(&near_sdk::bs58::encode(hash).into_string()),
        "{acts:?}"
    );
    assert_eq!(acts[1], (CONTRACT.to_string(), "call:migrate".to_string()));
    assert_eq!(
        acts[2],
        (CONTRACT.to_string(), "call:on_upgrade_done".to_string())
    );

    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(CONTRACT.parse().unwrap())
            .block_timestamp(T0 + TIMELOCK_DELAY)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(Vec::new())],
    );
    assert!(c.on_upgrade_done(id));
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    assert_eq!(
        last_event("proposal_executed")["data"]["proposal_id"],
        hex(&id.0)
    );
}

#[test]
fn failed_upgrade_marks_failed() {
    let (mut c, a, _b, _c) = three_of(1);
    let id = propose(&mut c, &a, Action::Upgrade { code_hash: [7; 32] }, 1);
    ctx(T0 + TIMELOCK_DELAY);
    c.execute(id);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(CONTRACT.parse().unwrap())
            .block_timestamp(T0 + TIMELOCK_DELAY)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed],
    );
    assert!(!c.on_upgrade_done(id));
    assert_eq!(status(&c, &id), ProposalStatus::Failed);
}

#[test]
fn timelocked_upgrade_can_be_cancelled() {
    let (mut c, a, b, cc) = three_of(2);
    let id = propose(&mut c, &a, Action::Upgrade { code_hash: [7; 32] }, 1);
    c.approve(id, b.approve(&id, 0));
    c.cancel(id, cc.cancel(&id, 0));
    assert_eq!(status(&c, &id), ProposalStatus::Cancelled);
    ctx(T0 + TIMELOCK_DELAY);
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not pending"), "{msg}");
    assert!(upgrade_actions().is_empty());
}

#[test]
fn migrate_keeps_state() {
    let (c, _a, _b, _c) = with_kit(2);
    env::state_write(&c);
    let m = MerchantAccount::migrate();
    assert_eq!(m.get_config(), c.get_config());
    assert_eq!(m.state_version, STATE_VERSION);
}

#[cfg(feature = "testnet-admin")]
#[test]
fn admin_sync_only_by_admin() {
    const ADMIN: &str = "admin.tendr.testnet";
    let as_caller = |who: &str| {
        testing_env!(VMContextBuilder::new()
            .current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .block_timestamp(T0)
            .build());
    };
    ctx(T0);
    let (a, b, cc) = (person(1, 1), person(2, 1), person(3, 1));
    let mut cfg = config(&[&a, &b, &cc], 2);
    cfg.recovery_key = Some(kit_pk());
    cfg.testnet_admin = Some(ADMIN.parse().unwrap());
    let mut c = MerchantAccount::new(cfg);
    let d = new_signer(4);
    let pending = propose(&mut c, &a, Action::SetThreshold(3), 1);

    for who in ["relayer.tendr.testnet", CONTRACT, "evil.testnet"] {
        as_caller(who);
        let msg = panics(|| c.admin_sync_signers(vec![d.signer()], 1));
        assert!(msg.contains("only the testnet admin"), "{who}: {msg}");
    }

    as_caller(ADMIN);
    let msg = panics(|| c.admin_sync_signers(vec![d.signer()], 2));
    assert!(msg.contains("threshold must be between 1"), "{msg}");
    let mut kit_key = d.signer();
    kit_key.keys = vec![SignerKey::Ed25519(kit_pk())];
    let msg = panics(|| c.admin_sync_signers(vec![kit_key], 1));
    assert!(msg.contains("recovery key"), "{msg}");

    c.admin_sync_signers(vec![a.signer(), d.signer()], 2);
    let cfg = c.get_config();
    assert_eq!(signer_ids(&c), vec![a.id.clone(), d.id.clone()]);
    assert_eq!((cfg.threshold, cfg.signer_epoch), (2, U64(1)));
    assert_eq!(valid(&c, &pending), 0);
    let ev = last_event("signers_changed");
    assert_eq!(ev["data"]["signer_epoch"], "1");
    assert_eq!(ev["data"]["proposal_id"], serde_json::Value::Null);
}

#[cfg(feature = "testnet-admin")]
#[test]
fn admin_sync_rejected_without_configured_admin() {
    let (mut c, _a, _b, _c) = three_of(2);
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("admin.tendr.testnet".parse().unwrap())
        .block_timestamp(T0)
        .build());
    let msg = panics(|| c.admin_sync_signers(vec![new_signer(4).signer()], 1));
    assert!(msg.contains("only the testnet admin"), "{msg}");
}

/// Writes (with `UPDATE_VECTORS=1`) or checks the shared Rust/TypeScript
/// recovery-payload vectors.
#[test]
fn write_recovery_vectors() {
    ctx(T0);
    let contract_id = "mystore.tendr.testnet";
    let signers = vec![
        Signer {
            id: person_id(7),
            keys: vec![
                p256_signer(&p256_key(1)),
                SignerKey::Ed25519(ed25519_key(2).verifying_key().to_bytes()),
            ],
        },
        Signer {
            id: person_id(8),
            keys: vec![p256_signer(&p256_key(3))],
        },
    ];
    let (threshold, nonce) = (2u8, 1_761_350_400_000u64);
    let (key_epoch, valid_until) = (1u64, 1_761_955_200_000_000_000u64);
    let payload = RecoveryPayload::new(
        contract_id,
        &signers,
        threshold,
        nonce,
        key_epoch,
        valid_until,
    );
    let hash = payload.hash();
    let sig = ed25519_dalek::Signer::sign(&kit(), &hash);
    let doc = serde_json::json!({
        "note": "Generated by `UPDATE_VECTORS=1 cargo test -p merchant-account write_recovery_vectors`. The recovery key signs message = sha256(borsh(RecoveryPayload)) with Ed25519 (the 32-byte hash is the signed message). *_hex fields are lowercase hex; key bytes inside `new_signers` are standard padded base64. `signature_b64` is standard padded base64 of the 64-byte signature by the test kit key (ed25519 seed [9; 32]).",
        "domain": crate::recovery::RECOVERY_DOMAIN,
        "contract_id": contract_id,
        "new_signers": signers,
        "new_threshold": threshold,
        "nonce": nonce.to_string(),
        "recovery_key_epoch": key_epoch.to_string(),
        "valid_until": valid_until.to_string(),
        "recovery_public_key_b64": b64(&kit_pk()),
        "payload_borsh_hex": hex(&near_sdk::borsh::to_vec(&payload).unwrap()),
        "message_hex": hex(&hash),
        "signature_b64": b64(&sig.to_bytes()),
    });
    let rendered = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/test-vectors/recovery-payloads.json"
    );
    if std::env::var("UPDATE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(path, &rendered).unwrap();
    }
    let committed = std::fs::read_to_string(path)
        .expect("test-vectors/recovery-payloads.json missing; run with UPDATE_VECTORS=1");
    assert_eq!(
        committed, rendered,
        "recovery vectors changed; regenerate with UPDATE_VECTORS=1"
    );
}
