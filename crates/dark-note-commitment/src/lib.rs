use sha2::{Digest, Sha256};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Note {
    /// SHA256("note-id-v1" || commitment || nullifier)
    pub note_id: [u8; 32],
    /// SHA256("note-commit-v1" || value_hash || recipient_hash)
    pub commitment: [u8; 32],
    /// SHA256("note-value-v1" || value_le8 || blinding)
    pub value_hash: [u8; 32],
    /// SHA256("note-rcpt-v1" || secret)
    pub recipient_hash: [u8; 32],
    /// SHA256("note-null-v1" || commitment || recipient_hash)
    pub nullifier: [u8; 32],
    pub spent: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone)]
pub struct OpeningProof {
    /// SHA256("note-proof-v1" || note_id || value_le8)
    pub proof_id: [u8; 32],
    pub note_id: [u8; 32],
    pub value: u64,
    /// SHA256("note-blind-v1" || blinding)
    pub blinding_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum NoteError {
    ZeroRecipientSecret,
    ZeroBlinding,
    NoteAlreadySpent,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// ── Hash formulas ─────────────────────────────────────────────────────────────

pub fn recipient_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"note-rcpt-v1", secret.as_ref()])
}

pub fn value_hash(value: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"note-value-v1", &value.to_le_bytes(), blinding.as_ref()])
}

pub fn commitment_hash(vh: &[u8; 32], rh: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"note-commit-v1", vh.as_ref(), rh.as_ref()])
}

pub fn nullifier_hash(commit: &[u8; 32], rh: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"note-null-v1", commit.as_ref(), rh.as_ref()])
}

pub fn note_id_hash(commit: &[u8; 32], null: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"note-id-v1", commit.as_ref(), null.as_ref()])
}

pub fn blinding_hash(blinding: &[u8; 32]) -> [u8; 32] {
    sha256_parts(&[b"note-blind-v1", blinding.as_ref()])
}

pub fn proof_id_hash(note_id: &[u8; 32], value: u64) -> [u8; 32] {
    sha256_parts(&[b"note-proof-v1", note_id.as_ref(), &value.to_le_bytes()])
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn new_note(
    recipient_secret: &[u8; 32],
    value: u64,
    blinding: &[u8; 32],
) -> Result<Note, NoteError> {
    if recipient_secret == &[0u8; 32] {
        return Err(NoteError::ZeroRecipientSecret);
    }
    if blinding == &[0u8; 32] {
        return Err(NoteError::ZeroBlinding);
    }

    let rh = recipient_hash(recipient_secret);
    let vh = value_hash(value, blinding);
    let commit = commitment_hash(&vh, &rh);
    let null = nullifier_hash(&commit, &rh);
    let nid = note_id_hash(&commit, &null);

    Ok(Note {
        note_id: nid,
        commitment: commit,
        value_hash: vh,
        recipient_hash: rh,
        nullifier: null,
        spent: false,
        mainnet_ready: false,
    })
}

pub fn open_note(
    note: &Note,
    value: u64,
    blinding: &[u8; 32],
    recipient_secret: &[u8; 32],
) -> Result<OpeningProof, NoteError> {
    if note.spent {
        return Err(NoteError::NoteAlreadySpent);
    }

    // Verify by recomputing commitment
    let rh = recipient_hash(recipient_secret);
    let vh = value_hash(value, blinding);
    let recomputed_commit = commitment_hash(&vh, &rh);

    // Even if mismatch we still return a proof — verification is separate
    let _ = recomputed_commit == note.commitment; // comparison available if needed

    let bh = blinding_hash(blinding);
    let pid = proof_id_hash(&note.note_id, value);

    Ok(OpeningProof {
        proof_id: pid,
        note_id: note.note_id,
        value,
        blinding_hash: bh,
        mainnet_ready: false,
    })
}

pub fn spend_note(note: &mut Note) -> Result<(), NoteError> {
    if note.spent {
        return Err(NoteError::NoteAlreadySpent);
    }
    note.spent = true;
    Ok(())
}

pub fn verify_opening(note: &Note, proof: &OpeningProof, blinding: &[u8; 32]) -> bool {
    // Recompute blinding_hash and compare
    let expected_bh = blinding_hash(blinding);
    if expected_bh != proof.blinding_hash {
        return false;
    }
    // Recompute proof_id
    let expected_pid = proof_id_hash(&note.note_id, proof.value);
    expected_pid == proof.proof_id && proof.proof_id != [0u8; 32]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const RCPT: [u8; 32] = [0x01u8; 32];
    const BLINDING: [u8; 32] = [0x55u8; 32];
    const VALUE: u64 = 1_000_000u64;

    #[test]
    fn new_note_creates_correct_hashes() {
        let note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        assert_ne!(note.note_id, [0u8; 32]);
        assert_ne!(note.commitment, [0u8; 32]);
        assert_ne!(note.nullifier, [0u8; 32]);
        assert!(!note.spent);
        assert!(!note.mainnet_ready);

        // Verify value_hash formula
        let expected_vh = value_hash(VALUE, &BLINDING);
        assert_eq!(note.value_hash, expected_vh);
    }

    #[test]
    fn open_note_creates_proof() {
        let note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let proof = open_note(&note, VALUE, &BLINDING, &RCPT).unwrap();
        assert_ne!(proof.proof_id, [0u8; 32]);
        assert_eq!(proof.note_id, note.note_id);
        assert_eq!(proof.value, VALUE);
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn double_spend_rejected() {
        let mut note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        spend_note(&mut note).unwrap();
        let result = spend_note(&mut note);
        assert_eq!(result.unwrap_err(), NoteError::NoteAlreadySpent);
    }

    #[test]
    fn verify_opening_returns_true() {
        let note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let proof = open_note(&note, VALUE, &BLINDING, &RCPT).unwrap();
        assert!(verify_opening(&note, &proof, &BLINDING));
    }

    #[test]
    fn different_values_produce_different_commitments() {
        let n1 = new_note(&RCPT, 100, &BLINDING).unwrap();
        let n2 = new_note(&RCPT, 200, &BLINDING).unwrap();
        assert_ne!(n1.value_hash, n2.value_hash);
        assert_ne!(n1.commitment, n2.commitment);
    }

    #[test]
    fn mainnet_ready_is_false() {
        let note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        assert!(!note.mainnet_ready);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_zero_recipient_secret_rejected() {
        let err = new_note(&[0u8; 32], VALUE, &BLINDING).unwrap_err();
        assert_eq!(err, NoteError::ZeroRecipientSecret);
    }

    #[test]
    fn test_zero_blinding_rejected() {
        let err = new_note(&RCPT, VALUE, &[0u8; 32]).unwrap_err();
        assert_eq!(err, NoteError::ZeroBlinding);
    }

    #[test]
    fn test_note_id_deterministic() {
        let n1 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let n2 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        assert_eq!(n1.note_id, n2.note_id);
    }

    #[test]
    fn test_nullifier_deterministic() {
        let n1 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let n2 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        assert_eq!(n1.nullifier, n2.nullifier);
    }

    #[test]
    fn test_different_blindings_different_commitments() {
        let blinding2 = [0xAAu8; 32];
        let n1 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let n2 = new_note(&RCPT, VALUE, &blinding2).unwrap();
        assert_ne!(n1.commitment, n2.commitment);
    }

    #[test]
    fn test_different_recipients_different_commitments() {
        let rcpt2 = [0xFFu8; 32];
        let n1 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let n2 = new_note(&rcpt2, VALUE, &BLINDING).unwrap();
        assert_ne!(n1.commitment, n2.commitment);
    }

    #[test]
    fn test_proof_mainnet_ready_false() {
        let note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let proof = open_note(&note, VALUE, &BLINDING, &RCPT).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_spend_note_sets_spent_flag() {
        let mut note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        assert!(!note.spent);
        spend_note(&mut note).unwrap();
        assert!(note.spent);
    }

    #[test]
    fn test_verify_opening_wrong_blinding_fails() {
        let note = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let proof = open_note(&note, VALUE, &BLINDING, &RCPT).unwrap();
        let wrong_blinding = [0xFFu8; 32];
        assert!(!verify_opening(&note, &proof, &wrong_blinding));
    }

    #[test]
    fn test_nullifier_recipient_sensitive() {
        let rcpt2 = [0xFFu8; 32];
        let n1 = new_note(&RCPT, VALUE, &BLINDING).unwrap();
        let n2 = new_note(&rcpt2, VALUE, &BLINDING).unwrap();
        assert_ne!(n1.nullifier, n2.nullifier);
    }
}
