// dark-shielded-pool-core — note commitment scheme and Merkle-root tracking
// All state designed for on-chain PDA storage — no off-chain validators required.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use dark_poseidon_bn254::{note_commitment as poseidon_note_commitment, nullifier_hash};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub commitment: [u8; 32],
    pub value: u64,
    pub randomness: [u8; 32],
    pub recipient_hash: [u8; 32],
    pub deposited_at_slot: u64,
}

#[derive(Debug, Clone)]
pub struct NullifierRecord {
    pub nullifier: [u8; 32],
    pub spent_at_slot: u64,
    pub withdrawal_amount: u64,
}

#[derive(Debug, Clone)]
pub struct PoolState {
    pub merkle_root: [u8; 32],
    pub note_count: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub mainnet_ready: bool, // always false
}

impl Default for PoolState {
    fn default() -> Self {
        PoolState {
            merkle_root: [0u8; 32],
            note_count: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            mainnet_ready: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PoolError {
    NullifierAlreadySpent,
    InsufficientValue,
    InvalidCommitment,
    NoteNotFound,
    AmountOverflow,
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Build a `Note` with a computed commitment.
///
/// Commitment = `poseidon_bn254(DOMAIN_COMMITMENT || value_le || randomness || recipient_hash)`
/// delegated to `dark-poseidon-bn254::note_commitment`.
pub fn create_note(
    value: u64,
    randomness: &[u8; 32],
    recipient_hash: &[u8; 32],
    slot: u64,
) -> Note {
    let commitment = poseidon_note_commitment(value, randomness, recipient_hash);
    Note {
        commitment,
        value,
        randomness: *randomness,
        recipient_hash: *recipient_hash,
        deposited_at_slot: slot,
    }
}

/// Recompute the commitment from a note's fields and check it matches the stored one.
pub fn verify_note_commitment(note: &Note) -> bool {
    let expected = poseidon_note_commitment(note.value, &note.randomness, &note.recipient_hash);
    expected == note.commitment
}

/// Commitment accumulator standing in for a full Merkle tree in this devnet design.
///
/// `SHA256("pool-root-v1" || commitment_0 || commitment_1 || …)`
///
/// In production this would be a proper incremental Merkle tree whose root is
/// stored in a PDA.  For testing purposes a fold over all commitments suffices.
pub fn compute_merkle_root(commitments: &[[u8; 32]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"pool-root-v1");
    for c in commitments {
        hasher.update(c);
    }
    hasher.finalize().into()
}

/// Validate, create the note, add its commitment to the accumulator, and update pool state.
///
/// Returns the freshly created `Note` or a `PoolError`.
pub fn prepare_deposit(
    pool: &mut PoolState,
    value: u64,
    randomness: &[u8; 32],
    recipient_hash: &[u8; 32],
    slot: u64,
    existing_commitments: &mut Vec<[u8; 32]>,
) -> Result<Note, PoolError> {
    if value == 0 {
        return Err(PoolError::InsufficientValue);
    }

    let new_total = pool
        .total_deposited
        .checked_add(value)
        .ok_or(PoolError::AmountOverflow)?;

    let note = create_note(value, randomness, recipient_hash, slot);

    existing_commitments.push(note.commitment);
    pool.merkle_root = compute_merkle_root(existing_commitments);
    pool.note_count += 1;
    pool.total_deposited = new_total;

    Ok(note)
}

/// Verify the note is present in the commitment set, check the nullifier has not
/// been spent, then return `(nullifier, new_merkle_root)`.
///
/// The caller is responsible for appending the returned `NullifierRecord` to the
/// nullifier store (mirrors what an on-chain instruction handler would do with PDAs).
pub fn prepare_withdrawal(
    pool: &mut PoolState,
    note: &Note,
    secret: &[u8; 32],
    amount: u64,
    nullifier_records: &[NullifierRecord],
    existing_commitments: &[[u8; 32]],
) -> Result<([u8; 32], [u8; 32]), PoolError> {
    // 1. Commitment must be valid.
    if !verify_note_commitment(note) {
        return Err(PoolError::InvalidCommitment);
    }

    // 2. Note commitment must exist in the pool.
    if !existing_commitments.contains(&note.commitment) {
        return Err(PoolError::NoteNotFound);
    }

    // 3. Withdrawal amount must not exceed note value.
    if amount > note.value {
        return Err(PoolError::InsufficientValue);
    }

    // 4. Compute nullifier.
    let nullifier = nullifier_hash(&note.commitment, secret, &pool.merkle_root);

    // 5. Double-spend check.
    if is_nullifier_spent(&nullifier, nullifier_records) {
        return Err(PoolError::NullifierAlreadySpent);
    }

    // 6. Update pool state.
    let new_withdrawn = pool
        .total_withdrawn
        .checked_add(amount)
        .ok_or(PoolError::AmountOverflow)?;
    pool.total_withdrawn = new_withdrawn;

    // Root is unchanged by a withdrawal in this accumulator model; we recompute
    // to keep the value current with whatever commitments slice was passed in.
    let new_root = compute_merkle_root(existing_commitments);
    pool.merkle_root = new_root;

    Ok((nullifier, new_root))
}

/// Check whether a nullifier already exists in the nullifier store.
pub fn is_nullifier_spent(nullifier: &[u8; 32], records: &[NullifierRecord]) -> bool {
    records.iter().any(|r| &r.nullifier == nullifier)
}

/// Return a JSON summary of pool stats.
///
/// Never exposes raw note secrets or private fields.
pub fn pool_stats_json(pool: &PoolState) -> serde_json::Value {
    serde_json::json!({
        "merkle_root": hex_encode(&pool.merkle_root),
        "note_count": pool.note_count,
        "total_deposited": pool.total_deposited,
        "total_withdrawn": pool.total_withdrawn,
        "mainnet_ready": pool.mainnet_ready,
    })
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

    fn test_slot() -> u64 {
        100
    }

    fn test_randomness() -> [u8; 32] {
        [0xABu8; 32]
    }

    fn test_recipient() -> [u8; 32] {
        [0x11u8; 32]
    }

    fn test_secret() -> [u8; 32] {
        [0x99u8; 32]
    }

    // 1. create_note then verify_note_commitment returns true
    #[test]
    fn test_note_commitment_verifies() {
        let note = create_note(
            1_000_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
        );
        assert!(
            verify_note_commitment(&note),
            "fresh note commitment must verify"
        );
    }

    // 2. Mutate note.value → verify_note_commitment returns false
    #[test]
    fn test_wrong_value_invalidates_commitment() {
        let mut note = create_note(
            1_000_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
        );
        note.value += 1; // tamper
        assert!(
            !verify_note_commitment(&note),
            "tampered value must invalidate commitment"
        );
    }

    // 3. prepare_deposit increments total_deposited
    #[test]
    fn test_deposit_increments_pool() {
        let mut pool = PoolState::default();
        let mut commitments: Vec<[u8; 32]> = Vec::new();

        let value = 500_000_000u64;
        prepare_deposit(
            &mut pool,
            value,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .expect("deposit should succeed");

        assert_eq!(pool.total_deposited, value);
        assert_eq!(pool.note_count, 1);
        assert_eq!(commitments.len(), 1);
    }

    // 4. After prepare_withdrawal the nullifier is present in the records
    #[test]
    fn test_withdrawal_marks_nullifier() {
        let mut pool = PoolState::default();
        let mut commitments: Vec<[u8; 32]> = Vec::new();

        let note = prepare_deposit(
            &mut pool,
            1_000_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();

        let mut nullifier_records: Vec<NullifierRecord> = Vec::new();

        let (nullifier, _root) = prepare_withdrawal(
            &mut pool,
            &note,
            &test_secret(),
            1_000_000,
            &nullifier_records,
            &commitments,
        )
        .unwrap();

        // Caller would persist this record; we do so manually here.
        nullifier_records.push(NullifierRecord {
            nullifier,
            spent_at_slot: test_slot(),
            withdrawal_amount: 1_000_000,
        });

        assert!(is_nullifier_spent(&nullifier, &nullifier_records));
    }

    // 5. Same nullifier twice → NullifierAlreadySpent
    #[test]
    fn test_double_spend_rejected() {
        let mut pool = PoolState::default();
        let mut commitments: Vec<[u8; 32]> = Vec::new();

        let note = prepare_deposit(
            &mut pool,
            1_000_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();

        let mut nullifier_records: Vec<NullifierRecord> = Vec::new();

        let (nullifier, _root) = prepare_withdrawal(
            &mut pool,
            &note,
            &test_secret(),
            1_000_000,
            &nullifier_records,
            &commitments,
        )
        .unwrap();

        nullifier_records.push(NullifierRecord {
            nullifier,
            spent_at_slot: test_slot(),
            withdrawal_amount: 1_000_000,
        });

        // Second attempt must fail.
        let result = prepare_withdrawal(
            &mut pool,
            &note,
            &test_secret(),
            1_000_000,
            &nullifier_records,
            &commitments,
        );

        assert_eq!(result, Err(PoolError::NullifierAlreadySpent));
    }

    // 6. PoolState default has mainnet_ready = false
    #[test]
    fn test_pool_mainnet_ready_always_false() {
        let pool = PoolState::default();
        assert!(
            !pool.mainnet_ready,
            "mainnet_ready must always be false in devnet design"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_note_commitment_nonzero() {
        let note = create_note(
            1_000_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
        );
        assert_ne!(note.commitment, [0u8; 32]);
    }

    #[test]
    fn test_merkle_root_nonzero_after_deposit() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        prepare_deposit(
            &mut pool,
            500_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        assert_ne!(pool.merkle_root, [0u8; 32]);
    }

    #[test]
    fn test_merkle_root_changes_on_second_deposit() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        prepare_deposit(
            &mut pool,
            500_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        let root1 = pool.merkle_root;
        prepare_deposit(
            &mut pool,
            300_000,
            &[0xBBu8; 32],
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        assert_ne!(pool.merkle_root, root1);
    }

    #[test]
    fn test_pool_stats_json_mainnet_ready_false() {
        let pool = PoolState::default();
        let json = pool_stats_json(&pool);
        assert_eq!(json["mainnet_ready"], false);
    }

    #[test]
    fn test_deposit_zero_value_fails() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        let result = prepare_deposit(
            &mut pool,
            0,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        );
        assert_eq!(result, Err(PoolError::InsufficientValue));
    }

    #[test]
    fn test_pool_total_deposited_accumulates() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        prepare_deposit(
            &mut pool,
            100_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        prepare_deposit(
            &mut pool,
            200_000,
            &[0xBBu8; 32],
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        assert_eq!(pool.total_deposited, 300_000);
    }

    #[test]
    fn test_pool_note_count_accumulates() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        prepare_deposit(
            &mut pool,
            100_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        prepare_deposit(
            &mut pool,
            200_000,
            &[0xBBu8; 32],
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        assert_eq!(pool.note_count, 2);
    }

    #[test]
    fn test_withdrawal_exceeds_note_value_fails() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        let note = prepare_deposit(
            &mut pool,
            100_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        let result =
            prepare_withdrawal(&mut pool, &note, &test_secret(), 100_001, &[], &commitments);
        assert_eq!(result, Err(PoolError::InsufficientValue));
    }

    #[test]
    fn test_compute_merkle_root_empty_deterministic() {
        let r1 = compute_merkle_root(&[]);
        let r2 = compute_merkle_root(&[]);
        assert_eq!(r1, r2);
    }

    #[test]
    fn test_pool_stats_json_note_count() {
        let mut pool = PoolState::default();
        let mut commitments = Vec::new();
        prepare_deposit(
            &mut pool,
            500_000,
            &test_randomness(),
            &test_recipient(),
            test_slot(),
            &mut commitments,
        )
        .unwrap();
        let json = pool_stats_json(&pool);
        assert_eq!(json["note_count"], 1);
    }
}
