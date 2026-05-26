// dark-shielded-client — three-function SDK for note creation and withdrawal
// create_note → generate_withdrawal_proof → build_withdraw_instruction
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use dark_poseidon_bn254::{nullifier_hash, poseidon_bn254, DOMAIN_NOTE};
use dark_shielded_pool_core::{
    create_note as core_create_note, verify_note_commitment, Note, PoolError,
};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Derive deterministic randomness from a user secret and a slot.
///
/// `SHA256("dark-randomness-v1" || secret || slot_le)`
///
/// This means a user only needs to remember their secret + the deposit slot to
/// reconstruct any note they created.
pub fn derive_randomness(secret: &[u8; 32], slot: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"dark-randomness-v1");
    hasher.update(secret);
    hasher.update(slot.to_le_bytes());
    hasher.finalize().into()
}

/// Create a shielded note from a user secret.
///
/// Randomness is deterministically derived from `(secret, slot)` so the user
/// can reconstruct the note later without storing it off-chain.
pub fn create_note_from_secret(
    secret: &[u8; 32],
    value: u64,
    recipient_hash: &[u8; 32],
    slot: u64,
) -> Note {
    let randomness = derive_randomness(secret, slot);
    core_create_note(value, &randomness, recipient_hash, slot)
}

/// Produce the withdrawal data bundle for a note.
///
/// Returns `(nullifier, withdraw_root, proof_inputs_json)`.
///
/// `proof_inputs_json` carries all public inputs needed by an on-chain verifier
/// but **never** includes raw secret bytes.
pub fn generate_withdrawal_note_data(
    note: &Note,
    secret: &[u8; 32],
    amount: u64,
    current_root: &[u8; 32],
) -> Result<([u8; 32], [u8; 32], serde_json::Value), PoolError> {
    // Sanity checks.
    if !verify_note_commitment(note) {
        return Err(PoolError::InvalidCommitment);
    }
    if amount > note.value {
        return Err(PoolError::InsufficientValue);
    }

    // Derive a secret key from the user secret (never expose raw secret in JSON).
    let _key = poseidon_bn254(DOMAIN_NOTE, &[secret.as_slice()]);

    // Compute nullifier.
    let nullifier = nullifier_hash(&note.commitment, secret, current_root);

    // The withdrawal root is the current root in this devnet model.
    let withdraw_root = *current_root;

    // Build public-inputs JSON — no raw secrets included.
    let proof_inputs = serde_json::json!({
        "nullifier":       hex_encode(&nullifier),
        "merkle_root":     hex_encode(current_root),
        "note_commitment": hex_encode(&note.commitment),
        "amount":          amount,
        "recipient_hash":  hex_encode(&note.recipient_hash),
        "deposited_at_slot": note.deposited_at_slot,
        "mainnet_ready":   false,
    });

    Ok((nullifier, withdraw_root, proof_inputs))
}

/// Pack withdrawal fields into a 104-byte instruction data blob.
///
/// Layout: nullifier(32) || merkle_root(32) || amount_le(8) || note_commitment(32) = 104 bytes
pub fn build_withdraw_instruction_data(
    nullifier: &[u8; 32],
    merkle_root: &[u8; 32],
    amount: u64,
    note_commitment: &[u8; 32],
) -> [u8; 104] {
    let mut out = [0u8; 104];
    out[0..32].copy_from_slice(nullifier);
    out[32..64].copy_from_slice(merkle_root);
    out[64..72].copy_from_slice(&amount.to_le_bytes());
    out[72..104].copy_from_slice(note_commitment);
    out
}

/// Inverse of `build_withdraw_instruction_data`.
///
/// Returns `(nullifier, merkle_root, amount, note_commitment)`.
pub fn parse_withdraw_instruction_data(data: &[u8; 104]) -> ([u8; 32], [u8; 32], u64, [u8; 32]) {
    let mut nullifier = [0u8; 32];
    let mut merkle_root = [0u8; 32];
    let mut amount_bytes = [0u8; 8];
    let mut note_commitment = [0u8; 32];

    nullifier.copy_from_slice(&data[0..32]);
    merkle_root.copy_from_slice(&data[32..64]);
    amount_bytes.copy_from_slice(&data[64..72]);
    note_commitment.copy_from_slice(&data[72..104]);

    let amount = u64::from_le_bytes(amount_bytes);
    (nullifier, merkle_root, amount, note_commitment)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_secret() -> [u8; 32] {
        [0x42u8; 32]
    }

    fn test_recipient() -> [u8; 32] {
        [0xBBu8; 32]
    }

    fn test_slot() -> u64 {
        777
    }

    fn test_root() -> [u8; 32] {
        [0x55u8; 32]
    }

    // 1. Same secret + slot always produces the same note commitment.
    #[test]
    fn test_create_note_from_secret_deterministic() {
        let note_a =
            create_note_from_secret(&test_secret(), 500_000, &test_recipient(), test_slot());
        let note_b =
            create_note_from_secret(&test_secret(), 500_000, &test_recipient(), test_slot());
        assert_eq!(
            note_a.commitment, note_b.commitment,
            "same inputs must yield same commitment"
        );
    }

    // 2. Pack → unpack recovers all four fields exactly.
    #[test]
    fn test_withdrawal_data_roundtrip() {
        let note =
            create_note_from_secret(&test_secret(), 1_000_000, &test_recipient(), test_slot());
        let amount = 1_000_000u64;
        let root = test_root();

        let (nullifier, withdraw_root, _json) =
            generate_withdrawal_note_data(&note, &test_secret(), amount, &root).unwrap();

        let packed =
            build_withdraw_instruction_data(&nullifier, &withdraw_root, amount, &note.commitment);
        let (p_nullifier, p_root, p_amount, p_commitment) =
            parse_withdraw_instruction_data(&packed);

        assert_eq!(p_nullifier, nullifier);
        assert_eq!(p_root, withdraw_root);
        assert_eq!(p_amount, amount);
        assert_eq!(p_commitment, note.commitment);
    }

    // 3. Requesting amount > note.value returns InsufficientValue.
    #[test]
    fn test_withdrawal_amount_exceeds_value_errors() {
        let value = 100_000u64;
        let note = create_note_from_secret(&test_secret(), value, &test_recipient(), test_slot());
        let root = test_root();

        let result = generate_withdrawal_note_data(&note, &test_secret(), value + 1, &root);
        assert_eq!(result, Err(PoolError::InsufficientValue));
    }

    // 4. The proof_inputs_json must not contain the raw secret bytes.
    #[test]
    fn test_note_secret_not_in_json() {
        let secret = test_secret();
        let note = create_note_from_secret(&secret, 250_000, &test_recipient(), test_slot());
        let root = test_root();

        let (_nullifier, _root, json) =
            generate_withdrawal_note_data(&note, &secret, 250_000, &root).unwrap();

        let json_str = json.to_string();
        let secret_hex = secret
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>();

        assert!(
            !json_str.contains(&secret_hex),
            "JSON must not contain raw secret bytes"
        );
    }

    // 5. Same secret, different slot → different randomness.
    #[test]
    fn test_derive_randomness_slot_dependent() {
        let secret = test_secret();
        let r1 = derive_randomness(&secret, 100);
        let r2 = derive_randomness(&secret, 101);
        assert_ne!(r1, r2, "different slot must produce different randomness");
    }
}
