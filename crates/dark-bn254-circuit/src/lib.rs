// dark-bn254-circuit — BN254 Groth16 withdrawal circuit specification
// Constraint logic mirrors what an arkworks circuit would enforce.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use dark_poseidon_bn254::{note_commitment, nullifier_hash};

/// All inputs required to produce and verify a withdrawal proof.
///
/// Public inputs (`merkle_root`, `nullifier`, `withdraw_amount`) are embedded
/// in the Groth16 proof statement.  The private witnesses are known only to the
/// prover and are never transmitted on-chain.
#[derive(Debug, Clone)]
pub struct WithdrawCircuitInputs {
    // ---- Public inputs (go into the proof) ----
    pub merkle_root: [u8; 32],
    pub nullifier: [u8; 32],
    pub withdraw_amount: u64,
    // ---- Private witnesses (known only to prover) ----
    pub note_value: u64,
    pub note_randomness: [u8; 32],
    pub note_secret: [u8; 32],
    pub recipient_hash: [u8; 32],
}

/// The three public inputs committed to inside the Groth16 proof.
#[derive(Debug, Clone, PartialEq)]
pub struct CircuitPublicInputs {
    pub merkle_root: [u8; 32],
    pub nullifier: [u8; 32],
    pub withdraw_amount: u64,
}

/// Errors that can be returned by [`simulate_verify`].
#[derive(Debug, Clone, PartialEq)]
pub enum CircuitError {
    /// `withdraw_amount > note_value` — the note does not cover the withdrawal.
    Underflow,
    /// The nullifier re-derived inside the circuit does not match the supplied
    /// public input.
    NullifierMismatch,
    /// The note commitment re-derived from the witnesses does not match the
    /// value used when computing the nullifier.
    CommitmentMismatch,
    /// Amount exceeds `u64::MAX` (overflow sanity check — always false in Rust,
    /// but kept for parity with the on-chain constraint).
    AmountOverflow,
}

/// Extract the three public inputs that will be committed to in the proof.
pub fn extract_public_inputs(inputs: &WithdrawCircuitInputs) -> CircuitPublicInputs {
    CircuitPublicInputs {
        merkle_root: inputs.merkle_root,
        nullifier: inputs.nullifier,
        withdraw_amount: inputs.withdraw_amount,
    }
}

/// Simulate the circuit constraint checks without a proving key.
///
/// This mirrors the four constraints enforced by the BN254 Groth16 circuit:
///
/// 1. `withdraw_amount <= note_value`  (no underflow / over-spend)
/// 2. `computed_commitment == note_commitment(note_value, note_randomness, recipient_hash)`
/// 3. `computed_nullifier == nullifier_hash(computed_commitment, note_secret, merkle_root)`
/// 4. `inputs.nullifier == computed_nullifier`  (public input consistency)
///
/// Returns `Ok(CircuitPublicInputs)` when all constraints pass, or the first
/// failing `Err(CircuitError)`.
pub fn simulate_verify(
    inputs: &WithdrawCircuitInputs,
) -> Result<CircuitPublicInputs, CircuitError> {
    // Constraint 1 — no underflow
    if inputs.withdraw_amount > inputs.note_value {
        return Err(CircuitError::Underflow);
    }

    // Constraint 2 — commitment is well-formed from the witnesses
    let computed_commitment = note_commitment(
        inputs.note_value,
        &inputs.note_randomness,
        &inputs.recipient_hash,
    );

    // Constraints 3 & 4 — nullifier is correctly derived and matches public input
    let computed_nullifier = nullifier_hash(
        &computed_commitment,
        &inputs.note_secret,
        &inputs.merkle_root,
    );

    if computed_nullifier != inputs.nullifier {
        // Distinguish the two failure modes so callers can surface meaningful
        // diagnostics.  A CommitmentMismatch is detectable when the nullifier
        // would have matched if the commitment had been correct; since we
        // cannot know that here without the "expected" commitment, we surface
        // NullifierMismatch as the canonical error for any nullifier divergence
        // (the circuit itself would flag CommitmentMismatch at constraint 2 via
        // a separate wire equality gate, but in this simulation layer we roll
        // both into the nullifier check path).
        return Err(CircuitError::NullifierMismatch);
    }

    Ok(extract_public_inputs(inputs))
}

/// Human-readable description of each constraint enforced by the circuit.
///
/// Intended for documentation generation and audit tooling.
pub fn circuit_constraints_description() -> Vec<&'static str> {
    vec![
        "C1: withdraw_amount <= note_value  (no over-spend / underflow)",
        "C2: commitment == SHA256(DOMAIN_COMMITMENT || note_value_le || note_randomness || recipient_hash)",
        "C3: nullifier  == SHA256(DOMAIN_NULLIFIER  || commitment || note_secret || merkle_root)",
        "C4: public_input.nullifier == nullifier  (public input consistency with witness)",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a canonical valid set of circuit inputs for reuse across tests.
    fn valid_inputs() -> WithdrawCircuitInputs {
        let note_value: u64 = 10_000_000;
        let withdraw_amount: u64 = 5_000_000;
        let note_randomness = [0x42u8; 32];
        let note_secret = [0x99u8; 32];
        let recipient_hash = [0xBBu8; 32];
        let merkle_root = [0x55u8; 32];

        // Derive commitment and nullifier the same way the circuit would.
        let commitment = note_commitment(note_value, &note_randomness, &recipient_hash);
        let nullifier = nullifier_hash(&commitment, &note_secret, &merkle_root);

        WithdrawCircuitInputs {
            merkle_root,
            nullifier,
            withdraw_amount,
            note_value,
            note_randomness,
            note_secret,
            recipient_hash,
        }
    }

    #[test]
    fn test_valid_withdraw_passes() {
        let inputs = valid_inputs();
        let result = simulate_verify(&inputs);
        assert!(
            result.is_ok(),
            "valid inputs should pass: {:?}",
            result.err()
        );

        let pub_in = result.unwrap();
        assert_eq!(pub_in.merkle_root, inputs.merkle_root);
        assert_eq!(pub_in.nullifier, inputs.nullifier);
        assert_eq!(pub_in.withdraw_amount, inputs.withdraw_amount);
    }

    #[test]
    fn test_underflow_rejected() {
        let mut inputs = valid_inputs();
        // Make withdraw_amount exceed note_value
        inputs.withdraw_amount = inputs.note_value + 1;

        let result = simulate_verify(&inputs);
        assert_eq!(result, Err(CircuitError::Underflow));
    }

    #[test]
    fn test_nullifier_mismatch_rejected() {
        let mut inputs = valid_inputs();
        // Tamper the public nullifier — circuit must reject
        inputs.nullifier[0] ^= 0xFF;

        let result = simulate_verify(&inputs);
        assert_eq!(result, Err(CircuitError::NullifierMismatch));
    }

    #[test]
    fn test_commitment_mismatch_rejected() {
        let mut inputs = valid_inputs();
        // Change note_randomness — this corrupts the commitment, which breaks
        // the nullifier derivation chain, so the circuit sees a NullifierMismatch.
        inputs.note_randomness[0] ^= 0x01;

        let result = simulate_verify(&inputs);
        assert_eq!(
            result,
            Err(CircuitError::NullifierMismatch),
            "wrong randomness should break nullifier derivation"
        );
    }

    #[test]
    fn test_public_inputs_extracted_correctly() {
        let inputs = valid_inputs();
        let pub_in = extract_public_inputs(&inputs);

        assert_eq!(pub_in.merkle_root, inputs.merkle_root);
        assert_eq!(pub_in.nullifier, inputs.nullifier);
        assert_eq!(pub_in.withdraw_amount, inputs.withdraw_amount);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_withdraw_zero_passes() {
        let mut inputs = valid_inputs();
        inputs.withdraw_amount = 0;
        // 0 <= note_value always — constraint 1 passes
        // Must rebuild nullifier because withdraw_amount is not in the nullifier derivation,
        // only in the public inputs. The nullifier from valid_inputs() is still correct.
        assert!(simulate_verify(&inputs).is_ok());
    }

    #[test]
    fn test_withdraw_equal_note_value_passes() {
        let note_value: u64 = 10_000_000;
        let note_randomness = [0x42u8; 32];
        let note_secret = [0x99u8; 32];
        let recipient_hash = [0xBBu8; 32];
        let merkle_root = [0x55u8; 32];

        let commitment = note_commitment(note_value, &note_randomness, &recipient_hash);
        let nullifier = nullifier_hash(&commitment, &note_secret, &merkle_root);

        let inputs = WithdrawCircuitInputs {
            merkle_root,
            nullifier,
            withdraw_amount: note_value, // exactly equal — not an underflow
            note_value,
            note_randomness,
            note_secret,
            recipient_hash,
        };
        assert!(simulate_verify(&inputs).is_ok());
    }

    #[test]
    fn test_secret_change_breaks_nullifier() {
        let mut inputs = valid_inputs();
        inputs.note_secret[0] ^= 0xFF;
        assert_eq!(
            simulate_verify(&inputs),
            Err(CircuitError::NullifierMismatch)
        );
    }

    #[test]
    fn test_merkle_root_change_breaks_nullifier() {
        let mut inputs = valid_inputs();
        inputs.merkle_root[0] ^= 0xFF;
        assert_eq!(
            simulate_verify(&inputs),
            Err(CircuitError::NullifierMismatch)
        );
    }

    #[test]
    fn test_recipient_hash_change_breaks_commitment_chain() {
        let mut inputs = valid_inputs();
        inputs.recipient_hash[0] ^= 0xFF;
        // Changing recipient_hash corrupts the commitment, which cascades to a wrong nullifier
        assert_eq!(
            simulate_verify(&inputs),
            Err(CircuitError::NullifierMismatch)
        );
    }

    #[test]
    fn test_extract_public_inputs_consistent_with_verify() {
        let inputs = valid_inputs();
        let from_extract = extract_public_inputs(&inputs);
        let from_verify = simulate_verify(&inputs).unwrap();
        assert_eq!(from_extract, from_verify);
    }

    #[test]
    fn test_constraints_description_has_four_entries() {
        let desc = circuit_constraints_description();
        assert_eq!(desc.len(), 4, "expected exactly 4 circuit constraints");
    }

    #[test]
    fn test_valid_nullifier_is_nonzero() {
        let inputs = valid_inputs();
        assert_ne!(inputs.nullifier, [0u8; 32]);
    }

    #[test]
    fn test_note_commitment_deterministic() {
        let c1 = note_commitment(100, &[0x01u8; 32], &[0x02u8; 32]);
        let c2 = note_commitment(100, &[0x01u8; 32], &[0x02u8; 32]);
        assert_eq!(c1, c2);
    }

    #[test]
    fn test_nullifier_hash_deterministic() {
        let commit = note_commitment(100, &[0x01u8; 32], &[0x02u8; 32]);
        let n1 = nullifier_hash(&commit, &[0x03u8; 32], &[0x04u8; 32]);
        let n2 = nullifier_hash(&commit, &[0x03u8; 32], &[0x04u8; 32]);
        assert_eq!(n1, n2);
    }

    #[test]
    fn test_public_inputs_contain_withdraw_amount() {
        let inputs = valid_inputs();
        let pub_in = extract_public_inputs(&inputs);
        assert_eq!(pub_in.withdraw_amount, inputs.withdraw_amount);
    }
}
