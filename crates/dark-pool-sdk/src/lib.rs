//! dark-pool-sdk — off-chain client for dark_shielded_pool
//!
//! The SDK that an AI agent (or wallet) uses to:
//!   1. Generate a random note secret (stays off-chain forever)
//!   2. Compute the commitment to deposit on-chain
//!   3. Compute the nullifier to spend the note
//!   4. Build the stub ZK proof for the withdrawal instruction
//!
//! IS_STUB      = true
//! MAINNET_READY = false

use sha2::{Digest, Sha256};

pub const IS_STUB: bool = true;
pub const MAINNET_READY: bool = false;

// ── hash domains (must match on-chain program) ────────────────────────────────
const DOMAIN_COMMIT: &[u8] = b"dark-pool-commit-v1";
const DOMAIN_NULLIFIER: &[u8] = b"dark-pool-null-v1";
const DOMAIN_PROOF: &[u8] = b"dark-pool-proof-v1";
const DOMAIN_NOTE_KEY: &[u8] = b"dark-pool-note-key-v1";

// ── error ─────────────────────────────────────────────────────────────────────
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum SdkError {
    ZeroSecret,
    ZeroPool,
    AlreadySpent,
}

impl core::fmt::Display for SdkError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::ZeroSecret   => write!(f, "secret must not be all zeros"),
            Self::ZeroPool     => write!(f, "pool key must not be all zeros"),
            Self::AlreadySpent => write!(f, "note is already spent"),
        }
    }
}

// ── types ─────────────────────────────────────────────────────────────────────

/// A private note representing one shielded deposit.
/// The `secret` NEVER leaves the client — it is never sent on-chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolNote {
    /// Random 32-byte secret. Keep offline. Losing this = losing funds.
    pub secret: [u8; 32],
    /// H(secret || leaf_index) — safe to post on-chain.
    pub commitment: [u8; 32],
    /// Index in the on-chain note tree.
    pub leaf_index: u64,
    /// Pool config pubkey this note belongs to.
    pub pool: [u8; 32],
    /// SOL lamports committed.
    pub denomination: u64,
    /// Has this note been withdrawn?
    pub is_spent: bool,
}

/// A withdrawal proof (stub until real Groth16 circuit is compiled).
#[derive(Debug, Clone)]
pub struct WithdrawProof {
    /// 128-byte proof blob. First 32 bytes = stub gate hash.
    pub proof_bytes: [u8; 128],
    pub nullifier: [u8; 32],
    pub merkle_root: [u8; 32],
    pub recipient: [u8; 32],
    pub is_stub: bool,
}

// ── core functions ────────────────────────────────────────────────────────────

/// Create a new pool note from a secret.
///
/// Client generates a random `secret`, calls this to get the `commitment` to deposit.
pub fn create_note(
    secret: [u8; 32],
    leaf_index: u64,
    pool: [u8; 32],
    denomination: u64,
) -> Result<PoolNote, SdkError> {
    if secret == [0u8; 32] {
        return Err(SdkError::ZeroSecret);
    }
    if pool == [0u8; 32] {
        return Err(SdkError::ZeroPool);
    }
    let commitment = commitment_hash(&secret, leaf_index);
    Ok(PoolNote { secret, commitment, leaf_index, pool, denomination, is_spent: false })
}

/// Compute the commitment: H(domain || secret || leaf_index_le).
pub fn commitment_hash(secret: &[u8; 32], leaf_index: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_COMMIT);
    h.update(secret);
    h.update(leaf_index.to_le_bytes());
    h.finalize().into()
}

/// Compute the nullifier: H(domain || secret || pool_key).
/// This is what you post on-chain to spend the note.
pub fn nullifier_hash(secret: &[u8; 32], pool: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_NULLIFIER);
    h.update(secret);
    h.update(pool);
    h.finalize().into()
}

/// Derive a one-time spend key from the secret.
/// This is an off-chain key used for relayer authentication — NOT the secret itself.
pub fn note_spend_key(secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(DOMAIN_NOTE_KEY);
    h.update(secret);
    h.finalize().into()
}

/// Build a stub withdrawal proof for use with the on-chain program.
///
/// IS_STUB: the "proof" is H(domain || nullifier || merkle_root || recipient).
/// This is replaced with a real Groth16 proof in Phase 2.
pub fn create_stub_proof(
    note: &PoolNote,
    merkle_root: &[u8; 32],
    recipient: &[u8; 32],
) -> Result<WithdrawProof, SdkError> {
    if note.is_spent {
        return Err(SdkError::AlreadySpent);
    }
    let nullifier = nullifier_hash(&note.secret, &note.pool);

    let mut proof_bytes = [0u8; 128];
    let gate: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_PROOF);
        h.update(&nullifier);
        h.update(merkle_root);
        h.update(recipient);
        h.finalize().into()
    };
    proof_bytes[..32].copy_from_slice(&gate);

    Ok(WithdrawProof {
        proof_bytes,
        nullifier,
        merkle_root: *merkle_root,
        recipient: *recipient,
        is_stub: IS_STUB,
    })
}

/// Mark a note as spent (call after a successful on-chain withdrawal).
pub fn mark_spent(note: &mut PoolNote) -> Result<(), SdkError> {
    if note.is_spent {
        return Err(SdkError::AlreadySpent);
    }
    note.is_spent = true;
    Ok(())
}

/// Verify locally that a proof would pass on-chain (useful for dry-run before submitting tx).
pub fn verify_stub_proof(proof: &WithdrawProof) -> bool {
    let gate: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(DOMAIN_PROOF);
        h.update(&proof.nullifier);
        h.update(&proof.merkle_root);
        h.update(&proof.recipient);
        h.finalize().into()
    };
    proof.proof_bytes[..32] == gate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> [u8; 32] { let mut s = [0u8; 32]; s[0] = 0xBE; s[31] = 0xEF; s }
    fn pool()   -> [u8; 32] { let mut p = [0u8; 32]; p[0] = 0xCA; p[15] = 0xFE; p }
    fn recip()  -> [u8; 32] { let mut r = [0u8; 32]; r[0] = 0xDE; r[20] = 0xAD; r }

    fn note() -> PoolNote {
        create_note(secret(), 0, pool(), 1_000_000_000).unwrap()
    }

    // 1. constants
    #[test]
    fn test_constants() {
        assert!(IS_STUB);
        assert!(!MAINNET_READY);
    }

    // 2. create_note succeeds
    #[test]
    fn test_create_note_succeeds() {
        let n = note();
        assert_ne!(n.commitment, [0u8; 32]);
        assert_eq!(n.leaf_index, 0);
        assert_eq!(n.denomination, 1_000_000_000);
        assert!(!n.is_spent);
        assert!(!n.mainnet_ready());
    }

    // 3. commitment is deterministic
    #[test]
    fn test_commitment_deterministic() {
        let n1 = note();
        let n2 = note();
        assert_eq!(n1.commitment, n2.commitment);
    }

    // 4. different secrets → different commitments
    #[test]
    fn test_different_secrets_different_commitments() {
        let n1 = note();
        let mut s2 = secret();
        s2[5] ^= 0xFF;
        let n2 = create_note(s2, 0, pool(), 1_000_000_000).unwrap();
        assert_ne!(n1.commitment, n2.commitment);
    }

    // 5. different leaf_index → different commitment
    #[test]
    fn test_leaf_index_sensitivity() {
        let c0 = commitment_hash(&secret(), 0);
        let c1 = commitment_hash(&secret(), 1);
        assert_ne!(c0, c1);
    }

    // 6. nullifier is deterministic
    #[test]
    fn test_nullifier_deterministic() {
        let n1 = nullifier_hash(&secret(), &pool());
        let n2 = nullifier_hash(&secret(), &pool());
        assert_eq!(n1, n2);
        assert_ne!(n1, [0u8; 32]);
    }

    // 7. nullifier differs from commitment
    #[test]
    fn test_nullifier_differs_from_commitment() {
        let c = commitment_hash(&secret(), 0);
        let n = nullifier_hash(&secret(), &pool());
        assert_ne!(c, n);
    }

    // 8. nullifier is pool-specific (same secret, different pool → different nullifier)
    #[test]
    fn test_nullifier_pool_scoped() {
        let mut p2 = pool();
        p2[1] ^= 0xAB;
        let n1 = nullifier_hash(&secret(), &pool());
        let n2 = nullifier_hash(&secret(), &p2);
        assert_ne!(n1, n2);
    }

    // 9. note_spend_key is deterministic and != secret
    #[test]
    fn test_note_spend_key_not_secret() {
        let k = note_spend_key(&secret());
        assert_ne!(k, secret(), "spend key must differ from secret");
        assert_eq!(k, note_spend_key(&secret()), "must be deterministic");
    }

    // 10. create_stub_proof succeeds
    #[test]
    fn test_create_stub_proof_succeeds() {
        let n = note();
        let root = [0x11u8; 32];
        let proof = create_stub_proof(&n, &root, &recip()).unwrap();
        assert!(proof.is_stub);
        assert_ne!(proof.nullifier, [0u8; 32]);
    }

    // 11. verify_stub_proof accepts valid proof
    #[test]
    fn test_verify_stub_proof_valid() {
        let n = note();
        let root = [0x22u8; 32];
        let proof = create_stub_proof(&n, &root, &recip()).unwrap();
        assert!(verify_stub_proof(&proof));
    }

    // 12. tampered proof is rejected
    #[test]
    fn test_tampered_proof_rejected() {
        let n = note();
        let root = [0x33u8; 32];
        let mut proof = create_stub_proof(&n, &root, &recip()).unwrap();
        proof.proof_bytes[0] ^= 0xFF; // flip first byte
        assert!(!verify_stub_proof(&proof));
    }

    // 13. mark_spent prevents double-spend
    #[test]
    fn test_mark_spent_prevents_double() {
        let mut n = note();
        mark_spent(&mut n).unwrap();
        let err = mark_spent(&mut n).unwrap_err();
        assert_eq!(err, SdkError::AlreadySpent);
    }

    // 14. spent note cannot create proof
    #[test]
    fn test_spent_note_cannot_create_proof() {
        let mut n = note();
        mark_spent(&mut n).unwrap();
        let err = create_stub_proof(&n, &[0u8; 32], &recip()).unwrap_err();
        assert_eq!(err, SdkError::AlreadySpent);
    }

    // 15. zero secret → error
    #[test]
    fn test_zero_secret_error() {
        let err = create_note([0u8; 32], 0, pool(), 1_000).unwrap_err();
        assert_eq!(err, SdkError::ZeroSecret);
    }

    // 16. zero pool key → error
    #[test]
    fn test_zero_pool_error() {
        let err = create_note(secret(), 0, [0u8; 32], 1_000).unwrap_err();
        assert_eq!(err, SdkError::ZeroPool);
    }

    // ── Extended ──────────────────────────────────────────────────────────────

    // 17. proof changes when recipient changes
    #[test]
    fn test_proof_recipient_sensitivity() {
        let n = note();
        let root = [0x44u8; 32];
        let p1 = create_stub_proof(&n, &root, &recip()).unwrap();
        let mut r2 = recip();
        r2[0] ^= 0x01;
        let p2 = create_stub_proof(&n, &root, &r2).unwrap();
        assert_ne!(p1.proof_bytes[..32], p2.proof_bytes[..32]);
    }

    // 18. proof changes when merkle root changes
    #[test]
    fn test_proof_merkle_root_sensitivity() {
        let n = note();
        let p1 = create_stub_proof(&n, &[0xAAu8; 32], &recip()).unwrap();
        let p2 = create_stub_proof(&n, &[0xBBu8; 32], &recip()).unwrap();
        assert_ne!(p1.proof_bytes[..32], p2.proof_bytes[..32]);
    }

    // 19. two notes from same secret but different pools have different nullifiers
    #[test]
    fn test_cross_pool_nullifier_isolation() {
        let mut pool2 = pool();
        pool2[31] = 0xFF;
        let n1 = nullifier_hash(&secret(), &pool());
        let n2 = nullifier_hash(&secret(), &pool2);
        assert_ne!(n1, n2, "nullifiers must be pool-isolated");
    }
}

// Allow PoolNote to report mainnet_ready
impl PoolNote {
    pub fn mainnet_ready(&self) -> bool { MAINNET_READY }
}
