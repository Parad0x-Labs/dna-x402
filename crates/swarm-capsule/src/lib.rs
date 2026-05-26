//! Swarm Capsule — signed relayer capability passport.
//!
//! Each Dark Null relayer node carries a `SwarmCapsule` that proves:
//!   - Which repo commit it is running
//!   - Its config hash (no secret drift)
//!   - What roles it can perform (role_bitmap)
//!   - Fee caps and SOL float limits
//!   - That it does NOT hold custody or an upgrade key
//!   - When it was last alive
//!
//! Capsules are Ed25519-signed by a relayer key. Recipients call
//! `verify_capsule` before routing traffic through a relayer.
//! Later: capsule hashes enter the receipt DAG.

use ed25519_dalek::{Keypair, PublicKey, Signature, Signer, Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Role bitmap flags ─────────────────────────────────────────────────────────

pub const ROLE_RECEIPT_RELAY: u32 = 1 << 0;
pub const ROLE_FEE_ROUTER: u32 = 1 << 1;
pub const ROLE_PROOF_VALIDATOR: u32 = 1 << 2;
pub const ROLE_BUNDLE_BUILDER: u32 = 1 << 3;
pub const ROLE_MARKET_FEED: u32 = 1 << 4;

// ── Capsule ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SwarmCapsule {
    /// First 20 bytes of the Git commit SHA running in this node.
    pub repo_commit: [u8; 20],
    /// SHA-256 of the active config file (no secret keys).
    pub config_hash: [u8; 32],
    /// Bitfield of capabilities this node exposes.
    pub role_bitmap: u32,
    /// Maximum lamports this node will forward in one operation.
    pub fee_cap_lamports: u64,
    /// Maximum SOL this node will hold unconfirmed at any moment.
    pub max_sol_float: u64,
    /// True if this node explicitly denies holding user funds.
    pub custody_denied: bool,
    /// True if this node's x402 payment adapter is enabled.
    pub x402_adapter_enabled: bool,
    /// Unix timestamp of last liveness ping.
    pub liveness_unix: i64,
}

impl SwarmCapsule {
    /// Canonical byte encoding for signing (deterministic field order).
    pub fn to_signing_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(128);
        buf.extend_from_slice(&self.repo_commit);
        buf.extend_from_slice(&self.config_hash);
        buf.extend_from_slice(&self.role_bitmap.to_le_bytes());
        buf.extend_from_slice(&self.fee_cap_lamports.to_le_bytes());
        buf.extend_from_slice(&self.max_sol_float.to_le_bytes());
        buf.push(self.custody_denied as u8);
        buf.push(self.x402_adapter_enabled as u8);
        buf.extend_from_slice(&self.liveness_unix.to_le_bytes());
        buf
    }

    /// SHA-256 of the capsule content (used for receipt DAG linking).
    pub fn content_hash(&self) -> [u8; 32] {
        Sha256::digest(&self.to_signing_bytes()).into()
    }
}

// ── Signed capsule ────────────────────────────────────────────────────────────

pub struct SignedCapsule {
    pub capsule: SwarmCapsule,
    pub signature: [u8; 64],
    pub pubkey: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum CapsuleError {
    InvalidSignature,
    CustodyViolation,
}

impl std::fmt::Display for CapsuleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CapsuleError::InvalidSignature => write!(f, "capsule: signature invalid"),
            CapsuleError::CustodyViolation => write!(f, "capsule: custody_denied=false rejected"),
        }
    }
}

// ── API ───────────────────────────────────────────────────────────────────────

/// Sign a `SwarmCapsule` with the relayer's Ed25519 keypair.
pub fn sign_capsule(capsule: &SwarmCapsule, keypair: &Keypair) -> SignedCapsule {
    let bytes = capsule.to_signing_bytes();
    let sig = keypair.sign(&bytes);
    SignedCapsule {
        capsule: capsule.clone(),
        signature: sig.to_bytes(),
        pubkey: keypair.public.to_bytes(),
    }
}

/// Verify a `SignedCapsule`:
/// 1. Signature must be valid for the capsule content.
/// 2. `custody_denied` must be `true` (Dark Null non-custodial invariant).
pub fn verify_capsule(signed: &SignedCapsule) -> Result<(), CapsuleError> {
    if !signed.capsule.custody_denied {
        return Err(CapsuleError::CustodyViolation);
    }

    let pk = PublicKey::from_bytes(&signed.pubkey).map_err(|_| CapsuleError::InvalidSignature)?;
    let sig =
        Signature::from_bytes(&signed.signature).map_err(|_| CapsuleError::InvalidSignature)?;
    let msg = signed.capsule.to_signing_bytes();

    pk.verify(&msg, &sig)
        .map_err(|_| CapsuleError::InvalidSignature)
}

pub fn make_test_capsule(custody_denied: bool) -> SwarmCapsule {
    SwarmCapsule {
        repo_commit: [0xAB; 20],
        config_hash: [0xCD; 32],
        role_bitmap: ROLE_RECEIPT_RELAY | ROLE_FEE_ROUTER,
        fee_cap_lamports: 500_000,
        max_sol_float: 1_000_000,
        custody_denied,
        x402_adapter_enabled: true,
        liveness_unix: 1_700_000_000,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_key() -> Keypair {
        let secret = ed25519_dalek::SecretKey::from_bytes(&[0x42u8; 32]).unwrap();
        let public = PublicKey::from(&secret);
        Keypair { secret, public }
    }

    #[test]
    fn test_sign_and_verify() {
        let key = fresh_key();
        let capsule = make_test_capsule(true);
        let signed = sign_capsule(&capsule, &key);
        assert!(verify_capsule(&signed).is_ok());
    }

    #[test]
    fn test_tampered_capsule_rejected() {
        let key = fresh_key();
        let mut c = make_test_capsule(true);
        let signed = sign_capsule(&c, &key);
        // Tamper the capsule after signing
        c.fee_cap_lamports = 999_999_999;
        let tampered = SignedCapsule {
            capsule: c,
            signature: signed.signature,
            pubkey: signed.pubkey,
        };
        assert_eq!(
            verify_capsule(&tampered),
            Err(CapsuleError::InvalidSignature)
        );
    }

    #[test]
    fn test_custody_violation_rejected() {
        let key = fresh_key();
        let bad = make_test_capsule(false); // custody_denied = false
        let signed = sign_capsule(&bad, &key);
        // Even with valid signature, custody_denied=false must be rejected
        assert_eq!(verify_capsule(&signed), Err(CapsuleError::CustodyViolation));
    }

    #[test]
    fn test_content_hash_stable() {
        let c = make_test_capsule(true);
        assert_eq!(c.content_hash(), c.content_hash());
        assert_ne!(c.content_hash(), [0u8; 32]);
    }

    #[test]
    fn test_role_bitmap_composition() {
        let bitmap = ROLE_RECEIPT_RELAY | ROLE_BUNDLE_BUILDER;
        assert!(bitmap & ROLE_RECEIPT_RELAY != 0);
        assert!(bitmap & ROLE_BUNDLE_BUILDER != 0);
        assert!(bitmap & ROLE_MARKET_FEED == 0);
    }

    #[test]
    fn test_capsule_json_roundtrip() {
        let c = make_test_capsule(true);
        let json = serde_json::to_string(&c).unwrap();
        let back: SwarmCapsule = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }
}
