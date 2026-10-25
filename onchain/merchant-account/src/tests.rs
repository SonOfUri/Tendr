//! Contract unit tests (near-sdk mocked blockchain).

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{serde_json, testing_env};

use super::*;
use crate::action::{PayoutMode, WithdrawRoute};
use crate::approval::ApprovalPayload;
use crate::webauthn::test_support::{
    ed25519_key, p256_key, p256_signer, sign_ed25519_challenge, sign_p256_challenge, ORIGIN,
};

const CONTRACT: &str = "a.tendr.testnet";
/// PoA token suffix the test accounts are configured with.
const POA_SUFFIX: &str = "poa.tendr.testnet";
const T0: u64 = 1_700_000_000_000_000_000;

fn ctx_at(contract: &str, now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(contract.parse().unwrap())
        .predecessor_account_id("relayer.tendr.testnet".parse().unwrap())
        .block_timestamp(now)
        .build());
}

fn ctx(now: u64) {
    ctx_at(CONTRACT, now);
}

/// A test person with one P-256 passkey per device.
struct Person {
    id: String,
    devices: Vec<p256::ecdsa::SigningKey>,
}

fn person_id(n: u8) -> String {
    format!("per_01JBZ8Y{n:019}")
}

fn person(n: u8, devices: u8) -> Person {
    Person {
        id: person_id(n),
        devices: (0..devices).map(|d| p256_key(n * 10 + d + 1)).collect(),
    }
}

impl Person {
    fn signer(&self) -> Signer {
        Signer {
            id: self.id.clone(),
            keys: self.devices.iter().map(p256_signer).collect(),
        }
    }

    fn approval_for(
        &self,
        contract: &str,
        device: usize,
        id: &ProposalId,
        epoch: u64,
        intent: ApprovalIntent,
    ) -> SignedApproval {
        let sk = &self.devices[device];
        let challenge = ApprovalPayload::new(contract, id, epoch, intent).challenge();
        SignedApproval {
            signer_id: self.id.clone(),
            key: p256_signer(sk),
            assertion: sign_p256_challenge(sk, &challenge),
        }
    }

    fn approve(&self, id: &ProposalId, epoch: u64) -> SignedApproval {
        self.approval_for(CONTRACT, 0, id, epoch, ApprovalIntent::Approve)
    }

    fn cancel(&self, id: &ProposalId, epoch: u64) -> SignedApproval {
        self.approval_for(CONTRACT, 0, id, epoch, ApprovalIntent::Cancel)
    }
}

fn config(people: &[&Person], threshold: u8) -> InitConfig {
    InitConfig {
        signers: people.iter().map(|p| p.signer()).collect(),
        threshold,
        recovery_key: None,
        rp_id: "localhost".to_string(),
        origins: vec![ORIGIN.to_string()],
        intents_contract: "intents-mock.tendr.testnet".parse().unwrap(),
        poa_suffix: Some(POA_SUFFIX.to_string()),
        testnet_admin: None,
    }
}

fn salt(n: u8) -> Salt {
    Salt([n; 32])
}

/// Proposes `action` (salt `n`) with `by`'s approval at the current epoch.
fn propose(c: &mut MerchantAccount, by: &Person, action: Action, n: u8) -> ProposalId {
    let id = ProposalId::new(&action, &salt(n).0);
    let epoch = c.get_config().signer_epoch.0;
    c.propose(action, salt(n), by.approve(&id, epoch))
}

fn panics(f: impl FnOnce()) -> String {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn status(c: &MerchantAccount, id: &ProposalId) -> ProposalStatus {
    c.get_proposal(*id).unwrap().status
}

fn valid(c: &MerchantAccount, id: &ProposalId) -> u8 {
    c.get_proposal(*id).unwrap().valid_approvals
}

fn signer_ids(c: &MerchantAccount) -> Vec<String> {
    c.get_config().signers.into_iter().map(|s| s.id).collect()
}

fn three_of(threshold: u8) -> (MerchantAccount, Person, Person, Person) {
    ctx(T0);
    let (a, b, cc) = (person(1, 1), person(2, 1), person(3, 1));
    let contract = MerchantAccount::new(config(&[&a, &b, &cc], threshold));
    (contract, a, b, cc)
}

/// An ULID-shaped person id that is not one of the test people.
fn new_signer(n: u8) -> Person {
    person(n, 1)
}

fn events(logs: &[String]) -> Vec<serde_json::Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

#[test]
fn init_sets_config() {
    let (c, a, b, cc) = three_of(2);
    let cfg = c.get_config();
    assert_eq!(cfg.signers, vec![a.signer(), b.signer(), cc.signer()]);
    assert_eq!(cfg.threshold, 2);
    assert_eq!(cfg.signer_epoch, U64(0));
    assert_eq!(cfg.origins, vec![ORIGIN.to_string()]);
    assert_eq!(cfg.rp_id, "localhost");
    assert!(!cfg.recovery_key_set);
}

#[test]
fn n_minus_one_approvals_never_execute() {
    let (mut c, a, _b, _c) = three_of(2);
    let d = new_signer(4);
    let id = propose(&mut c, &a, Action::AddSigner(d.signer()), 1);

    let p = c.get_proposal(id).unwrap();
    assert_eq!(p.status, ProposalStatus::Pending);
    assert_eq!(p.valid_approvals, 1);
    assert_eq!(p.ready_at, None);
    assert_eq!(signer_ids(&c).len(), 3);
    assert_eq!(c.get_config().signer_epoch, U64(0));

    // Nor can anyone force it through `execute`.
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not enough approvals"), "{msg}");
    assert_eq!(signer_ids(&c).len(), 3);

    let evs = events(&get_logs());
    assert_eq!(evs[0]["standard"], "tendr-merchant-account");
    assert_eq!(evs[0]["version"], "1.0.0");
    assert_eq!(evs[0]["event"], "proposal_created");
    assert_eq!(evs[0]["data"]["proposal_id"], hex(&id.0));
    assert_eq!(evs[0]["data"]["signer_id"], a.id);
    assert_eq!(
        evs[0]["data"]["action"]["add_signer"]["id"],
        serde_json::Value::String(d.id.clone())
    );
    assert_eq!(evs[1]["event"], "proposal_approved");
    assert_eq!(evs[1]["data"]["approvals"], 1);
    assert_eq!(evs[1]["data"]["threshold"], 2);
}

#[test]
fn threshold_approvals_execute_and_emit_events() {
    let (mut c, a, b, _c) = three_of(2);
    let d = new_signer(4);
    let id = propose(&mut c, &a, Action::AddSigner(d.signer()), 1);
    c.approve(id, b.approve(&id, 0));

    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    assert_eq!(signer_ids(&c).len(), 4);
    assert_eq!(c.get_config().signer_epoch, U64(1));
    let evs = events(&get_logs());
    let names: Vec<_> = evs.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "proposal_created",
            "proposal_approved",
            "proposal_approved",
            "proposal_executed",
            "signers_changed"
        ]
    );
    assert_eq!(evs[4]["data"]["signer_epoch"], "1");
    assert_eq!(evs[4]["data"]["proposal_id"], hex(&id.0));
}

#[test]
fn same_signer_two_devices_counts_once() {
    ctx(T0);
    let a = person(1, 2);
    let (b, cc) = (person(2, 1), person(3, 1));
    let mut c = MerchantAccount::new(config(&[&a, &b, &cc], 2));
    let id = propose(&mut c, &a, Action::SetThreshold(3), 1);

    let second_device = a.approval_for(CONTRACT, 1, &id, 0, ApprovalIntent::Approve);
    let msg = panics(|| c.approve(id, second_device));
    assert!(msg.contains("already approved"), "{msg}");
    assert_eq!(valid(&c, &id), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
    assert_eq!(c.get_config().threshold, 2);
}

#[test]
#[should_panic(expected = "challenge mismatch")]
fn approval_bound_to_contract_id() {
    ctx_at("b.tendr.testnet", T0);
    let (a, b) = (person(1, 1), person(2, 1));
    let mut c = MerchantAccount::new(config(&[&a, &b], 2));
    let action = Action::SetThreshold(1);
    let id = ProposalId::new(&action, &salt(1).0);
    // Same passkey, same proposal bytes, but hashed for store A.
    let for_a = a.approval_for("a.tendr.testnet", 0, &id, 0, ApprovalIntent::Approve);
    c.propose(action, salt(1), for_a);
}

#[test]
#[should_panic(expected = "key is not registered to this signer")]
fn approval_from_unknown_key_rejected() {
    let (mut c, a, _b, _c) = three_of(2);
    let action = Action::SetThreshold(1);
    let id = ProposalId::new(&action, &salt(1).0);
    let stranger = person(9, 1);
    let mut approval = stranger.approve(&id, 0);
    approval.signer_id = a.id.clone();
    c.propose(action, salt(1), approval);
}

#[test]
#[should_panic(expected = "unknown signer")]
fn approval_from_unknown_signer_rejected() {
    let (mut c, _a, _b, _c) = three_of(2);
    let action = Action::SetThreshold(1);
    let id = ProposalId::new(&action, &salt(1).0);
    c.propose(action, salt(1), person(9, 1).approve(&id, 0));
}

#[test]
fn replayed_cancel_intent_cannot_approve() {
    let (mut c, a, b, _c) = three_of(2);
    let id = propose(&mut c, &a, Action::SetThreshold(3), 1);
    let msg = panics(|| c.approve(id, b.cancel(&id, 0)));
    assert!(msg.contains("challenge mismatch"), "{msg}");
    assert_eq!(valid(&c, &id), 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);
}

#[test]
#[should_panic(expected = "threshold must be between 1 and the number of signers")]
fn threshold_above_signer_count_rejected_at_init() {
    three_of(4);
}

#[test]
#[should_panic(expected = "threshold must be between 1 and the number of signers")]
fn threshold_zero_rejected_at_init() {
    three_of(0);
}

#[test]
#[should_panic(expected = "threshold must be between 1 and the number of signers")]
fn threshold_above_signer_count_rejected_via_set_threshold() {
    let (mut c, a, _b, _c) = three_of(2);
    propose(&mut c, &a, Action::SetThreshold(4), 1);
}

#[test]
fn signer_change_bumps_epoch_and_voids_pending_approvals() {
    let (mut c, a, b, cc) = three_of(2);
    let d = new_signer(4);
    // P1 has 1 of 2 approvals.
    let p1 = propose(&mut c, &a, Action::AddSigner(d.signer()), 1);
    assert_eq!(valid(&c, &p1), 1);

    // P2 removes C and executes: epoch 0 -> 1.
    let p2 = propose(&mut c, &a, Action::RemoveSigner { id: cc.id.clone() }, 2);
    c.approve(p2, b.approve(&p2, 0));
    assert_eq!(status(&c, &p2), ProposalStatus::Executed);
    assert_eq!(c.get_config().signer_epoch, U64(1));

    // A's epoch-0 approval of P1 no longer counts.
    assert_eq!(valid(&c, &p1), 0);
    // An approval signed for the old epoch is rejected.
    let msg = panics(|| c.approve(p1, b.approve(&p1, 0)));
    assert!(msg.contains("challenge mismatch"), "{msg}");
    // B at the new epoch is 1 of 2: A's stale approval does not add to it.
    c.approve(p1, b.approve(&p1, 1));
    assert_eq!(valid(&c, &p1), 1);
    assert_eq!(status(&c, &p1), ProposalStatus::Pending);
    // A re-approves at epoch 1 and P1 executes.
    c.approve(p1, a.approve(&p1, 1));
    assert_eq!(status(&c, &p1), ProposalStatus::Executed);
    assert_eq!(
        signer_ids(&c),
        vec![a.id.clone(), b.id.clone(), d.id.clone()]
    );
    assert_eq!(c.get_config().signer_epoch, U64(2));
}

#[test]
fn threshold_change_bumps_epoch() {
    let (mut c, a, b, _c) = three_of(2);
    let pending = propose(&mut c, &a, Action::RotateRecoveryKey(Some([7; 32])), 1);
    let id = propose(&mut c, &a, Action::SetThreshold(3), 2);
    c.approve(id, b.approve(&id, 0));
    let cfg = c.get_config();
    assert_eq!((cfg.threshold, cfg.signer_epoch), (3, U64(1)));
    assert_eq!(valid(&c, &pending), 0);
}

#[test]
fn key_only_and_origin_changes_keep_epoch() {
    let (mut c, a, b, _c) = three_of(2);
    let new_key = p256_signer(&p256_key(99));
    let id = propose(
        &mut c,
        &a,
        Action::AddSignerKey {
            id: a.id.clone(),
            key: new_key.clone(),
        },
        1,
    );
    c.approve(id, b.approve(&id, 0));
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
    let id = propose(
        &mut c,
        &a,
        Action::SetOrigins(vec![ORIGIN.into(), "https://usetendr.tech".into()]),
        2,
    );
    c.approve(id, b.approve(&id, 0));
    let id = propose(
        &mut c,
        &a,
        Action::RemoveSignerKey {
            id: a.id.clone(),
            key: new_key.clone(),
        },
        3,
    );
    c.approve(id, b.approve(&id, 0));
    let cfg = c.get_config();
    assert_eq!(cfg.signer_epoch, U64(0));
    assert_eq!(cfg.origins.len(), 2);
    assert_eq!(cfg.signers[0].keys, a.signer().keys);
}

#[test]
fn approval_by_removed_key_stops_counting() {
    ctx(T0);
    let a = person(1, 2);
    let (b, cc) = (person(2, 1), person(3, 1));
    let mut c = MerchantAccount::new(config(&[&a, &b, &cc], 2));
    // A's second device approves P1.
    let action = Action::SetThreshold(3);
    let p1 = ProposalId::new(&action, &salt(1).0);
    c.propose(
        action,
        salt(1),
        a.approval_for(CONTRACT, 1, &p1, 0, ApprovalIntent::Approve),
    );
    // That device is removed (no epoch bump).
    let p2 = propose(
        &mut c,
        &b,
        Action::RemoveSignerKey {
            id: a.id.clone(),
            key: p256_signer(&a.devices[1]),
        },
        2,
    );
    c.approve(p2, cc.approve(&p2, 0));
    assert_eq!(c.get_config().signer_epoch, U64(0));
    assert_eq!(valid(&c, &p1), 0);
}

#[test]
fn removed_signer_cannot_approve() {
    let (mut c, a, b, cc) = three_of(2);
    let p1 = propose(&mut c, &a, Action::SetThreshold(1), 1);
    let p2 = propose(&mut c, &a, Action::RemoveSigner { id: cc.id.clone() }, 2);
    c.approve(p2, b.approve(&p2, 0));
    for epoch in [0, 1] {
        let msg = panics(|| c.approve(p1, cc.approve(&p1, epoch)));
        assert!(msg.contains("unknown signer"), "{msg}");
    }
    let msg = panics(|| c.cancel(p1, cc.cancel(&p1, 1)));
    assert!(msg.contains("unknown signer"), "{msg}");
}

#[test]
fn expired_proposal_cannot_execute() {
    let (mut c, a, b, _c) = three_of(2);
    let id = propose(&mut c, &a, Action::SetThreshold(3), 1);
    let expires_at = c.get_proposal(id).unwrap().expires_at.0;
    assert_eq!(expires_at, T0 + PROPOSAL_TTL);

    ctx(T0 + PROPOSAL_TTL - 1);
    assert_eq!(status(&c, &id), ProposalStatus::Pending);

    ctx(T0 + PROPOSAL_TTL);
    assert_eq!(status(&c, &id), ProposalStatus::Expired);
    let msg = panics(|| c.approve(id, b.approve(&id, 0)));
    assert!(msg.contains("expired"), "{msg}");
    c.execute(id);
    assert_eq!(status(&c, &id), ProposalStatus::Expired);
    assert_eq!(c.get_config().threshold, 2);
    let evs = events(&get_logs());
    assert_eq!(evs.last().unwrap()["event"], "proposal_failed");
    assert_eq!(evs.last().unwrap()["data"]["reason"], "expired");
    let msg = panics(|| c.execute(id));
    assert!(msg.contains("not pending"), "{msg}");
}

#[test]
fn any_signer_can_cancel_pending() {
    let (mut c, a, b, cc) = three_of(2);
    let id = propose(&mut c, &a, Action::SetThreshold(3), 1);
    c.cancel(id, cc.cancel(&id, 0));
    assert_eq!(status(&c, &id), ProposalStatus::Cancelled);
    let evs = events(&get_logs());
    assert_eq!(evs.last().unwrap()["event"], "proposal_cancelled");
    assert_eq!(evs.last().unwrap()["data"]["signer_id"], cc.id);

    let msg = panics(|| c.approve(id, b.approve(&id, 0)));
    assert!(msg.contains("not pending"), "{msg}");
    assert_eq!(c.get_config().threshold, 2);
}

#[test]
#[should_panic(expected = "challenge mismatch")]
fn approve_intent_cannot_cancel() {
    let (mut c, a, b, _c) = three_of(2);
    let id = propose(&mut c, &a, Action::SetThreshold(3), 1);
    c.cancel(id, b.approve(&id, 0));
}

#[test]
#[should_panic(expected = "proposal already exists")]
fn same_action_and_salt_cannot_be_proposed_twice() {
    let (mut c, a, b, _c) = three_of(2);
    propose(&mut c, &a, Action::SetThreshold(3), 1);
    propose(&mut c, &b, Action::SetThreshold(3), 1);
}

#[test]
fn invalid_at_execute_marks_failed() {
    let (mut c, a, b, cc) = three_of(2);
    // P1: remove C (1 of 2).
    let p1 = propose(&mut c, &a, Action::RemoveSigner { id: cc.id.clone() }, 1);
    // P2 removes B: 2 signers left, threshold 2, epoch 1.
    let p2 = propose(&mut c, &a, Action::RemoveSigner { id: b.id.clone() }, 2);
    c.approve(p2, cc.approve(&p2, 0));
    assert_eq!(signer_ids(&c), vec![a.id.clone(), cc.id.clone()]);
    // P1 at epoch 1 would leave one signer under threshold 2.
    c.approve(p1, a.approve(&p1, 1));
    c.approve(p1, cc.approve(&p1, 1));
    assert_eq!(status(&c, &p1), ProposalStatus::Failed);
    assert_eq!(signer_ids(&c).len(), 2);
    let evs = events(&get_logs());
    assert_eq!(evs.last().unwrap()["event"], "proposal_failed");
}

#[cfg(not(feature = "testnet-admin"))]
#[test]
#[should_panic(expected = "testnet_admin requires the testnet-admin feature")]
fn init_rejects_testnet_admin_without_feature() {
    ctx(T0);
    let (a, b) = (person(1, 1), person(2, 1));
    let mut cfg = config(&[&a, &b], 1);
    cfg.testnet_admin = Some("admin.tendr.testnet".parse().unwrap());
    MerchantAccount::new(cfg);
}

#[cfg(feature = "testnet-admin")]
#[test]
fn init_accepts_testnet_admin_with_feature() {
    ctx(T0);
    let (a, b) = (person(1, 1), person(2, 1));
    let mut cfg = config(&[&a, &b], 1);
    cfg.testnet_admin = Some("admin.tendr.testnet".parse().unwrap());
    MerchantAccount::new(cfg);
}

/// Compressed points that are not on P-256: x ≥ p, and a bad prefix.
fn invalid_p256_keys() -> Vec<SignerKey> {
    let mut x_too_big = [0xFF; 33];
    x_too_big[0] = 0x02;
    let mut bad_prefix = match p256_signer(&p256_key(1)) {
        SignerKey::P256(b) => b,
        SignerKey::Ed25519(_) => unreachable!(),
    };
    // 0x05 is SEC1's 33-byte "compact" tag; only 0x02/0x03 are accepted.
    bad_prefix[0] = 0x05;
    // The smallest x < p for which x³ − 3x + b has no square root mod p.
    let off_curve = (1u8..)
        .map(|x| {
            let mut b = [0u8; 33];
            b[0] = 0x02;
            b[32] = x;
            b
        })
        .find(|b| p256::PublicKey::from_sec1_bytes(b).is_err())
        .unwrap();
    vec![
        SignerKey::P256(x_too_big),
        SignerKey::P256(bad_prefix),
        SignerKey::P256(off_curve),
    ]
}

#[test]
fn invalid_p256_key_rejected_everywhere() {
    for bad in invalid_p256_keys() {
        // At init.
        ctx(T0);
        let (a, b) = (person(1, 1), person(2, 1));
        let mut cfg = config(&[&a, &b], 2);
        cfg.signers[1].keys.push(bad.clone());
        let msg = panics(|| {
            MerchantAccount::new(cfg);
        });
        assert!(msg.contains("not a valid compressed curve point"), "{msg}");

        // Via AddSigner and AddSignerKey.
        let mut c = MerchantAccount::new(config(&[&a, &b], 2));
        let mut d = new_signer(4).signer();
        d.keys = vec![bad.clone()];
        let msg = panics(|| {
            propose(&mut c, &a, Action::AddSigner(d), 1);
        });
        assert!(msg.contains("not a valid compressed curve point"), "{msg}");
        let add_key = Action::AddSignerKey {
            id: b.id.clone(),
            key: bad.clone(),
        };
        let msg = panics(|| {
            propose(&mut c, &a, add_key, 2);
        });
        assert!(msg.contains("not a valid compressed curve point"), "{msg}");
    }
}

#[test]
fn signer_ids_must_be_person_ids() {
    for bad in [
        "usr_01JBZ8Y0000000000000000001",
        "per_01jbz8y0000000000000000001",
        "per_01JBZ8Y000000000000000001",
        "per_81JBZ8Y0000000000000000001",
        "per_01JBZ8Y000000000000000000I",
    ] {
        ctx(T0);
        let a = person(1, 1);
        let mut s = person(2, 1).signer();
        s.id = bad.to_string();
        let mut cfg = config(&[&a], 1);
        cfg.signers.push(s);
        let msg = panics(|| {
            MerchantAccount::new(cfg);
        });
        assert!(msg.contains("signer id must be per_"), "{bad}: {msg}");
    }
}

#[test]
fn duplicate_signers_and_shared_keys_rejected() {
    ctx(T0);
    let (a, b) = (person(1, 1), person(2, 1));
    let msg = panics(|| {
        MerchantAccount::new(config(&[&a, &a], 1));
    });
    assert!(msg.contains("duplicate signer"), "{msg}");

    // One key registered to two signers would let one device count twice.
    let mut cfg = config(&[&a, &b], 2);
    cfg.signers[1].keys = cfg.signers[0].keys.clone();
    let msg = panics(|| {
        MerchantAccount::new(cfg);
    });
    assert!(msg.contains("key already registered"), "{msg}");

    let mut c = MerchantAccount::new(config(&[&a, &b], 1));
    let shared = Action::AddSignerKey {
        id: b.id.clone(),
        key: a.signer().keys[0].clone(),
    };
    let msg = panics(|| {
        propose(&mut c, &a, shared, 1);
    });
    assert!(msg.contains("key already registered"), "{msg}");
}

#[test]
fn recovery_key_cannot_double_as_signer_key() {
    ctx(T0);
    let a = person(1, 1);
    let ed = ed25519_key(5);
    let pk = ed.verifying_key().to_bytes();
    let mut cfg = config(&[&a], 1);
    cfg.signers[0].keys.push(SignerKey::Ed25519(pk));
    cfg.recovery_key = Some(pk);
    let msg = panics(|| {
        MerchantAccount::new(cfg);
    });
    assert!(msg.contains("recovery key"), "{msg}");
}

#[test]
fn ed25519_signer_key_can_approve() {
    ctx(T0);
    let a = person(1, 1);
    let ed = ed25519_key(5);
    let mut cfg = config(&[&a], 1);
    let ed_id = person_id(2);
    cfg.signers.push(Signer {
        id: ed_id.clone(),
        keys: vec![SignerKey::Ed25519(ed.verifying_key().to_bytes())],
    });
    let mut c = MerchantAccount::new(cfg);
    let action = Action::SetThreshold(2);
    let id = ProposalId::new(&action, &salt(1).0);
    let challenge = ApprovalPayload::new(CONTRACT, &id, 0, ApprovalIntent::Approve).challenge();
    c.propose(
        action,
        salt(1),
        SignedApproval {
            signer_id: ed_id,
            key: SignerKey::Ed25519(ed.verifying_key().to_bytes()),
            assertion: sign_ed25519_challenge(&ed, &challenge),
        },
    );
    assert_eq!(c.get_config().threshold, 2);
}

#[test]
fn list_proposals_pages_in_creation_order() {
    let (mut c, a, _b, _c) = three_of(3);
    let ids: Vec<_> = (1..=3)
        .map(|n| propose(&mut c, &a, Action::SetThreshold(2), n))
        .collect();
    let page: Vec<_> = c.list_proposals(1, 5).into_iter().map(|p| p.id).collect();
    assert_eq!(page, ids[1..]);
    assert_eq!(c.list_proposals(0, 1)[0].id, ids[0]);
    assert!(c.list_proposals(3, 5).is_empty());
}

#[test]
fn proposal_id_json_is_hex_and_salt_is_base64() {
    let id = ProposalId([0xab; 32]);
    assert_eq!(serde_json::to_value(id).unwrap(), "ab".repeat(32));
    let back: ProposalId = serde_json::from_value(serde_json::json!("ab".repeat(32))).unwrap();
    assert_eq!(back, id);
    let s: Salt = serde_json::from_value(serde_json::json!(
        near_sdk::base64::engine::general_purpose::STANDARD.encode([1u8; 32])
    ))
    .unwrap();
    assert_eq!(s, salt(1));
}

fn long(n: usize) -> String {
    "x".repeat(n)
}

/// The PoA route for the test USDC (bridged to Base).
fn poa() -> WithdrawRoute {
    WithdrawRoute::Poa {
        token_contract: "base-usdc.poa.tendr.testnet".parse().unwrap(),
    }
}

#[test]
fn every_action_is_proposable() {
    let (mut c, a, _b, _c) = three_of(2);
    propose(&mut c, &a, Action::Upgrade { code_hash: [1; 32] }, 1);
    assert_eq!(c.list_proposals(0, 100).len(), 1);
}

#[test]
fn action_field_bounds_enforced() {
    let (mut c, a, b, _c) = three_of(2);
    let asset = || "nep141:usdc.tendr.testnet".to_string();
    let mut d = new_signer(4).signer();
    d.keys = (0..=action::MAX_KEYS_PER_SIGNER as u8)
        .map(|i| p256_signer(&p256_key(100 + i)))
        .collect();
    let cases: Vec<(Action, &str)> = vec![
        // Proposable (security) variants.
        (Action::RemoveSigner { id: long(65) }, "id must be 1 to 64"),
        (
            Action::AddSignerKey {
                id: long(65),
                key: p256_signer(&p256_key(99)),
            },
            "id must be 1 to 64",
        ),
        (
            Action::RemoveSignerKey {
                id: long(65),
                key: p256_signer(&p256_key(99)),
            },
            "id must be 1 to 64",
        ),
        (Action::AddSigner(d), "too many keys"),
        (
            Action::SetOrigins((0..11).map(|i| format!("https://o{i}.example")).collect()),
            "origins must list 1 to 10",
        ),
        (
            Action::SetOrigins(vec![format!("https://{}", long(250))]),
            "origins must list 1 to 10 entries of at most 256",
        ),
        // Not yet proposable: the size check still runs first.
        (
            Action::AddSavedAddress {
                id: long(65),
                chain: "base".into(),
                address: "0x1".into(),
            },
            "id must be 1 to 64",
        ),
        (
            Action::AddSavedAddress {
                id: "sav_1".into(),
                chain: long(17),
                address: "0x1".into(),
            },
            "chain must be 1 to 16",
        ),
        (
            Action::AddSavedAddress {
                id: "sav_1".into(),
                chain: "base".into(),
                address: long(129),
            },
            "address must be 1 to 128",
        ),
        (
            Action::AddSavedAddress {
                id: "sav_1".into(),
                chain: String::new(),
                address: "0x1".into(),
            },
            "chain must be 1 to 16",
        ),
        (
            Action::SetLimits {
                asset: long(129),
                per_tx: None,
                per_day: None,
            },
            "asset must be 1 to 128",
        ),
        (
            Action::SetAutoSweep {
                asset: asset(),
                trigger_above: U128(2),
                keep: U128(1),
                saved_address_id: long(65),
            },
            "id must be 1 to 64",
        ),
        (
            Action::Refund {
                asset: asset(),
                amount: U128(1),
                destination_chain: "base".into(),
                destination: long(129),
                payment_id: "pay_1".into(),
                route: poa(),
            },
            "address must be 1 to 128",
        ),
        (
            Action::Refund {
                asset: asset(),
                amount: U128(1),
                destination_chain: "base".into(),
                destination: "0x1".into(),
                payment_id: long(65),
                route: poa(),
            },
            "id must be 1 to 64",
        ),
        (
            Action::SetSettlement {
                dest_asset: long(129),
                payout_mode: PayoutMode::Intents,
                saved_address_id: None,
            },
            "asset must be 1 to 128",
        ),
    ];
    for (n, (action, expected)) in cases.into_iter().enumerate() {
        let name = format!("{action:?}");
        let msg = panics(|| {
            propose(&mut c, &a, action, n as u8);
        });
        assert!(msg.contains(expected), "{name}: {msg}");
    }
    assert!(c.list_proposals(0, 100).is_empty());

    // At the limit is fine (64-char saved-address id, 16-char chain, 128-char address).
    assert_eq!(
        action::validate_bounds(&Action::AddSavedAddress {
            id: long(64),
            chain: long(16),
            address: long(128),
        }),
        Ok(())
    );
    // Ten origins of up to 256 characters are accepted end to end.
    let origins: Vec<String> = (0..10)
        .map(|i| format!("https://o{i}{}", long(256 - 10)))
        .collect();
    let id = propose(&mut c, &a, Action::SetOrigins(origins), 200);
    c.approve(id, b.approve(&id, 0));
    assert_eq!(status(&c, &id), ProposalStatus::Executed);
}

#[test]
fn signer_count_bounded_at_init() {
    ctx(T0);
    let people: Vec<Person> = (1..=action::MAX_SIGNERS as u8 + 1)
        .map(|n| person(n, 1))
        .collect();
    let refs: Vec<&Person> = people.iter().collect();
    let msg = panics(|| {
        MerchantAccount::new(config(&refs, 1));
    });
    assert!(msg.contains("too many signers"), "{msg}");
    MerchantAccount::new(config(&refs[..action::MAX_SIGNERS], 1));
}

#[test]
fn pending_proposals_capped_per_signer() {
    let (mut c, a, b, cc) = three_of(2);
    let max = MAX_PENDING_PER_SIGNER;
    let ids: Vec<_> = (1..=max)
        .map(|n| propose(&mut c, &a, Action::SetThreshold(3), n))
        .collect();
    let msg = panics(|| {
        propose(&mut c, &a, Action::SetThreshold(3), max + 1);
    });
    assert!(msg.contains("too many pending proposals"), "{msg}");
    assert_eq!(c.list_proposals(0, 100).len(), usize::from(max));
    // The cap is per creator: B still has room.
    propose(&mut c, &b, Action::SetThreshold(3), 50);

    // Cancelling one of A's frees a slot, whoever cancels.
    c.cancel(ids[0], cc.cancel(&ids[0], 0));
    propose(&mut c, &a, Action::SetThreshold(3), max + 1);
    let msg = panics(|| {
        propose(&mut c, &a, Action::SetThreshold(3), max + 2);
    });
    assert!(msg.contains("too many pending proposals"), "{msg}");

    // Executing one frees a slot (it also bumps the epoch).
    c.approve(ids[1], b.approve(&ids[1], 0));
    assert_eq!(status(&c, &ids[1]), ProposalStatus::Executed);
    let p = propose(&mut c, &a, Action::SetThreshold(2), max + 2);

    // Expiry frees slots too, once marked by `execute` or `cancel`.
    ctx(T0 + PROPOSAL_TTL);
    let msg = panics(|| {
        propose(&mut c, &a, Action::SetThreshold(1), 1);
    });
    assert!(msg.contains("too many pending proposals"), "{msg}");
    c.execute(ids[2]);
    c.cancel(p, b.cancel(&p, 1));
    assert_eq!(status(&c, &ids[2]), ProposalStatus::Expired);
    assert_eq!(status(&c, &p), ProposalStatus::Expired);
    propose(&mut c, &a, Action::SetThreshold(1), 1);
    propose(&mut c, &a, Action::SetThreshold(1), 2);
    let msg = panics(|| {
        propose(&mut c, &a, Action::SetThreshold(1), 3);
    });
    assert!(msg.contains("too many pending proposals"), "{msg}");
}

#[test]
fn cancel_after_expiry_marks_expired() {
    let (mut c, a, b, _c) = three_of(2);
    let id = propose(&mut c, &a, Action::SetThreshold(3), 1);
    ctx(T0 + PROPOSAL_TTL);
    c.cancel(id, b.cancel(&id, 0));
    assert_eq!(status(&c, &id), ProposalStatus::Expired);
    let evs = events(&get_logs());
    let names: Vec<_> = evs.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(names, ["proposal_failed"]);
    assert_eq!(evs[0]["data"]["reason"], "expired");
    let msg = panics(|| c.cancel(id, b.cancel(&id, 0)));
    assert!(msg.contains("not pending"), "{msg}");
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64(bytes: &[u8]) -> String {
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

const DAY: u64 = 24 * HOUR;
const ADDR: &str = "0x91a1b2c3d4e5f60718293a4b5c6d7e8f90a1b244";

fn add_saved(id: &str) -> Action {
    Action::AddSavedAddress {
        id: id.into(),
        chain: "base".into(),
        address: ADDR.into(),
    }
}

fn wallet(id: &str) -> Action {
    Action::SetSettlement {
        dest_asset: "nep141:usdc.tendr.testnet".into(),
        payout_mode: PayoutMode::Wallet,
        saved_address_id: Some(id.into()),
    }
}

fn intents() -> Action {
    Action::SetSettlement {
        dest_asset: "nep141:usdc.tendr.testnet".into(),
        payout_mode: PayoutMode::Intents,
        saved_address_id: None,
    }
}

/// Proposes `action` as a 1-of-N account, so the proposer's approval executes it.
fn run(c: &mut MerchantAccount, by: &Person, action: Action, n: u8) -> ProposalId {
    let id = propose(c, by, action, n);
    assert_eq!(status(c, &id), ProposalStatus::Executed);
    id
}

#[test]
fn saved_address_unusable_for_24h() {
    let (mut c, a, _b, _c) = three_of(1);
    run(&mut c, &a, add_saved("sav_1"), 1);
    let listed = c.list_saved_addresses();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "sav_1");
    assert_eq!(listed[0].chain, "base");
    assert_eq!(listed[0].address, ADDR);
    assert_eq!(listed[0].active_from, U64(T0 + DAY));
    assert!(c.saved_address_usable("sav_1", T0 + DAY - 1).is_none());
    assert!(c.saved_address_usable("sav_1", T0 + DAY).is_some());
    assert!(c.saved_address_usable("nope", T0 + DAY).is_none());
}

#[test]
fn remove_saved_address_is_immediate() {
    let (mut c, a, _b, _c) = three_of(1);
    run(&mut c, &a, add_saved("sav_1"), 1);
    run(
        &mut c,
        &a,
        Action::RemoveSavedAddress { id: "sav_1".into() },
        2,
    );
    assert!(c.list_saved_addresses().is_empty());
    assert!(c.saved_address_usable("sav_1", T0 + 10 * DAY).is_none());
    let msg = panics(|| {
        propose(
            &mut c,
            &a,
            Action::RemoveSavedAddress { id: "sav_1".into() },
            3,
        );
    });
    assert!(msg.contains("unknown saved address"), "{msg}");
}

#[test]
fn duplicate_saved_address_id_rejected() {
    let (mut c, a, _b, _c) = three_of(1);
    run(&mut c, &a, add_saved("sav_1"), 1);
    let msg = panics(|| {
        propose(&mut c, &a, add_saved("sav_1"), 2);
    });
    assert!(msg.contains("duplicate saved address id"), "{msg}");
}

#[test]
fn saved_address_count_capped() {
    let (mut c, a, _b, _c) = three_of(1);
    for i in 0..saved::MAX_SAVED_ADDRESSES {
        ctx(T0); // resets the mock log, which is capped at 16 KiB
        let add = Action::AddSavedAddress {
            id: format!("sav_{i}"),
            chain: "base".into(),
            address: format!("0x{i:040x}"),
        };
        run(&mut c, &a, add, i as u8);
    }
    let msg = panics(|| {
        propose(&mut c, &a, add_saved("one_more"), 200);
    });
    assert!(msg.contains("too many saved addresses"), "{msg}");
}

#[test]
fn chain_and_address_validated() {
    let (mut c, a, _b, _c) = three_of(1);
    for (n, chain) in saved::SUPPORTED_CHAINS.iter().enumerate() {
        let action = Action::AddSavedAddress {
            id: format!("sav_{n}"),
            chain: chain.to_string(),
            address: ADDR.into(),
        };
        run(&mut c, &a, action, n as u8);
    }
    let bad = [
        ("doge", ADDR, "unsupported chain"),
        ("ETH", ADDR, "unsupported chain"),
        ("", ADDR, "chain must be 1 to 16"),
        ("base", "", "address must be 1 to 128"),
    ];
    for (n, (chain, address, expected)) in bad.into_iter().enumerate() {
        let action = Action::AddSavedAddress {
            id: format!("bad_{n}"),
            chain: chain.into(),
            address: address.into(),
        };
        let msg = panics(|| {
            propose(&mut c, &a, action, 100 + n as u8);
        });
        assert!(msg.contains(expected), "{chain:?}: {msg}");
    }
    // Exactly 128 characters is accepted, 129 is not.
    let at_limit = Action::AddSavedAddress {
        id: "long".into(),
        chain: "sol".into(),
        address: long(128),
    };
    run(&mut c, &a, at_limit, 150);
    let over = Action::AddSavedAddress {
        id: "toolong".into(),
        chain: "sol".into(),
        address: long(129),
    };
    let msg = panics(|| {
        propose(&mut c, &a, over, 151);
    });
    assert!(msg.contains("address must be 1 to 128"), "{msg}");
}

#[test]
fn settlement_wallet_mode_requires_usable_saved_address() {
    let (mut c, a, _b, _c) = three_of(1);
    assert_eq!(c.get_settlement(), None);
    // Unknown address.
    let msg = panics(|| {
        propose(&mut c, &a, wallet("sav_1"), 1);
    });
    assert!(msg.contains("unknown or not yet active"), "{msg}");
    // Known but still inside the 24h delay.
    run(&mut c, &a, add_saved("sav_1"), 2);
    ctx(T0 + DAY - 1);
    let msg = panics(|| {
        propose(&mut c, &a, wallet("sav_1"), 3);
    });
    assert!(msg.contains("unknown or not yet active"), "{msg}");
    // Wallet mode without an address is invalid.
    let no_addr = Action::SetSettlement {
        dest_asset: "nep141:usdc.tendr.testnet".into(),
        payout_mode: PayoutMode::Wallet,
        saved_address_id: None,
    };
    let msg = panics(|| {
        propose(&mut c, &a, no_addr, 4);
    });
    assert!(msg.contains("needs a saved address"), "{msg}");
    // Usable from t + 24h.
    ctx(T0 + DAY);
    let id = run(&mut c, &a, wallet("sav_1"), 5);
    assert_eq!(
        c.get_settlement(),
        Some(Settlement {
            dest_asset: "nep141:usdc.tendr.testnet".into(),
            payout_mode: PayoutMode::Wallet,
            saved_address_id: Some("sav_1".into()),
        })
    );
    let evs = events(&get_logs());
    let ev = evs
        .iter()
        .find(|e| e["event"] == "settlement_changed")
        .unwrap();
    assert_eq!(ev["data"]["proposal_id"], hex(&id.0));
    assert_eq!(ev["data"]["dest_asset"], "nep141:usdc.tendr.testnet");
    assert_eq!(ev["data"]["payout_mode"], "wallet");
    assert_eq!(ev["data"]["saved_address_id"], "sav_1");
}

#[test]
fn settlement_intents_mode_needs_no_saved_address() {
    let (mut c, a, _b, _c) = three_of(1);
    run(&mut c, &a, intents(), 1);
    assert_eq!(c.get_settlement().unwrap().payout_mode, PayoutMode::Intents);
    let with_addr = Action::SetSettlement {
        dest_asset: "nep141:usdc.tendr.testnet".into(),
        payout_mode: PayoutMode::Intents,
        saved_address_id: Some("sav_1".into()),
    };
    let msg = panics(|| {
        propose(&mut c, &a, with_addr, 2);
    });
    assert!(msg.contains("takes no saved address"), "{msg}");
}

#[test]
fn settlement_address_removed_before_execute_marks_failed() {
    let (mut c, a, b, _c) = three_of(2);
    let add = propose(&mut c, &a, add_saved("sav_1"), 1);
    c.approve(add, b.approve(&add, 0));
    ctx(T0 + DAY);
    // The removal executes first, so the settlement is stale at its last approval.
    let set = propose(&mut c, &a, wallet("sav_1"), 2);
    let rm = propose(
        &mut c,
        &a,
        Action::RemoveSavedAddress { id: "sav_1".into() },
        3,
    );
    c.approve(rm, b.approve(&rm, 0));
    assert_eq!(status(&c, &rm), ProposalStatus::Executed);
    c.approve(set, b.approve(&set, 0));
    assert_eq!(status(&c, &set), ProposalStatus::Failed);
    assert_eq!(c.get_settlement(), None);
}

#[test]
fn cannot_remove_address_current_settlement_points_to() {
    let (mut c, a, _b, _c) = three_of(1);
    run(&mut c, &a, add_saved("sav_1"), 1);
    ctx(T0 + DAY);
    run(&mut c, &a, wallet("sav_1"), 2);
    let msg = panics(|| {
        propose(
            &mut c,
            &a,
            Action::RemoveSavedAddress { id: "sav_1".into() },
            3,
        );
    });
    assert!(msg.contains("current settlement destination"), "{msg}");
    // Switching to intents mode releases it.
    run(&mut c, &a, intents(), 4);
    run(
        &mut c,
        &a,
        Action::RemoveSavedAddress { id: "sav_1".into() },
        5,
    );
    assert!(c.list_saved_addresses().is_empty());
}

/// `recovery_id(contract_id, recovery_key_epoch, nonce)` cases for the shared vectors, with the
/// Cancel-intent challenge a signer signs to cancel that recovery.
fn recovery_id_vectors(contract_id: &str) -> Vec<serde_json::Value> {
    [(0u64, 1u64), (1, 1), (2, 1_761_350_400_000)]
        .into_iter()
        .map(|(key_epoch, nonce)| {
            let id = ProposalId(crate::recovery::recovery_id(contract_id, key_epoch, nonce));
            let payload = ApprovalPayload::new(contract_id, &id, 3, ApprovalIntent::Cancel);
            serde_json::json!({
                "note": "recovery_id = sha256(borsh((\"tendr-merchant-account-recovery-id-v1\", contract_id, recovery_key_epoch u64, nonce u64))); a recovery cancel is a Cancel approval with proposal_id = recovery_id at the current signer epoch (3 here).",
                "contract_id": contract_id,
                "recovery_key_epoch": key_epoch.to_string(),
                "nonce": nonce.to_string(),
                "preimage_borsh_hex": hex(&near_sdk::borsh::to_vec(&(
                    crate::recovery::RECOVERY_ID_DOMAIN.to_string(),
                    contract_id.to_string(),
                    key_epoch,
                    nonce,
                )).unwrap()),
                "recovery_id_hex": hex(&id.0),
                "cancel_challenge_hex": hex(&payload.challenge()),
            })
        })
        .collect()
}

/// Writes (with `UPDATE_VECTORS=1`) or checks the shared Rust/TypeScript
/// approval-encoding vectors.
#[test]
fn write_test_vectors() {
    ctx(T0);
    let contract_id = "mystore.tendr.testnet";
    let salt_bytes: [u8; 32] = core::array::from_fn(|i| i as u8);
    let signer_epoch = 3u64;
    let route_poa = WithdrawRoute::Poa {
        token_contract: "usdc.tendr.testnet".parse().unwrap(),
    };
    let actions = [
        (
            "withdraw",
            Action::Withdraw {
                asset: "nep141:usdc.tendr.testnet".into(),
                amount: U128(1_200_000_000),
                saved_address_id: "sav_01JBZ8Y0000000000000000001".into(),
                route: route_poa,
            },
        ),
        (
            "add_signer",
            Action::AddSigner(Signer {
                id: person_id(7),
                keys: vec![
                    p256_signer(&p256_key(1)),
                    SignerKey::Ed25519(ed25519_key(2).verifying_key().to_bytes()),
                ],
            }),
        ),
        (
            "refund",
            Action::Refund {
                asset: "nep141:usdc.tendr.testnet".into(),
                amount: U128(25_000_000),
                destination_chain: "base".into(),
                destination: "0x91a1b2c3d4e5f60718293a4b5c6d7e8f90a1b244".into(),
                payment_id: "pay_01JBZ8Y0000000000000000001".into(),
                route: WithdrawRoute::Swap {
                    deposit_account: "deposit-1.oneclick.testnet".parse().unwrap(),
                },
            },
        ),
    ];

    let cases: Vec<serde_json::Value> = actions
        .iter()
        .map(|(name, action)| {
            let id = ProposalId::new(action, &salt_bytes);
            let approvals: Vec<serde_json::Value> = [
                ("approve", ApprovalIntent::Approve),
                ("cancel", ApprovalIntent::Cancel),
            ]
            .into_iter()
            .map(|(intent_name, intent)| {
                let payload = ApprovalPayload::new(contract_id, &id, signer_epoch, intent);
                let challenge = payload.challenge();
                serde_json::json!({
                    "intent": intent_name,
                    "payload_borsh_hex": hex(&near_sdk::borsh::to_vec(&payload).unwrap()),
                    "challenge_hex": hex(&challenge),
                    "challenge_b64url": URL_SAFE_NO_PAD.encode(challenge),
                })
            })
            .collect();
            serde_json::json!({
                "name": name,
                "action": action,
                "action_borsh_hex": hex(&near_sdk::borsh::to_vec(action).unwrap()),
                "proposal_id_hex": hex(&id.0),
                "approvals": approvals,
            })
        })
        .collect();

    let doc = serde_json::json!({
        "note": "Generated by `UPDATE_VECTORS=1 cargo test -p merchant-account write_test_vectors`. Byte fields inside `action` and `salt_b64` are standard padded base64 (RFC 4648 §4), not base64url. *_hex fields are lowercase hex. proposal_id = sha256(borsh(action) || salt). The WebAuthn challenge is sha256(borsh(ApprovalPayload)); clientDataJSON.challenge is base64url without padding of that hash (challenge_b64url). The TypeScript encoder (apps/api encoding.ts) must reproduce every field byte for byte.",
        "domain": approval::APPROVAL_DOMAIN,
        "contract_id": contract_id,
        "salt_b64": b64(&salt_bytes),
        "signer_epoch": signer_epoch.to_string(),
        "cases": cases,
        "recovery_ids": recovery_id_vectors(contract_id),
    });
    let rendered = format!("{}\n", serde_json::to_string_pretty(&doc).unwrap());

    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/test-vectors/approval-payloads.json"
    );
    if std::env::var("UPDATE_VECTORS").as_deref() == Ok("1") {
        std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
        std::fs::write(path, &rendered).unwrap();
    }
    let committed = std::fs::read_to_string(path)
        .expect("test-vectors/approval-payloads.json missing; run with UPDATE_VECTORS=1");
    assert_eq!(
        committed, rendered,
        "approval vectors changed; regenerate with UPDATE_VECTORS=1 and update the TypeScript encoder"
    );
}

mod money;
#[cfg(feature = "probe")]
mod probe;
mod recovery;
