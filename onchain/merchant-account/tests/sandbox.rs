//! Sandbox integration tests: the merchant-account contract, published as a
//! global contract, against the `mock-intents` verifier on a local nearcore
//! sandbox (near-workspaces).
//!
//! Needs the Wasm builds first: `onchain/scripts/build.sh` (default build of
//! both crates) and `onchain/scripts/build.sh --features testnet-admin
//! merchant-account` (the upgrade target). Then `cargo test --test sandbox`.
//!
//! Time: every delay the contract enforces is 24 h. The sandbox is started
//! with `max_block_production_delay = 100 s`; nearcore's `sandbox_fast_forward`
//! stamps each skipped block with the average of the min and max block
//! production delays (~50 s here), so 24 h is ~1 730 skipped blocks and takes
//! well under a second. Normal block production is unchanged (blocks still
//! come every `min_block_production_delay`), and so are the contract's
//! constants. The epoch length is raised so a fast-forward never crosses
//! epochs, which is the slow part of a fast-forward.

use std::path::PathBuf;
use std::sync::Arc;

use near_jsonrpc_client::{methods, JsonRpcClient};
use near_primitives::action::{
    Action as TxAction, CreateAccountAction, DeployGlobalContractAction, FunctionCallAction,
    GlobalContractDeployMode, GlobalContractIdentifier, TransferAction, UseGlobalContractAction,
};
use near_primitives::transaction::{SignedTransaction, Transaction, TransactionV0};
use near_primitives::views::{ActionView, FinalExecutionStatus};
use near_sdk::base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use near_sdk::json_types::U128;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, ContractState, Worker};
use p256::ecdsa::signature::hazmat::PrehashSigner;
use serde_json::{json, Value};

use merchant_account::action::{Action, Signer, WithdrawRoute};
use merchant_account::approval::{
    ApprovalIntent, ApprovalPayload, ProposalId, Salt, SignedApproval,
};
use merchant_account::money::{AutoSweepView, LimitsView};
use merchant_account::webauthn::{Assertion, SignerKey};
use merchant_account::{ConfigView, InitConfig, ProposalStatus, ProposalView};

const HOUR_S: u64 = 3_600;
/// The contract's 24 h delays plus a margin for the blocks that follow.
const DAY_AND_A_BIT_S: u64 = 24 * HOUR_S + 600;
const RP_ID: &str = "localhost";
const ORIGIN: &str = "http://localhost:3000";
/// Account suffix of PoA bridge tokens in these tests.
const POA_SUFFIX: &str = "omft.test.near";
/// A PoA bridge token for the `eth` chain under [`POA_SUFFIX`].
const ETH_TOKEN: &str = "eth.omft.test.near";
const ETH_ASSET: &str = "nep141:eth.omft.test.near";
const ETH_ADDRESS: &str = "0x1111111111111111111111111111111111111111";

// ---------------------------------------------------------------------------
// Signers (WebAuthn P-256 fixtures, as in the unit tests)
// ---------------------------------------------------------------------------

struct Person {
    id: String,
    key: p256::ecdsa::SigningKey,
}

fn person(n: u8) -> Person {
    Person {
        id: format!("per_01JBZ8Y{n:019}"),
        key: p256::ecdsa::SigningKey::from_bytes(&[n * 10 + 1; 32].into()).unwrap(),
    }
}

impl Person {
    fn signer_key(&self) -> SignerKey {
        let point = self.key.verifying_key().to_encoded_point(true);
        SignerKey::P256(point.as_bytes().try_into().unwrap())
    }

    fn signer(&self) -> Signer {
        Signer {
            id: self.id.clone(),
            keys: vec![self.signer_key()],
        }
    }

    /// A WebAuthn assertion (RP ID `localhost`, origin `http://localhost:3000`,
    /// UP|UV) over the approval payload for `contract`.
    fn sign(
        &self,
        contract: &AccountId,
        id: &ProposalId,
        epoch: u64,
        intent: ApprovalIntent,
    ) -> SignedApproval {
        let challenge = ApprovalPayload::new(contract.as_str(), id, epoch, intent).challenge();
        let mut authenticator_data = near_sdk::env::sha256_array(RP_ID.as_bytes()).to_vec();
        authenticator_data.push(0x05); // UP | UV
        authenticator_data.extend_from_slice(&[0, 0, 0, 1]);
        let client_data_json = format!(
            r#"{{"type":"webauthn.get","challenge":"{}","origin":"{ORIGIN}","crossOrigin":false}}"#,
            URL_SAFE_NO_PAD.encode(challenge)
        );
        let mut msg = authenticator_data.clone();
        msg.extend_from_slice(&near_sdk::env::sha256_array(client_data_json.as_bytes()));
        let prehash = near_sdk::env::sha256_array(&msg);
        let sig: p256::ecdsa::Signature = self.key.sign_prehash(&prehash).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig);
        SignedApproval {
            signer_id: self.id.clone(),
            key: self.signer_key(),
            assertion: Assertion {
                authenticator_data,
                client_data_json,
                signature: sig.to_bytes().to_vec(),
            },
        }
    }
}

fn salt(n: u8) -> Salt {
    Salt([n; 32])
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

fn wasm(file: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/near")
        .join(file);
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. Build the contracts first: onchain/scripts/build.sh && \
             onchain/scripts/build.sh --features testnet-admin merchant-account",
            path.display()
        )
    })
}

fn merchant_wasm() -> Vec<u8> {
    wasm("merchant-account/merchant-account.wasm")
}

fn merchant_admin_wasm() -> Vec<u8> {
    wasm("merchant-account/merchant-account-testnet-admin.wasm")
}

fn mock_wasm() -> Vec<u8> {
    wasm("mock-intents/mock-intents.wasm")
}

struct Env {
    // Field order matters: the worker must drop before the sandbox process.
    worker: Worker<Sandbox>,
    _sandbox: near_sandbox::Sandbox,
    rpc: JsonRpcClient,
    root: Account,
    mock: AccountId,
    shop: AccountId,
    relayer: Account,
    stranger: Account,
    a: Person,
    b: Person,
    code_hash: [u8; 32],
}

async fn start_sandbox() -> anyhow::Result<(Worker<Sandbox>, near_sandbox::Sandbox)> {
    let config = near_sandbox::SandboxConfig {
        additional_config: Some(json!({
            "consensus": { "max_block_production_delay": { "secs": 100, "nanos": 0 } }
        })),
        additional_genesis: Some(json!({ "epoch_length": 1_000_000 })),
        ..Default::default()
    };
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_config(config).await?;
    let worker = near_workspaces::sandbox()
        .rpc_addr(&sandbox.rpc_addr)
        .validator_key(ValidatorKey::HomeDir(sandbox.home_dir.path().to_path_buf()))
        .await?;
    Ok((worker, sandbox))
}

/// Signs `actions` from `from` to `receiver` with `from`'s key and waits for
/// the whole receipt tree.
async fn raw_tx(
    env_worker: &Worker<Sandbox>,
    rpc: &JsonRpcClient,
    from: &Account,
    receiver: &AccountId,
    actions: Vec<TxAction>,
) -> anyhow::Result<near_primitives::views::FinalExecutionOutcomeView> {
    let secret: near_crypto::SecretKey = from.secret_key().to_string().parse()?;
    let public_key = secret.public_key();
    let signer = near_crypto::InMemorySigner::from_secret_key(from.id().clone(), secret);
    let nonce = env_worker
        .view_access_key(from.id(), &from.secret_key().public_key())
        .await?
        .nonce;
    let block_hash = near_primitives::hash::CryptoHash(env_worker.view_block().await?.hash().0);
    let tx = Transaction::V0(TransactionV0 {
        signer_id: from.id().clone(),
        public_key,
        nonce: nonce + 1,
        receiver_id: receiver.clone(),
        block_hash,
        actions,
    });
    let signature = signer.sign(tx.get_hash_and_size().0.as_ref());
    let outcome = rpc
        .call(methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest {
            signed_transaction: SignedTransaction::new(signature, tx),
        })
        .await?;
    Ok(outcome)
}

fn assert_tx_ok(outcome: &near_primitives::views::FinalExecutionOutcomeView) {
    assert!(
        matches!(outcome.status, FinalExecutionStatus::SuccessValue(_)),
        "transaction failed: {:?}",
        outcome.status
    );
    for r in &outcome.receipts_outcome {
        assert!(
            !matches!(
                r.outcome.status,
                near_primitives::views::ExecutionStatusView::Failure(_)
            ),
            "receipt failed: {:?}",
            r.outcome.status
        );
    }
}

/// Publishes `code` as a global contract under its hash; returns the hash.
async fn publish_global(
    worker: &Worker<Sandbox>,
    rpc: &JsonRpcClient,
    root: &Account,
    code: Vec<u8>,
) -> anyhow::Result<[u8; 32]> {
    let hash = near_primitives::hash::hash(&code).0;
    let outcome = raw_tx(
        worker,
        rpc,
        root,
        root.id(),
        vec![TxAction::DeployGlobalContract(DeployGlobalContractAction {
            code: Arc::from(code),
            deploy_mode: GlobalContractDeployMode::CodeHash,
        })],
    )
    .await?;
    assert_tx_ok(&outcome);
    Ok(hash)
}

/// Creates `shop.test.near` the way the API provisions a merchant: one batch
/// from the parent with CreateAccount + Transfer + UseGlobalContract +
/// FunctionCall `new`, and no AddKey.
async fn provision(
    worker: &Worker<Sandbox>,
    rpc: &JsonRpcClient,
    root: &Account,
    shop: &AccountId,
    code_hash: [u8; 32],
    config: &InitConfig,
) -> anyhow::Result<near_primitives::views::FinalExecutionOutcomeView> {
    let actions = vec![
        TxAction::CreateAccount(CreateAccountAction {}),
        TxAction::Transfer(TransferAction {
            deposit: NearToken::from_near(5),
        }),
        TxAction::UseGlobalContract(Box::new(UseGlobalContractAction {
            contract_identifier: GlobalContractIdentifier::CodeHash(
                near_primitives::hash::CryptoHash(code_hash),
            ),
        })),
        TxAction::FunctionCall(Box::new(FunctionCallAction {
            method_name: "new".to_string(),
            args: serde_json::to_vec(&json!({ "config": config }))?,
            gas: near_primitives::gas::Gas::from_teragas(100),
            deposit: NearToken::from_yoctonear(0),
        })),
    ];
    raw_tx(worker, rpc, root, shop, actions).await
}

async fn setup() -> anyhow::Result<Env> {
    let (worker, sandbox) = start_sandbox().await?;
    let rpc = JsonRpcClient::connect(worker.rpc_addr());
    let root = worker.root_account()?;

    let mock = root
        .create_subaccount("intents-mock")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    mock.deploy(&mock_wasm()).await?.into_result()?;

    let relayer = root
        .create_subaccount("relayer")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?;
    let stranger = root
        .create_subaccount("stranger")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?;

    let code_hash = publish_global(&worker, &rpc, &root, merchant_wasm()).await?;

    let (a, b) = (person(1), person(2));
    let shop: AccountId = format!("shop.{}", root.id()).parse()?;
    let config = InitConfig {
        signers: vec![a.signer(), b.signer()],
        threshold: 2,
        recovery_key: None,
        rp_id: RP_ID.to_string(),
        origins: vec![ORIGIN.to_string()],
        intents_contract: mock.id().clone(),
        poa_suffix: Some(POA_SUFFIX.to_string()),
        testnet_admin: None,
    };
    let outcome = provision(&worker, &rpc, &root, &shop, code_hash, &config).await?;
    assert_tx_ok(&outcome);
    let kinds: Vec<&str> = outcome
        .transaction
        .actions
        .iter()
        .map(|a| match a {
            ActionView::CreateAccount => "CreateAccount",
            ActionView::Transfer { .. } => "Transfer",
            ActionView::UseGlobalContract { .. } => "UseGlobalContract",
            ActionView::FunctionCall { .. } => "FunctionCall",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "CreateAccount",
            "Transfer",
            "UseGlobalContract",
            "FunctionCall"
        ]
    );

    Ok(Env {
        mock: mock.id().clone(),
        worker,
        _sandbox: sandbox,
        rpc,
        root,
        shop,
        relayer,
        stranger,
        a,
        b,
        code_hash,
    })
}

impl Env {
    async fn view<T: near_sdk::serde::de::DeserializeOwned>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> anyhow::Result<T> {
        Ok(self
            .worker
            .view(contract, method)
            .args_json(args)
            .await?
            .json()?)
    }

    async fn config(&self) -> anyhow::Result<ConfigView> {
        self.view(&self.shop, "get_config", json!({})).await
    }

    async fn epoch(&self) -> anyhow::Result<u64> {
        Ok(self.config().await?.signer_epoch.0)
    }

    async fn proposal(&self, id: &ProposalId) -> anyhow::Result<ProposalView> {
        let p: Option<ProposalView> = self
            .view(&self.shop, "get_proposal", json!({ "id": id }))
            .await?;
        Ok(p.expect("proposal exists"))
    }

    async fn limits(&self, asset: &str) -> anyhow::Result<LimitsView> {
        self.view(&self.shop, "get_limits", json!({ "asset": asset }))
            .await
    }

    async fn calls(&self) -> anyhow::Result<Vec<Value>> {
        self.view(&self.mock, "get_calls", json!({})).await
    }

    async fn balance(&self, token: &str) -> anyhow::Result<u128> {
        let b: U128 = self
            .view(
                &self.mock,
                "mt_balance_of",
                json!({ "account_id": self.shop, "token_id": token }),
            )
            .await?;
        Ok(b.0)
    }

    /// `from` calls `method` on the shop with max gas.
    async fn call_shop(
        &self,
        from: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(&self.shop, method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    async fn mock_call(&self, method: &str, args: Value) -> anyhow::Result<()> {
        self.stranger
            .call(&self.mock, method)
            .args_json(args)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn deposit(&self, token: &str, amount: u128) -> anyhow::Result<()> {
        self.mock_call(
            "deposit",
            json!({ "account_id": self.shop, "token_id": token, "amount": U128(amount) }),
        )
        .await
    }

    /// The relayer submits `by`'s proposal of `action` (salt `n`).
    async fn propose(&self, by: &Person, action: &Action, n: u8) -> anyhow::Result<ProposalId> {
        let id = ProposalId::new(action, &salt(n).0);
        let approval = by.sign(
            &self.shop,
            &id,
            self.epoch().await?,
            ApprovalIntent::Approve,
        );
        let res = self
            .call_shop(
                &self.relayer,
                "propose",
                json!({ "action": action, "salt": salt(n), "approval": approval }),
            )
            .await?;
        let returned: ProposalId = res.into_result()?.json()?;
        assert_eq!(returned, id);
        Ok(id)
    }

    /// The relayer submits `by`'s approval of `id`.
    async fn approve(&self, by: &Person, id: &ProposalId) -> anyhow::Result<()> {
        let approval = by.sign(&self.shop, id, self.epoch().await?, ApprovalIntent::Approve);
        self.call_shop(
            &self.relayer,
            "approve",
            json!({ "proposal_id": id, "approval": approval }),
        )
        .await?
        .into_result()?;
        Ok(())
    }

    /// Proposes with A and approves with B (2-of-2).
    async fn pass(&self, action: &Action, n: u8) -> anyhow::Result<ProposalId> {
        let id = self.propose(&self.a, action, n).await?;
        self.approve(&self.b, &id).await?;
        Ok(id)
    }

    async fn now_ns(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Advances the chain clock by at least `secs` seconds.
    async fn advance(&self, secs: u64) -> anyhow::Result<()> {
        let target = self.now_ns().await? + secs * 1_000_000_000;
        while self.now_ns().await? < target {
            self.worker.fast_forward(200).await?;
        }
        Ok(())
    }

    /// Adds saved address `id` (2-of-2) and waits until it is active.
    async fn add_active_saved_address(
        &self,
        id: &str,
        chain: &str,
        address: &str,
        n: u8,
    ) -> anyhow::Result<()> {
        let pid = self
            .pass(
                &Action::AddSavedAddress {
                    id: id.to_string(),
                    chain: chain.to_string(),
                    address: address.to_string(),
                },
                n,
            )
            .await?;
        assert_eq!(self.proposal(&pid).await?.status, ProposalStatus::Executed);
        self.advance(DAY_AND_A_BIT_S).await
    }
}

fn eth_withdraw(amount: u128, saved_address_id: &str) -> Action {
    Action::Withdraw {
        asset: ETH_ASSET.to_string(),
        amount: U128(amount),
        saved_address_id: saved_address_id.to_string(),
        route: WithdrawRoute::Poa {
            token_contract: ETH_TOKEN.parse().unwrap(),
        },
    }
}

fn failure_text(res: ExecutionFinalResult) -> String {
    match res.into_result() {
        Ok(_) => panic!("expected the call to fail"),
        Err(e) => format!("{e:?}"),
    }
}

fn args(call: &Value) -> Value {
    serde_json::from_str(call["args"].as_str().unwrap()).unwrap()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn account_has_no_access_keys() -> anyhow::Result<()> {
    let env = setup().await?;
    let keys = env.worker.view_access_keys(&env.shop).await?;
    assert!(keys.is_empty(), "shop has access keys: {keys:?}");

    // It runs the published global contract and was initialized in the batch.
    let account = env.worker.view_account(&env.shop).await?;
    assert_eq!(
        account.contract_state,
        ContractState::GlobalHash(near_workspaces::types::CryptoHash(env.code_hash))
    );
    let cfg = env.config().await?;
    assert_eq!(cfg.signers, vec![env.a.signer(), env.b.signer()]);
    assert_eq!(cfg.threshold, 2);
    assert_eq!(cfg.intents_contract, env.mock);
    assert_eq!(cfg.rp_id, RP_ID);
    Ok(())
}

#[tokio::test]
async fn withdraw_end_to_end() -> anyhow::Result<()> {
    let env = setup().await?;
    env.deposit(ETH_ASSET, 1_000).await?;
    env.add_active_saved_address("sa_1", "eth", ETH_ADDRESS, 1)
        .await?;

    let id = env.pass(&eth_withdraw(400, "sa_1"), 2).await?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);

    let calls = env.calls().await?;
    assert_eq!(calls.len(), 1, "{calls:?}");
    let call = &calls[0];
    assert_eq!(call["method"], "ft_withdraw");
    assert_eq!(call["predecessor"], env.shop.as_str());
    assert_eq!(call["attached_deposit"], "1");
    let a = args(call);
    assert_eq!(a["token"], ETH_TOKEN);
    assert_eq!(a["receiver_id"], ETH_TOKEN);
    assert_eq!(a["amount"], "400");
    assert_eq!(a["memo"], format!("WITHDRAW_TO:{ETH_ADDRESS}"));

    assert_eq!(env.balance(ETH_ASSET).await?, 600);
    assert_eq!(env.limits(ETH_ASSET).await?.spent_24h, U128(400));
    Ok(())
}

#[tokio::test]
async fn relayer_cannot_alter_action() -> anyhow::Result<()> {
    let env = setup().await?;
    env.deposit(ETH_ASSET, 1_000).await?;
    env.add_active_saved_address("sa_1", "eth", ETH_ADDRESS, 1)
        .await?;
    let epoch = env.epoch().await?;

    // A signs a 100-unit withdrawal; the relayer swaps the amount for 900.
    let honest = eth_withdraw(100, "sa_1");
    let honest_id = ProposalId::new(&honest, &salt(2).0);
    let a_approval = env
        .a
        .sign(&env.shop, &honest_id, epoch, ApprovalIntent::Approve);
    let mutated = eth_withdraw(900, "sa_1");
    let res = env
        .call_shop(
            &env.relayer,
            "propose",
            json!({ "action": mutated, "salt": salt(2), "approval": a_approval }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("challenge mismatch"), "{err}");
    let mutated_id = ProposalId::new(&mutated, &salt(2).0);
    let none: Option<ProposalView> = env
        .view(&env.shop, "get_proposal", json!({ "id": mutated_id }))
        .await?;
    assert!(none.is_none());

    // The honest proposal goes through; a second, unrelated proposal exists.
    let id = env.propose(&env.a, &honest, 2).await?;
    let other = env.propose(&env.a, &Action::SetThreshold(1), 3).await?;

    // B's approval of the withdrawal, submitted against the other proposal.
    let b_approval = env.b.sign(&env.shop, &id, epoch, ApprovalIntent::Approve);
    let res = env
        .call_shop(
            &env.relayer,
            "approve",
            json!({ "proposal_id": other, "approval": b_approval }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("challenge mismatch"), "{err}");
    assert_eq!(env.proposal(&other).await?.valid_approvals, 1);
    assert_eq!(env.config().await?.threshold, 2);

    // And against the mutated action's id, which names no proposal.
    let res = env
        .call_shop(
            &env.relayer,
            "approve",
            json!({ "proposal_id": mutated_id, "approval": b_approval }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("unknown proposal"), "{err}");

    // Nothing has moved yet.
    assert!(env.calls().await?.is_empty());
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Pending);

    // Delivered as signed, the approval executes the original amount.
    env.call_shop(
        &env.relayer,
        "approve",
        json!({ "proposal_id": id, "approval": b_approval }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);
    let calls = env.calls().await?;
    assert_eq!(calls.len(), 1);
    assert_eq!(args(&calls[0])["amount"], "100");
    assert_eq!(env.balance(ETH_ASSET).await?, 900);
    Ok(())
}

#[tokio::test]
async fn default_build_has_no_admin_method() -> anyhow::Result<()> {
    let env = setup().await?;
    let res = env
        .call_shop(
            &env.root,
            "admin_sync_signers",
            json!({ "signers": [env.a.signer()], "threshold": 1 }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("MethodNotFound"), "{err}");
    assert_eq!(env.config().await?.signers.len(), 2);
    Ok(())
}

/// The `probe` feature adds `probe_p256` for the mainnet check script. The
/// build that is published and deployed must not export it.
#[tokio::test]
async fn default_build_has_no_probe_method() -> anyhow::Result<()> {
    let env = setup().await?;
    let res = env
        .call_shop(
            &env.root,
            "probe_p256",
            json!({ "signature": "", "prehash": "", "public_key": "" }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("MethodNotFound"), "{err}");
    // The Wasm itself, not just the sandbox call: the name must not appear.
    for (name, code) in [
        ("default", merchant_wasm()),
        ("testnet-admin", merchant_admin_wasm()),
    ] {
        assert!(
            !code.windows(10).any(|w| w == b"probe_p256"),
            "{name} build exports probe_p256"
        );
    }
    Ok(())
}

#[tokio::test]
async fn upgrade_via_proposal_switches_code_hash() -> anyhow::Result<()> {
    let env = setup().await?;
    let new_hash = publish_global(&env.worker, &env.rpc, &env.root, merchant_admin_wasm()).await?;
    assert_ne!(new_hash, env.code_hash);

    let id = env
        .pass(
            &Action::Upgrade {
                code_hash: new_hash,
            },
            1,
        )
        .await?;
    // Upgrades are timelocked.
    let p = env.proposal(&id).await?;
    assert_eq!(p.status, ProposalStatus::Pending);
    let ready_at = p.ready_at.expect("timelock started").0;
    let res = env
        .call_shop(&env.relayer, "execute", json!({ "proposal_id": id }))
        .await?;
    let err = failure_text(res);
    assert!(err.contains("proposal is timelocked"), "{err}");
    assert!(ready_at > env.now_ns().await?);

    env.advance(DAY_AND_A_BIT_S).await?;
    env.call_shop(&env.relayer, "execute", json!({ "proposal_id": id }))
        .await?
        .into_result()?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);

    let account = env.worker.view_account(&env.shop).await?;
    assert_eq!(
        account.contract_state,
        ContractState::GlobalHash(near_workspaces::types::CryptoHash(new_hash))
    );
    // State survived the switch.
    let cfg = env.config().await?;
    assert_eq!(cfg.signers, vec![env.a.signer(), env.b.signer()]);
    // The new code is live: the testnet-admin method now exists (and refuses
    // anyone but the configured admin, of which there is none).
    let res = env
        .call_shop(
            &env.relayer,
            "admin_sync_signers",
            json!({ "signers": [env.a.signer()], "threshold": 1 }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("only the testnet admin"), "{err}");
    assert!(env.worker.view_access_keys(&env.shop).await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn callbacks_are_private() -> anyhow::Result<()> {
    let env = setup().await?;
    let pid = ProposalId([7; 32]);
    let cases = [
        ("on_transfer_done", json!({ "proposal_id": pid })),
        ("on_sweep_balance", json!({ "asset": ETH_ASSET })),
        (
            "on_sweep_done",
            json!({ "asset": ETH_ASSET, "amount": "1", "saved_address_id": "sa_1" }),
        ),
        ("on_upgrade_done", json!({ "proposal_id": pid })),
        ("migrate", json!({})),
    ];
    for (method, args) in cases {
        let res = env.call_shop(&env.stranger, method, args).await?;
        let err = failure_text(res);
        assert!(
            err.contains(&format!("Method {method} is private")),
            "{method}: {err}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn failed_transfer_marks_proposal_failed_and_releases_reservation() -> anyhow::Result<()> {
    let env = setup().await?;
    env.deposit(ETH_ASSET, 1_000).await?;
    env.add_active_saved_address("sa_1", "eth", ETH_ADDRESS, 1)
        .await?;
    env.mock_call("set_fail_next", json!({ "fail": true }))
        .await?;

    let id = env.pass(&eth_withdraw(400, "sa_1"), 2).await?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Failed);

    // The verifier was asked, but nothing moved.
    let calls = env.calls().await?;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["method"], "ft_withdraw");
    assert_eq!(env.balance(ETH_ASSET).await?, 1_000);
    let limits = env.limits(ETH_ASSET).await?;
    assert_eq!(limits.spent_24h, U128(0));
    assert_eq!(limits.refunded_24h, U128(0));

    // The released reservation does not block a later withdrawal.
    let id2 = env.pass(&eth_withdraw(400, "sa_1"), 3).await?;
    assert_eq!(env.proposal(&id2).await?.status, ProposalStatus::Executed);
    assert_eq!(env.balance(ETH_ASSET).await?, 600);
    assert_eq!(env.limits(ETH_ASSET).await?.spent_24h, U128(400));
    Ok(())
}

#[tokio::test]
async fn sweep_end_to_end() -> anyhow::Result<()> {
    let env = setup().await?;
    let pid = env
        .pass(
            &Action::AddSavedAddress {
                id: "sa_1".to_string(),
                chain: "eth".to_string(),
                address: ETH_ADDRESS.to_string(),
            },
            1,
        )
        .await?;
    assert_eq!(env.proposal(&pid).await?.status, ProposalStatus::Executed);
    let rule = Action::SetAutoSweep {
        asset: ETH_ASSET.to_string(),
        trigger_above: U128(1_000),
        keep: U128(100),
        saved_address_id: "sa_1".to_string(),
    };
    let pid = env.pass(&rule, 2).await?;
    assert_eq!(env.proposal(&pid).await?.status, ProposalStatus::Executed);

    // Before the saved address is active, nobody can trigger it.
    env.deposit(ETH_ASSET, 5_000).await?;
    let res = env
        .call_shop(
            &env.stranger,
            "trigger_sweep",
            json!({ "asset": ETH_ASSET }),
        )
        .await?;
    let err = failure_text(res);
    assert!(err.contains("not yet active"), "{err}");

    env.advance(DAY_AND_A_BIT_S).await?;

    // Two unrelated accounts trigger at the same time.
    let (first, second) = tokio::join!(
        env.call_shop(
            &env.stranger,
            "trigger_sweep",
            json!({ "asset": ETH_ASSET })
        ),
        env.call_shop(&env.relayer, "trigger_sweep", json!({ "asset": ETH_ASSET })),
    );
    let outcomes = [first?, second?];
    let refused = outcomes
        .iter()
        .filter(|r| format!("{r:?}").contains("sweep already in flight"))
        .count();
    assert!(
        outcomes.iter().filter(|r| r.is_success()).count() + refused == 2,
        "unexpected outcome: {outcomes:?}"
    );

    // Exactly one transfer of balance - keep, to the saved destination.
    let calls = env.calls().await?;
    let sweeps: Vec<_> = calls
        .iter()
        .filter(|c| c["method"] == "ft_withdraw")
        .collect();
    assert_eq!(sweeps.len(), 1, "{calls:?}");
    assert_eq!(sweeps[0]["predecessor"], env.shop.as_str());
    assert_eq!(sweeps[0]["attached_deposit"], "1");
    let a = args(sweeps[0]);
    assert_eq!(a["token"], ETH_TOKEN);
    assert_eq!(a["receiver_id"], ETH_TOKEN);
    assert_eq!(a["amount"], "4900");
    assert_eq!(a["memo"], format!("WITHDRAW_TO:{ETH_ADDRESS}"));
    assert_eq!(env.balance(ETH_ASSET).await?, 100);

    let view: Option<AutoSweepView> = env
        .view(&env.shop, "get_auto_sweep", json!({ "asset": ETH_ASSET }))
        .await?;
    assert!(!view.expect("rule set").in_flight);

    // At or below the trigger, a sweep is a no-op.
    env.call_shop(
        &env.stranger,
        "trigger_sweep",
        json!({ "asset": ETH_ASSET }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.calls().await?.len(), calls.len());
    assert_eq!(env.balance(ETH_ASSET).await?, 100);
    Ok(())
}

#[tokio::test]
async fn near_chain_withdraw_has_no_memo() -> anyhow::Result<()> {
    let env = setup().await?;
    let asset = "nep141:usdc.test.near";
    env.deposit(asset, 1_000).await?;
    env.add_active_saved_address("sa_wallet", "near", "merchant-wallet.test.near", 1)
        .await?;

    let action = Action::Withdraw {
        asset: asset.to_string(),
        amount: U128(250),
        saved_address_id: "sa_wallet".to_string(),
        route: WithdrawRoute::Poa {
            token_contract: "usdc.test.near".parse().unwrap(),
        },
    };
    let id = env.pass(&action, 2).await?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);

    let calls = env.calls().await?;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["method"], "ft_withdraw");
    assert_eq!(calls[0]["predecessor"], env.shop.as_str());
    assert_eq!(calls[0]["attached_deposit"], "1");
    let a = args(&calls[0]);
    assert_eq!(a["token"], "usdc.test.near");
    assert_eq!(a["receiver_id"], "merchant-wallet.test.near");
    assert_eq!(a["amount"], "250");
    assert!(a["memo"].is_null(), "memo: {}", a["memo"]);
    assert_eq!(env.balance(asset).await?, 750);
    Ok(())
}

#[tokio::test]
async fn add_signer_waits_for_timelock_and_can_be_cancelled() -> anyhow::Result<()> {
    let env = setup().await?;
    let add = Action::AddSigner(person(3).signer());

    // A cancelled AddSigner never applies.
    let cancelled = env.pass(&add, 1).await?;
    let p = env.proposal(&cancelled).await?;
    assert_eq!(p.status, ProposalStatus::Pending);
    assert!(p.ready_at.is_some(), "timelock started");
    let cancel = env.a.sign(
        &env.shop,
        &cancelled,
        env.epoch().await?,
        ApprovalIntent::Cancel,
    );
    env.call_shop(
        &env.relayer,
        "cancel",
        json!({ "proposal_id": cancelled, "approval": cancel }),
    )
    .await?
    .into_result()?;
    assert_eq!(
        env.proposal(&cancelled).await?.status,
        ProposalStatus::Cancelled
    );

    // An uncancelled one applies only after 24 h.
    let id = env.pass(&add, 2).await?;
    let res = env
        .call_shop(&env.relayer, "execute", json!({ "proposal_id": id }))
        .await?;
    let err = failure_text(res);
    assert!(err.contains("proposal is timelocked"), "{err}");
    assert_eq!(env.config().await?.signers.len(), 2);

    env.advance(DAY_AND_A_BIT_S).await?;
    env.call_shop(&env.relayer, "execute", json!({ "proposal_id": id }))
        .await?
        .into_result()?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);
    let cfg = env.config().await?;
    assert_eq!(cfg.signers.len(), 3);
    assert_eq!(cfg.signer_epoch.0, 1);
    Ok(())
}

/// R35a: storage one proposal leaves behind (create -> approve -> execute).
/// Proposals are never pruned, so this is what each one costs the account.
#[tokio::test]
async fn storage_per_proposal() -> anyhow::Result<()> {
    let env = setup().await?;
    env.deposit(ETH_ASSET, 1_000).await?;
    env.add_active_saved_address("sa_1", "eth", ETH_ADDRESS, 1)
        .await?;

    // The first withdrawal of an asset also creates its limits/window state.
    let before = storage_usage(&env).await?;
    let id = env.pass(&eth_withdraw(10, "sa_1"), 2).await?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);
    let first_withdraw = storage_usage(&env).await? - before;

    let before = storage_usage(&env).await?;
    let id = env.pass(&eth_withdraw(10, "sa_1"), 3).await?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);
    let withdraw = storage_usage(&env).await? - before;

    // A small settings proposal that executes at once.
    let before = storage_usage(&env).await?;
    let cap = Action::SetRefundCap {
        asset: ETH_ASSET.to_string(),
        daily: U128(0),
    };
    let id = env.pass(&cap, 4).await?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);
    let small = storage_usage(&env).await? - before;

    // AddSigner carrying a passkey, through its timelock (includes the new
    // signer's own record).
    let before = storage_usage(&env).await?;
    let id = env.pass(&Action::AddSigner(person(3).signer()), 5).await?;
    env.advance(DAY_AND_A_BIT_S).await?;
    env.call_shop(&env.relayer, "execute", json!({ "proposal_id": id }))
        .await?
        .into_result()?;
    assert_eq!(env.proposal(&id).await?.status, ProposalStatus::Executed);
    let add_signer = storage_usage(&env).await? - before;

    println!(
        "STORAGE_PER_PROPOSAL bytes: first_withdraw={first_withdraw} withdraw={withdraw} \
         set_refund_cap={small} add_signer={add_signer}"
    );
    // Guards the figure the API's storage top-up is sized from
    // (apps/api STORAGE_BYTES_PER_PROPOSAL).
    for n in [first_withdraw, withdraw, small, add_signer] {
        assert!(n <= 600, "a proposal used {n} bytes");
    }
    Ok(())
}

async fn storage_usage(env: &Env) -> anyhow::Result<u64> {
    Ok(env.worker.view_account(&env.shop).await?.storage_usage)
}
