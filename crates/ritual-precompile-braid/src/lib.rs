//! Ritual Precompile Braid — Ed25519 permission attestation for ritual transactions.
//! The agent signs the ritual_hash. The hook verifies the precompile instruction is present.
//! Precompiles are not callable via CPI — the hook uses Instructions sysvar to verify.

use ed25519_dalek::{Keypair, PublicKey, Signature, Signer, Verifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SignerKind {
    Ed25519,
    Secp256k1,
    Secp256r1,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionBraid {
    pub signer_kind: SignerKind,
    pub ritual_hash: [u8; 32],
    pub permission_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub signature_bytes: Vec<u8>, // 64 bytes for Ed25519
    pub pubkey_bytes: Vec<u8>,    // 32 bytes for Ed25519
}

#[derive(Debug, PartialEq)]
pub enum BraidError {
    Expired,
    InvalidSignature,
    UnsupportedSignerKind,
    WrongRitualHash,
}

// ── Core functions ────────────────────────────────────────────────────────────

/// Canonical signed message:
/// SHA256("dark_null_v1_permission_braid" || ritual_hash || permission_hash || expires_at_slot.to_le_bytes())
pub fn build_signed_ritual_message(
    ritual_hash: &[u8; 32],
    permission_hash: &[u8; 32],
    expires_at_slot: u64,
) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b"dark_null_v1_permission_braid");
    h.update(ritual_hash);
    h.update(permission_hash);
    h.update(expires_at_slot.to_le_bytes());
    h.finalize().to_vec()
}

/// Hash of the signed message (for on-chain matching).
pub fn braid_message_hash(
    ritual_hash: &[u8; 32],
    permission_hash: &[u8; 32],
    expires_at_slot: u64,
) -> [u8; 32] {
    let msg = build_signed_ritual_message(ritual_hash, permission_hash, expires_at_slot);
    let mut h = Sha256::new();
    h.update(&msg);
    h.finalize().into()
}

/// Create a new Ed25519 braid by signing the canonical message.
pub fn new_braid(
    ritual_hash: [u8; 32],
    permission_hash: [u8; 32],
    expires_at_slot: u64,
    keypair: &Keypair,
) -> PermissionBraid {
    let msg = build_signed_ritual_message(&ritual_hash, &permission_hash, expires_at_slot);
    let signature: Signature = keypair.sign(&msg);
    PermissionBraid {
        signer_kind: SignerKind::Ed25519,
        ritual_hash,
        permission_hash,
        expires_at_slot,
        signature_bytes: signature.to_bytes().to_vec(),
        pubkey_bytes: keypair.public.to_bytes().to_vec(),
    }
}

/// Verify a braid:
/// - current_slot <= expires_at_slot
/// - signature is valid Ed25519 over build_signed_ritual_message
/// - signer_kind == Ed25519
pub fn verify_braid(braid: &PermissionBraid, current_slot: u64) -> Result<(), BraidError> {
    match braid.signer_kind {
        SignerKind::Ed25519 => {}
        _ => return Err(BraidError::UnsupportedSignerKind),
    }
    if current_slot > braid.expires_at_slot {
        return Err(BraidError::Expired);
    }
    let msg = build_signed_ritual_message(
        &braid.ritual_hash,
        &braid.permission_hash,
        braid.expires_at_slot,
    );
    let pubkey =
        PublicKey::from_bytes(&braid.pubkey_bytes).map_err(|_| BraidError::InvalidSignature)?;
    let sig_bytes: [u8; 64] = braid
        .signature_bytes
        .as_slice()
        .try_into()
        .map_err(|_| BraidError::InvalidSignature)?;
    let signature = Signature::from_bytes(&sig_bytes).map_err(|_| BraidError::InvalidSignature)?;
    pubkey
        .verify(&msg, &signature)
        .map_err(|_| BraidError::InvalidSignature)?;
    Ok(())
}

/// Hex string of the message hash — for evidence JSON.
pub fn braid_message_hash_hex(
    ritual_hash: &[u8; 32],
    permission_hash: &[u8; 32],
    expires_at_slot: u64,
) -> String {
    let hash = braid_message_hash(ritual_hash, permission_hash, expires_at_slot);
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SecretKey;

    fn test_keypair() -> Keypair {
        // Deterministic keypair from a fixed seed
        let mut seed = [0u8; 32];
        seed[0] = 0xde;
        seed[1] = 0xad;
        seed[2] = 0xbe;
        seed[3] = 0xef;
        let secret = SecretKey::from_bytes(&seed).expect("valid secret");
        let public: PublicKey = (&secret).into();
        Keypair { secret, public }
    }

    fn test_ritual_hash() -> [u8; 32] {
        [0x11u8; 32]
    }

    fn test_permission_hash() -> [u8; 32] {
        [0x22u8; 32]
    }

    #[test]
    fn test_braid_message_deterministic() {
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let slot = 1_000_000u64;
        let m1 = build_signed_ritual_message(&rh, &ph, slot);
        let m2 = build_signed_ritual_message(&rh, &ph, slot);
        assert_eq!(m1, m2);
    }

    #[test]
    fn test_braid_message_hash_deterministic() {
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let slot = 1_000_000u64;
        assert_eq!(
            braid_message_hash(&rh, &ph, slot),
            braid_message_hash(&rh, &ph, slot)
        );
    }

    #[test]
    fn test_braid_message_binds_ritual_hash() {
        let ph = test_permission_hash();
        let slot = 1_000_000u64;
        let m1 = build_signed_ritual_message(&[0x11; 32], &ph, slot);
        let m2 = build_signed_ritual_message(&[0x33; 32], &ph, slot);
        assert_ne!(m1, m2);
    }

    #[test]
    fn test_braid_message_binds_slot() {
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let m1 = build_signed_ritual_message(&rh, &ph, 1_000_000);
        let m2 = build_signed_ritual_message(&rh, &ph, 2_000_000);
        assert_ne!(m1, m2);
    }

    #[test]
    fn test_new_braid_verifies() {
        let kp = test_keypair();
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let expires = 9_999_999u64;
        let braid = new_braid(rh, ph, expires, &kp);
        assert_eq!(verify_braid(&braid, 0), Ok(()));
    }

    #[test]
    fn test_expired_braid_rejected() {
        let kp = test_keypair();
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let expires = 1_000u64;
        let braid = new_braid(rh, ph, expires, &kp);
        // current_slot > expires_at_slot
        assert_eq!(verify_braid(&braid, 2_000), Err(BraidError::Expired));
    }

    #[test]
    fn test_valid_slot_braid_accepted() {
        let kp = test_keypair();
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let expires = 5_000u64;
        let braid = new_braid(rh, ph, expires, &kp);
        // current_slot == expires_at_slot (boundary — still valid)
        assert_eq!(verify_braid(&braid, 5_000), Ok(()));
    }

    #[test]
    fn test_braid_has_ed25519_kind() {
        let kp = test_keypair();
        let braid = new_braid(test_ritual_hash(), test_permission_hash(), 1_000, &kp);
        assert!(matches!(braid.signer_kind, SignerKind::Ed25519));
    }

    #[test]
    fn test_braid_message_hash_hex_is_64_chars() {
        let rh = test_ritual_hash();
        let ph = test_permission_hash();
        let hex = braid_message_hash_hex(&rh, &ph, 1_000_000);
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
