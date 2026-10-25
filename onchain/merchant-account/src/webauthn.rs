//! WebAuthn assertion verification for merchant signers.
//!
//! The authenticatorData flag checks, the `clientDataJSON` checks and the
//! signed-message construction are vendored and adapted from near/intents
//! `crates/signatures/webauthn` (crate `defuse-webauthn`, file `src/lib.rs`)
//! at commit d340060afe1debb8c8f2f2fc6b6c999d48c886b0. Changes: typed errors
//! instead of `bool`, plus the rpIdHash and origin checks the upstream crate
//! leaves to its caller, and user verification (UV) is always required.
//!
//! Upstream license:
//!
//! MIT License
//!
//! Copyright (c) 2025 NEAR Foundation
//!
//! Permission is hereby granted, free of charge, to any person obtaining a copy
//! of this software and associated documentation files (the "Software"), to deal
//! in the Software without restriction, including without limitation the rights
//! to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the Software, and to permit persons to whom the Software is
//! furnished to do so, subject to the following conditions:
//!
//! The above copyright notice and this permission notice shall be included in all
//! copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//! IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//! FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//! AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//! LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//! OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//! SOFTWARE.

use near_sdk::base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use near_sdk::serde::Deserialize;
use near_sdk::serde_with::base64::Base64;
use near_sdk::{env, near};

/// A signer's public key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignerKey {
    /// Compressed SEC1 P-256 public key (passkeys, COSE ES256).
    P256(#[serde_as(as = "Base64")] [u8; 33]),
    /// Ed25519 public key (COSE EdDSA passkeys and the recovery key).
    Ed25519(#[serde_as(as = "Base64")] [u8; 32]),
}

/// A WebAuthn `navigator.credentials.get()` response.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assertion {
    #[serde_as(as = "Base64")]
    pub authenticator_data: Vec<u8>,
    pub client_data_json: String,
    /// Raw 64 bytes: `r‖s` for P-256 (not DER), the plain signature for Ed25519.
    #[serde_as(as = "Base64")]
    pub signature: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WebauthnError {
    AuthenticatorDataTooShort,
    RpIdHashMismatch,
    UserNotPresent,
    UserNotVerified,
    InvalidBackupFlags,
    InvalidClientData,
    WrongClientDataType,
    ChallengeMismatch,
    OriginNotAllowed,
    InvalidSignatureLength,
    HighS,
    BadSignature,
}

impl core::fmt::Display for WebauthnError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let msg = match self {
            Self::AuthenticatorDataTooShort => "authenticator data too short",
            Self::RpIdHashMismatch => "rpIdHash mismatch",
            Self::UserNotPresent => "user-present flag not set",
            Self::UserNotVerified => "user-verified flag not set",
            Self::InvalidBackupFlags => "backup-state flag set without backup-eligible flag",
            Self::InvalidClientData => "invalid clientDataJSON",
            Self::WrongClientDataType => "clientData type is not webauthn.get",
            Self::ChallengeMismatch => "challenge mismatch",
            Self::OriginNotAllowed => "origin not allowed",
            Self::InvalidSignatureLength => "signature must be 64 bytes",
            Self::HighS => "P-256 signature is not low-s",
            Self::BadSignature => "bad signature",
        };
        f.write_str(msg)
    }
}

/// `rpIdHash` (32) + flags (1) + signCount (4).
const MIN_AUTH_DATA_LEN: usize = 37;
const FLAG_UP: u8 = 1 << 0;
const FLAG_UV: u8 = 1 << 2;
const FLAG_BE: u8 = 1 << 3;
const FLAG_BS: u8 = 1 << 4;

/// The fields of `CollectedClientData` the contract checks.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ClientData {
    #[serde(rename = "type")]
    typ: String,
    challenge: String,
    origin: String,
}

/// Verifies a WebAuthn assertion over `expected_challenge` by `key`.
///
/// See <https://w3c.github.io/webauthn/#sctn-verifying-assertion>. Both UP and
/// UV must be set. P-256 signatures must be low-s.
pub fn verify_assertion(
    key: &SignerKey,
    a: &Assertion,
    expected_challenge: &[u8; 32],
    rp_id_hash: &[u8; 32],
    allowed_origins: &[String],
) -> Result<(), WebauthnError> {
    check_authenticator_data(&a.authenticator_data, rp_id_hash)?;
    check_client_data(&a.client_data_json, expected_challenge, allowed_origins)?;

    let signature: &[u8; 64] = a
        .signature
        .as_slice()
        .try_into()
        .map_err(|_| WebauthnError::InvalidSignatureLength)?;

    // Step 20-21: the signature covers `authenticatorData ‖ sha256(clientDataJSON)`.
    let mut msg = Vec::with_capacity(a.authenticator_data.len() + 32);
    msg.extend_from_slice(&a.authenticator_data);
    msg.extend_from_slice(&env::sha256_array(a.client_data_json.as_bytes()));

    let ok = match key {
        SignerKey::P256(pk) => {
            if !env::p256_signature_is_low_s(signature) {
                return Err(WebauthnError::HighS);
            }
            p256_verify(signature, &env::sha256_array(&msg), pk)
        }
        SignerKey::Ed25519(pk) => ed25519_verify(signature, &msg, pk),
    };
    if ok {
        Ok(())
    } else {
        Err(WebauthnError::BadSignature)
    }
}

fn check_authenticator_data(data: &[u8], rp_id_hash: &[u8; 32]) -> Result<(), WebauthnError> {
    if data.len() < MIN_AUTH_DATA_LEN {
        return Err(WebauthnError::AuthenticatorDataTooShort);
    }
    // Step 15: rpIdHash.
    if data[..32] != rp_id_hash[..] {
        return Err(WebauthnError::RpIdHashMismatch);
    }
    let flags = data[32];
    // Step 16: UP.
    if flags & FLAG_UP == 0 {
        return Err(WebauthnError::UserNotPresent);
    }
    // Step 17: UV (always required here).
    if flags & FLAG_UV == 0 {
        return Err(WebauthnError::UserNotVerified);
    }
    // Step 18: BS must not be set without BE.
    if flags & FLAG_BE == 0 && flags & FLAG_BS != 0 {
        return Err(WebauthnError::InvalidBackupFlags);
    }
    Ok(())
}

fn check_client_data(
    json: &str,
    expected_challenge: &[u8; 32],
    allowed_origins: &[String],
) -> Result<(), WebauthnError> {
    let c: ClientData =
        near_sdk::serde_json::from_str(json).map_err(|_| WebauthnError::InvalidClientData)?;
    // Step 10: type.
    if c.typ != "webauthn.get" {
        return Err(WebauthnError::WrongClientDataType);
    }
    // Step 11: challenge is the base64url (unpadded) encoding of the expected bytes.
    if c.challenge != URL_SAFE_NO_PAD.encode(expected_challenge) {
        return Err(WebauthnError::ChallengeMismatch);
    }
    // Step 12: origin.
    if !allowed_origins.contains(&c.origin) {
        return Err(WebauthnError::OriginNotAllowed);
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn p256_verify(signature: &[u8; 64], prehash: &[u8; 32], public_key: &[u8; 33]) -> bool {
    env::p256_verify(signature, prehash, public_key)
}

#[cfg(target_arch = "wasm32")]
fn ed25519_verify(signature: &[u8; 64], msg: &[u8], public_key: &[u8; 32]) -> bool {
    env::ed25519_verify(signature, msg, public_key)
}

#[cfg(not(target_arch = "wasm32"))]
fn p256_verify(signature: &[u8; 64], prehash: &[u8; 32], public_key: &[u8; 33]) -> bool {
    use p256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
    let Ok(vk) = VerifyingKey::from_sec1_bytes(public_key) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(signature) else {
        return false;
    };
    vk.verify_prehash(prehash, &sig).is_ok()
}

#[cfg(not(target_arch = "wasm32"))]
fn ed25519_verify(signature: &[u8; 64], msg: &[u8], public_key: &[u8; 32]) -> bool {
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    vk.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(signature))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer as _;
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::elliptic_curve::scalar::IsHigh;

    const ORIGIN: &str = "http://localhost:3000";
    const CHALLENGE: [u8; 32] = [7u8; 32];
    /// UP (0x01) | UV (0x04).
    const FLAGS_UP_UV: u8 = 0x05;

    fn rp_id_hash() -> [u8; 32] {
        near_sdk::env::sha256_array(b"localhost")
    }

    fn origins() -> Vec<String> {
        vec![ORIGIN.to_string()]
    }

    fn auth_data(rp_id_hash: [u8; 32], flags: u8) -> Vec<u8> {
        let mut data = rp_id_hash.to_vec();
        data.push(flags);
        data.extend_from_slice(&[0, 0, 0, 1]); // signCount
        data
    }

    fn client_data(typ: &str, challenge: &[u8], origin: &str) -> String {
        format!(
            r#"{{"type":"{typ}","challenge":"{}","origin":"{origin}","crossOrigin":false}}"#,
            URL_SAFE_NO_PAD.encode(challenge)
        )
    }

    fn signed_message(authenticator_data: &[u8], client_data_json: &str) -> Vec<u8> {
        let mut msg = authenticator_data.to_vec();
        msg.extend_from_slice(&near_sdk::env::sha256_array(client_data_json.as_bytes()));
        msg
    }

    fn p256_key(seed: u8) -> p256::ecdsa::SigningKey {
        p256::ecdsa::SigningKey::from_bytes(&[seed; 32].into()).unwrap()
    }

    fn p256_signer(sk: &p256::ecdsa::SigningKey) -> SignerKey {
        let point = sk.verifying_key().to_encoded_point(true);
        SignerKey::P256(point.as_bytes().try_into().unwrap())
    }

    /// Low-s P-256 signature (raw `r‖s`) over `authenticator_data ‖ sha256(client_data_json)`.
    fn p256_sign(
        sk: &p256::ecdsa::SigningKey,
        authenticator_data: &[u8],
        client_data_json: &str,
    ) -> Vec<u8> {
        let prehash =
            near_sdk::env::sha256_array(signed_message(authenticator_data, client_data_json));
        let sig: p256::ecdsa::Signature = sk.sign_prehash(&prehash).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig);
        sig.to_bytes().to_vec()
    }

    fn p256_assertion(
        sk: &p256::ecdsa::SigningKey,
        authenticator_data: Vec<u8>,
        client_data_json: String,
    ) -> Assertion {
        let signature = p256_sign(sk, &authenticator_data, &client_data_json);
        Assertion {
            authenticator_data,
            client_data_json,
            signature,
        }
    }

    fn valid_p256() -> (SignerKey, Assertion) {
        let sk = p256_key(1);
        let a = p256_assertion(
            &sk,
            auth_data(rp_id_hash(), FLAGS_UP_UV),
            client_data("webauthn.get", &CHALLENGE, ORIGIN),
        );
        (p256_signer(&sk), a)
    }

    fn verify(key: &SignerKey, a: &Assertion) -> Result<(), WebauthnError> {
        verify_assertion(key, a, &CHALLENGE, &rp_id_hash(), &origins())
    }

    #[test]
    fn accepts_valid_p256_assertion() {
        let (key, a) = valid_p256();
        assert_eq!(verify(&key, &a), Ok(()));
    }

    #[test]
    fn accepts_valid_ed25519_assertion() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[2u8; 32]);
        let authenticator_data = auth_data(rp_id_hash(), FLAGS_UP_UV);
        let client_data_json = client_data("webauthn.get", &CHALLENGE, ORIGIN);
        let signature = sk
            .sign(&signed_message(&authenticator_data, &client_data_json))
            .to_bytes()
            .to_vec();
        let key = SignerKey::Ed25519(sk.verifying_key().to_bytes());
        let a = Assertion {
            authenticator_data,
            client_data_json,
            signature,
        };
        assert_eq!(verify(&key, &a), Ok(()));
    }

    #[test]
    fn rejects_wrong_challenge() {
        let sk = p256_key(1);
        let a = p256_assertion(
            &sk,
            auth_data(rp_id_hash(), FLAGS_UP_UV),
            client_data("webauthn.get", &[8u8; 32], ORIGIN),
        );
        assert_eq!(
            verify(&p256_signer(&sk), &a),
            Err(WebauthnError::ChallengeMismatch)
        );
    }

    #[test]
    fn rejects_wrong_rp_id_hash() {
        let sk = p256_key(1);
        let a = p256_assertion(
            &sk,
            auth_data(near_sdk::env::sha256_array(b"evil.example"), FLAGS_UP_UV),
            client_data("webauthn.get", &CHALLENGE, ORIGIN),
        );
        assert_eq!(
            verify(&p256_signer(&sk), &a),
            Err(WebauthnError::RpIdHashMismatch)
        );
    }

    #[test]
    fn rejects_origin_not_allowed() {
        let sk = p256_key(1);
        let a = p256_assertion(
            &sk,
            auth_data(rp_id_hash(), FLAGS_UP_UV),
            client_data("webauthn.get", &CHALLENGE, "https://evil.example"),
        );
        assert_eq!(
            verify(&p256_signer(&sk), &a),
            Err(WebauthnError::OriginNotAllowed)
        );
    }

    #[test]
    fn rejects_type_not_webauthn_get() {
        let sk = p256_key(1);
        let a = p256_assertion(
            &sk,
            auth_data(rp_id_hash(), FLAGS_UP_UV),
            client_data("webauthn.create", &CHALLENGE, ORIGIN),
        );
        assert_eq!(
            verify(&p256_signer(&sk), &a),
            Err(WebauthnError::WrongClientDataType)
        );
    }

    #[test]
    fn rejects_missing_user_present_or_verified_flag() {
        let sk = p256_key(1);
        let cases = [
            (0x04, WebauthnError::UserNotPresent),  // UV only
            (0x01, WebauthnError::UserNotVerified), // UP only
            (0x00, WebauthnError::UserNotPresent),
        ];
        for (flags, expected) in cases {
            let a = p256_assertion(
                &sk,
                auth_data(rp_id_hash(), flags),
                client_data("webauthn.get", &CHALLENGE, ORIGIN),
            );
            assert_eq!(
                verify(&p256_signer(&sk), &a),
                Err(expected),
                "flags {flags:#04x}"
            );
        }
    }

    #[test]
    fn rejects_high_s_p256() {
        let (key, mut a) = valid_p256();
        let sig = p256::ecdsa::Signature::from_slice(&a.signature).unwrap();
        let (r, s) = sig.split_scalars();
        let high = p256::ecdsa::Signature::from_scalars(r, -*s).unwrap();
        assert!(bool::from(high.s().is_high()));
        a.signature = high.to_bytes().to_vec();
        assert_eq!(verify(&key, &a), Err(WebauthnError::HighS));
    }

    #[test]
    fn rejects_signature_by_other_key() {
        let (_, a) = valid_p256();
        let other = p256_signer(&p256_key(3));
        assert_eq!(verify(&other, &a), Err(WebauthnError::BadSignature));
    }

    #[test]
    fn json_encodes_bytes_as_base64() {
        let key = SignerKey::Ed25519([1u8; 32]);
        let json = near_sdk::serde_json::to_value(&key).unwrap();
        assert_eq!(
            json,
            near_sdk::serde_json::json!({
                "ed25519": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
            })
        );
        let a = Assertion {
            authenticator_data: vec![1, 2, 3],
            client_data_json: "{}".to_string(),
            signature: vec![4, 5, 6],
        };
        let json = near_sdk::serde_json::to_value(&a).unwrap();
        assert_eq!(
            json,
            near_sdk::serde_json::json!({
                "authenticator_data": "AQID",
                "client_data_json": "{}",
                "signature": "BAUG"
            })
        );
        assert_eq!(
            near_sdk::serde_json::from_value::<Assertion>(json).unwrap(),
            a
        );
    }
}
