use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A shielded token note whose balance is hidden inside a SHA-256 commitment.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenNote {
    /// SHA256("token-note-v1" || amount_le || owner_hash || nonce)
    pub commitment: [u8; 32],
    /// SHA256("token-owner-v1" || owner_secret)
    pub owner_hash: [u8; 32],
    pub mainnet_ready: bool,
}

/// Evidence of a shielded transfer: nullifies the input note and creates a
/// new output commitment for the recipient.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenTransfer {
    /// Nullifier for input note: SHA256("token-null-v1" || input_commitment || owner_hash)
    pub input_nullifier: [u8; 32],
    /// New commitment for recipient
    pub output_commitment: [u8; 32],
    /// SHA256("transfer-proof-v1" || input_nullifier || output_commitment)
    pub transfer_proof: [u8; 32],
    pub mainnet_ready: bool,
}

/// On-chain public ledger: tracks commitment set and spent nullifiers without
/// revealing individual amounts or owners.
#[derive(Debug, Clone)]
pub struct ShieldedLedger {
    pub commitment_count: u32,
    spent_nullifiers: Vec<[u8; 32]>,
    commitments: Vec<[u8; 32]>,
    mainnet_ready: bool,
}

/// Errors returned by token operations.
#[derive(Debug, PartialEq)]
pub enum TokenError {
    ZeroAmount,
    OwnerSecretZero,
    NullifierAlreadySpent,
    CommitmentNotFound,
    OwnershipMismatch,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn sha256_hash(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

fn compute_owner_hash(owner_secret: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(16 + 32);
    input.extend_from_slice(b"token-owner-v1");
    input.extend_from_slice(owner_secret);
    sha256_hash(&input)
}

fn compute_commitment(amount: u64, owner_hash: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(14 + 8 + 32 + 32);
    input.extend_from_slice(b"token-note-v1");
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(owner_hash);
    input.extend_from_slice(nonce);
    sha256_hash(&input)
}

fn compute_nullifier(commitment: &[u8; 32], owner_hash: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(14 + 32 + 32);
    input.extend_from_slice(b"token-null-v1");
    input.extend_from_slice(commitment);
    input.extend_from_slice(owner_hash);
    sha256_hash(&input)
}

fn compute_transfer_proof(input_nullifier: &[u8; 32], output_commitment: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(18 + 32 + 32);
    input.extend_from_slice(b"transfer-proof-v1");
    input.extend_from_slice(input_nullifier);
    input.extend_from_slice(output_commitment);
    sha256_hash(&input)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Mint a new shielded note.
///
/// Returns `ZeroAmount` if `amount == 0`.
/// Returns `OwnerSecretZero` if `owner_secret` is the all-zero array.
pub fn mint_note(
    owner_secret: &[u8; 32],
    amount: u64,
    nonce: &[u8; 32],
) -> Result<TokenNote, TokenError> {
    if amount == 0 {
        return Err(TokenError::ZeroAmount);
    }
    if owner_secret == &[0u8; 32] {
        return Err(TokenError::OwnerSecretZero);
    }

    let owner_hash = compute_owner_hash(owner_secret);
    let commitment = compute_commitment(amount, &owner_hash, nonce);

    Ok(TokenNote {
        commitment,
        owner_hash,
        mainnet_ready: false,
    })
}

/// Create an empty shielded ledger.
pub fn new_ledger() -> ShieldedLedger {
    ShieldedLedger {
        commitment_count: 0,
        spent_nullifiers: Vec::new(),
        commitments: Vec::new(),
        mainnet_ready: false,
    }
}

/// Register a commitment on the ledger (e.g. after a mint).
pub fn add_commitment(ledger: &mut ShieldedLedger, commitment: [u8; 32]) {
    ledger.commitments.push(commitment);
    ledger.commitment_count += 1;
}

/// Execute a shielded transfer.
///
/// Verifies that:
/// - `input.commitment` is in the ledger (`CommitmentNotFound`)
/// - `owner_secret` recomputes to `input.owner_hash` (`OwnershipMismatch`)
/// - The derived nullifier has not been spent (`NullifierAlreadySpent`)
///
/// On success: removes the input commitment from the ledger, adds the output
/// commitment, records the nullifier as spent, and returns a `TokenTransfer`.
pub fn transfer_note(
    ledger: &mut ShieldedLedger,
    input: &TokenNote,
    owner_secret: &[u8; 32],
    recipient_owner_hash: &[u8; 32],
    recipient_nonce: &[u8; 32],
    amount: u64,
) -> Result<TokenTransfer, TokenError> {
    // 1. Commitment must exist in the ledger.
    let commitment_pos = ledger
        .commitments
        .iter()
        .position(|c| c == &input.commitment)
        .ok_or(TokenError::CommitmentNotFound)?;

    // 2. Verify ownership.
    let owner_hash = compute_owner_hash(owner_secret);
    if owner_hash != input.owner_hash {
        return Err(TokenError::OwnershipMismatch);
    }

    // 3. Derive nullifier and check for double-spend.
    let input_nullifier = compute_nullifier(&input.commitment, &owner_hash);
    if ledger.spent_nullifiers.contains(&input_nullifier) {
        return Err(TokenError::NullifierAlreadySpent);
    }

    // 4. Build output commitment.
    let output_commitment = compute_commitment(amount, recipient_owner_hash, recipient_nonce);

    // 5. Build transfer proof.
    let transfer_proof = compute_transfer_proof(&input_nullifier, &output_commitment);

    // 6. Update ledger state: remove input, add output, record nullifier.
    ledger.commitments.remove(commitment_pos);
    ledger.commitments.push(output_commitment);
    // commitment_count tracks total ever added; add one for the new output.
    ledger.commitment_count += 1;
    ledger.spent_nullifiers.push(input_nullifier);

    Ok(TokenTransfer {
        input_nullifier,
        output_commitment,
        transfer_proof,
        mainnet_ready: false,
    })
}

/// Return a JSON string with public ledger statistics.
///
/// The individual commitment bytes are intentionally omitted to preserve
/// privacy — only aggregate counts are exposed.
pub fn ledger_public_record(ledger: &ShieldedLedger) -> String {
    serde_json::json!({
        "commitment_count": ledger.commitment_count,
        "nullifier_count": ledger.spent_nullifiers.len(),
        "mainnet_ready": ledger.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_secret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xAB;
        s
    }

    fn nonce(seed: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = seed;
        n
    }

    // 1. Happy path: mint -> add to ledger -> transfer succeeds.
    #[test]
    fn test_mint_and_transfer_happy_path() {
        let secret = owner_secret();
        let note = mint_note(&secret, 1_000, &nonce(1)).expect("mint should succeed");

        let mut ledger = new_ledger();
        add_commitment(&mut ledger, note.commitment);

        let recipient_owner_hash = compute_owner_hash(&{
            let mut r = [0u8; 32];
            r[0] = 0xCC;
            r
        });

        let transfer = transfer_note(
            &mut ledger,
            &note,
            &secret,
            &recipient_owner_hash,
            &nonce(2),
            1_000,
        )
        .expect("transfer should succeed");

        // Transfer proof must be non-zero.
        assert_ne!(transfer.transfer_proof, [0u8; 32]);
        assert!(!transfer.mainnet_ready);
        // Nullifier recorded.
        assert_eq!(ledger.spent_nullifiers.len(), 1);
    }

    // 2. Double-spend: second transfer with the same note is rejected.
    #[test]
    fn test_double_spend_rejected() {
        let secret = owner_secret();
        let note = mint_note(&secret, 500, &nonce(1)).expect("mint");

        let mut ledger = new_ledger();
        add_commitment(&mut ledger, note.commitment);

        let recip_hash = compute_owner_hash(&{
            let mut r = [0u8; 32];
            r[0] = 0xDD;
            r
        });

        // First transfer succeeds and produces a new output note.
        let first = transfer_note(&mut ledger, &note, &secret, &recip_hash, &nonce(2), 500)
            .expect("first transfer");

        // Re-add the original commitment to simulate an attacker replaying it.
        ledger.commitments.push(note.commitment);

        // The nullifier is already spent — must be rejected.
        let second = transfer_note(&mut ledger, &note, &secret, &recip_hash, &nonce(3), 500);
        assert_eq!(second, Err(TokenError::NullifierAlreadySpent));

        // Ensure first transfer was valid.
        assert_ne!(first.input_nullifier, [0u8; 32]);
    }

    // 3. Wrong owner: transfer with incorrect owner_secret is rejected.
    #[test]
    fn test_wrong_owner_rejected() {
        let secret = owner_secret();
        let note = mint_note(&secret, 250, &nonce(1)).expect("mint");

        let mut ledger = new_ledger();
        add_commitment(&mut ledger, note.commitment);

        let mut wrong_secret = secret;
        wrong_secret[1] = 0xFF;

        let recip_hash = compute_owner_hash(&{
            let mut r = [0u8; 32];
            r[0] = 0xEE;
            r
        });

        let result = transfer_note(
            &mut ledger,
            &note,
            &wrong_secret,
            &recip_hash,
            &nonce(2),
            250,
        );
        assert_eq!(result, Err(TokenError::OwnershipMismatch));
    }

    // 4. Commitment not in ledger: transfer without prior add_commitment fails.
    #[test]
    fn test_commitment_not_in_ledger_rejected() {
        let secret = owner_secret();
        let note = mint_note(&secret, 100, &nonce(1)).expect("mint");

        let mut ledger = new_ledger(); // note intentionally not added

        let recip_hash = compute_owner_hash(&{
            let mut r = [0u8; 32];
            r[0] = 0x01;
            r
        });

        let result = transfer_note(&mut ledger, &note, &secret, &recip_hash, &nonce(2), 100);
        assert_eq!(result, Err(TokenError::CommitmentNotFound));
    }

    // 5. Zero amount: mint with amount == 0 returns ZeroAmount.
    #[test]
    fn test_zero_amount_rejected() {
        let secret = owner_secret();
        let result = mint_note(&secret, 0, &nonce(1));
        assert_eq!(result, Err(TokenError::ZeroAmount));
    }

    // 6. Public ledger record hides individual commitment values.
    #[test]
    fn test_ledger_record_hides_commitments() {
        let secret = owner_secret();
        let note = mint_note(&secret, 777, &nonce(1)).expect("mint");

        let mut ledger = new_ledger();
        add_commitment(&mut ledger, note.commitment);

        let record = ledger_public_record(&ledger);

        // The record must be valid JSON with expected keys.
        let v: serde_json::Value = serde_json::from_str(&record).expect("valid json");
        assert_eq!(v["commitment_count"], 1);
        assert_eq!(v["nullifier_count"], 0);
        assert_eq!(v["mainnet_ready"], false);

        // The individual commitment bytes must NOT appear in the public record.
        let commitment_hex = hex_encode(&note.commitment);
        assert!(
            !record.contains(&commitment_hex),
            "public record must not expose individual commitment bytes"
        );
    }

    /// Minimal hex encoder so we don't need an extra dependency in tests.
    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_commitment_nonzero() {
        let note = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        assert_ne!(note.commitment, [0u8; 32]);
    }

    #[test]
    fn test_owner_hash_nonzero() {
        let note = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        assert_ne!(note.owner_hash, [0u8; 32]);
    }

    #[test]
    fn test_commitment_deterministic() {
        let n1 = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        let n2 = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        assert_eq!(n1.commitment, n2.commitment);
    }

    #[test]
    fn test_commitment_nonce_sensitive() {
        let n1 = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        let n2 = mint_note(&owner_secret(), 100, &nonce(2)).unwrap();
        assert_ne!(n1.commitment, n2.commitment);
    }

    #[test]
    fn test_commitment_amount_sensitive() {
        let n1 = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        let n2 = mint_note(&owner_secret(), 200, &nonce(1)).unwrap();
        assert_ne!(n1.commitment, n2.commitment);
    }

    #[test]
    fn test_note_mainnet_ready_false() {
        let note = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        assert!(!note.mainnet_ready);
    }

    #[test]
    fn test_owner_secret_zero_rejected() {
        let err = mint_note(&[0u8; 32], 100, &nonce(1)).unwrap_err();
        assert_eq!(err, TokenError::OwnerSecretZero);
    }

    #[test]
    fn test_ledger_starts_empty() {
        let ledger = new_ledger();
        assert_eq!(ledger.commitment_count, 0);
    }

    #[test]
    fn test_add_commitment_increments_count() {
        let mut ledger = new_ledger();
        let note = mint_note(&owner_secret(), 100, &nonce(1)).unwrap();
        add_commitment(&mut ledger, note.commitment);
        assert_eq!(ledger.commitment_count, 1);
        add_commitment(&mut ledger, note.commitment); // duplicates allowed in add_commitment
        assert_eq!(ledger.commitment_count, 2);
    }

    #[test]
    fn test_transfer_proof_nonzero() {
        let secret = owner_secret();
        let note = mint_note(&secret, 500, &nonce(5)).unwrap();
        let mut ledger = new_ledger();
        add_commitment(&mut ledger, note.commitment);
        let recip_hash = compute_owner_hash(&{
            let mut r = [0xFFu8; 32];
            r[0] = 0x01;
            r
        });
        let transfer =
            transfer_note(&mut ledger, &note, &secret, &recip_hash, &nonce(6), 500).unwrap();
        assert_ne!(transfer.transfer_proof, [0u8; 32]);
    }
}
