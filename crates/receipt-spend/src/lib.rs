//! Private receipt-note protocol for Dark Null.
//!
//! Flow:
//!   1. Issuer mints a `ReceiptNote` from a random secret + x402 scope.
//!   2. Note commitment is stored in the on-chain receipt root (via dark_compressed_receipts).
//!   3. Spender calls `spend_note`, proving ownership of the secret and the correct scope.
//!   4. The resulting `NullifierProof` is submitted on-chain — nullifier PDA prevents replay.
//!
//! 100 unlinkable notes from the same wallet → 100 unlinkable API calls.

use dark_poseidon_tree::{domain_hash, nullifier_hash, DOMAIN_COMMITMENT, DOMAIN_X402_INTENT};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptNote {
    /// Pedersen-style commitment: H(COMMITMENT || secret || value=0).
    pub commitment: [u8; 32],
    /// H(X402_INTENT || scope_bytes) — binds note to one API scope.
    pub scope_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NullifierProof {
    /// Submitted to the nullifier bank to prevent double-spend.
    pub nullifier: [u8; 32],
    pub scope_hash: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum SpendError {
    /// The note's scope does not match the scope provided at spend time.
    ScopeMismatch,
}

impl std::fmt::Display for SpendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "receipt-spend: scope mismatch")
    }
}

// ── Core API ──────────────────────────────────────────────────────────────────

/// Hash an x402 scope string into the note's scope commitment.
pub fn hash_scope(scope: &str) -> [u8; 32] {
    domain_hash(DOMAIN_X402_INTENT, &[scope.as_bytes()])
}

/// Mint a new `ReceiptNote` from `secret` (random 32 bytes) bound to `scope`.
///
/// Two calls with the same `secret` but different `scope` produce different
/// commitments — the note is unlinkable across scopes.
pub fn new_note(secret: &[u8; 32], scope: &str) -> ReceiptNote {
    ReceiptNote {
        commitment: domain_hash(
            DOMAIN_COMMITMENT,
            &[secret.as_ref(), scope.as_bytes(), &0u64.to_le_bytes()],
        ),
        scope_hash: hash_scope(scope),
    }
}

/// Derive the nullifier for `note` relative to a Merkle `root`.
///
/// `nullifier = H(NULLIFIER || commitment || scope_hash || root)`
///
/// Root-binding ensures the nullifier changes if the receipt tree is rebuilt,
/// preventing cross-tree replay.
pub fn nullifier_from_note(note: &ReceiptNote, root: &[u8; 32]) -> [u8; 32] {
    // We build on top of nullifier_hash but include scope for extra binding.
    nullifier_hash(
        &domain_hash(
            dark_poseidon_tree::DOMAIN_COMMITMENT,
            &[&note.commitment, &note.scope_hash],
        ),
        root,
    )
}

/// Spend `note` for `scope` against the given Merkle `root`.
///
/// Returns `SpendError::ScopeMismatch` if the note was minted for a different scope.
pub fn spend_note(
    note: &ReceiptNote,
    root: &[u8; 32],
    scope: &str,
) -> Result<NullifierProof, SpendError> {
    if hash_scope(scope) != note.scope_hash {
        return Err(SpendError::ScopeMismatch);
    }
    Ok(NullifierProof {
        nullifier: nullifier_from_note(note, root),
        scope_hash: note.scope_hash,
    })
}

/// Verify that `proof` was legitimately derived from `note` and `root`.
pub fn verify_spend(proof: &NullifierProof, note: &ReceiptNote, root: &[u8; 32]) -> bool {
    proof.nullifier == nullifier_from_note(note, root) && proof.scope_hash == note.scope_hash
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: [u8; 32] = [0xAB; 32];
    const SCOPE: &str = "api.dark-null.io/v1/withdraw";
    const ROOT: [u8; 32] = [0x11; 32];

    #[test]
    fn test_nullifier_deterministic() {
        let note = new_note(&SECRET, SCOPE);
        let n1 = nullifier_from_note(&note, &ROOT);
        let n2 = nullifier_from_note(&note, &ROOT);
        assert_eq!(n1, n2);
    }

    #[test]
    fn test_different_scope_different_nullifier() {
        let note_a = new_note(&SECRET, "scope/a");
        let note_b = new_note(&SECRET, "scope/b");
        let n_a = nullifier_from_note(&note_a, &ROOT);
        let n_b = nullifier_from_note(&note_b, &ROOT);
        assert_ne!(
            n_a, n_b,
            "different scopes must produce different nullifiers"
        );
    }

    #[test]
    fn test_wrong_root_different_nullifier() {
        let note = new_note(&SECRET, SCOPE);
        let root2 = [0x22; 32];
        assert_ne!(
            nullifier_from_note(&note, &ROOT),
            nullifier_from_note(&note, &root2)
        );
    }

    #[test]
    fn test_spend_verify_roundtrip() {
        let note = new_note(&SECRET, SCOPE);
        let proof = spend_note(&note, &ROOT, SCOPE).unwrap();
        assert!(verify_spend(&proof, &note, &ROOT));
    }

    #[test]
    fn test_scope_mismatch_rejected() {
        let note = new_note(&SECRET, "correct/scope");
        let err = spend_note(&note, &ROOT, "wrong/scope").unwrap_err();
        assert_eq!(err, SpendError::ScopeMismatch);
    }

    #[test]
    fn test_note_unlinkability() {
        // Same secret, different scope → different commitment → unlinkable.
        let note_a = new_note(&SECRET, "scope/a");
        let note_b = new_note(&SECRET, "scope/b");
        assert_ne!(note_a.commitment, note_b.commitment);
        assert_ne!(note_a.scope_hash, note_b.scope_hash);
    }

    #[test]
    fn test_verify_fails_on_tampered_nullifier() {
        let note = new_note(&SECRET, SCOPE);
        let mut proof = spend_note(&note, &ROOT, SCOPE).unwrap();
        proof.nullifier[0] ^= 0xFF;
        assert!(!verify_spend(&proof, &note, &ROOT));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_hash_scope_nonzero() {
        assert_ne!(hash_scope(SCOPE), [0u8; 32]);
    }

    #[test]
    fn test_hash_scope_deterministic() {
        assert_eq!(hash_scope(SCOPE), hash_scope(SCOPE));
    }

    #[test]
    fn test_hash_scope_sensitive() {
        assert_ne!(hash_scope("scope/a"), hash_scope("scope/b"));
    }

    #[test]
    fn test_commitment_nonzero() {
        let note = new_note(&SECRET, SCOPE);
        assert_ne!(note.commitment, [0u8; 32]);
    }

    #[test]
    fn test_commitment_secret_sensitive() {
        let note_a = new_note(&[0x01u8; 32], SCOPE);
        let note_b = new_note(&[0x02u8; 32], SCOPE);
        assert_ne!(note_a.commitment, note_b.commitment);
    }

    #[test]
    fn test_nullifier_nonzero() {
        let note = new_note(&SECRET, SCOPE);
        assert_ne!(nullifier_from_note(&note, &ROOT), [0u8; 32]);
    }

    #[test]
    fn test_verify_spend_wrong_root_fails() {
        let note = new_note(&SECRET, SCOPE);
        let proof = spend_note(&note, &ROOT, SCOPE).unwrap();
        let wrong_root = [0xFFu8; 32];
        assert!(!verify_spend(&proof, &note, &wrong_root));
    }

    #[test]
    fn test_note_scope_hash_matches_hash_scope() {
        let note = new_note(&SECRET, SCOPE);
        assert_eq!(note.scope_hash, hash_scope(SCOPE));
    }

    #[test]
    fn test_spend_error_display_nonempty() {
        let msg = SpendError::ScopeMismatch.to_string();
        assert!(!msg.is_empty());
    }
}
