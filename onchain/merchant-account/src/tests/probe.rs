//! The `probe_p256` view that only the mainnet check script's build exports.
use near_sdk::json_types::Base64VecU8;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env};
use p256::ecdsa::signature::hazmat::PrehashSigner;

use crate::MerchantAccount;

#[test]
fn probe_p256_accepts_a_valid_signature_and_rejects_the_rest() {
    testing_env!(VMContextBuilder::new().build());
    let key = p256::ecdsa::SigningKey::from_bytes(&[7u8; 32].into()).unwrap();
    let pk = key
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();
    let hash = env::sha256_array(b"tendr probe");
    let sig: p256::ecdsa::Signature = key.sign_prehash(&hash).unwrap();
    let sig = sig.normalize_s().unwrap_or(sig).to_bytes().to_vec();
    let b = |v: Vec<u8>| Base64VecU8::from(v);
    assert!(MerchantAccount::probe_p256(
        b(sig.clone()),
        b(hash.to_vec()),
        b(pk.clone())
    ));
    let other = env::sha256_array(b"other");
    assert!(!MerchantAccount::probe_p256(
        b(sig.clone()),
        b(other.to_vec()),
        b(pk.clone())
    ));
    assert!(!MerchantAccount::probe_p256(
        b(sig[..63].to_vec()),
        b(hash.to_vec()),
        b(pk)
    ));
}
