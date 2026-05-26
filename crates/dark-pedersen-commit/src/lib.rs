use sha2::{Digest, Sha256};

/// SHA256("pedersen-v1" || value_le || blinding_le)
#[derive(Debug, Clone, PartialEq)]
pub struct PedersenCommitment {
    pub commitment: [u8; 32],
    pub mainnet_ready: bool,
}

/// XOR-fold homomorphic addition simulation of two commitments.
#[derive(Debug, Clone)]
pub struct CommitmentSum {
    /// XOR of commitment_a and commitment_b (homomorphic addition simulation)
    pub combined: [u8; 32],
    /// SHA256("pedersen-sum-v1" || commitment_a || commitment_b)
    pub sum_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenedCommitment {
    pub value: u64,
    pub blinding: [u8; 32],
    pub commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum CommitmentError {
    BlindingZero,
    OpeningMismatch,
    SumMismatch,
}

fn compute_commitment(value: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"pedersen-v1");
    hasher.update(value.to_le_bytes());
    hasher.update(blinding);
    hasher.finalize().into()
}

/// Commit to a value with a blinding factor.
///
/// Returns `CommitmentError::BlindingZero` if `blinding` is all zeros.
/// The commitment is SHA256("pedersen-v1" || value_le || blinding).
pub fn commit(value: u64, blinding: &[u8; 32]) -> Result<PedersenCommitment, CommitmentError> {
    if blinding == &[0u8; 32] {
        return Err(CommitmentError::BlindingZero);
    }
    let commitment = compute_commitment(value, blinding);
    Ok(PedersenCommitment {
        commitment,
        mainnet_ready: false,
    })
}

/// Open a commitment, verifying that the stored hash matches the recomputed one.
///
/// Returns `CommitmentError::OpeningMismatch` if the recomputed hash does not
/// match the commitment stored in `commitment`.
pub fn open_commitment(
    commitment: &PedersenCommitment,
    value: u64,
    blinding: &[u8; 32],
) -> Result<OpenedCommitment, CommitmentError> {
    let recomputed = compute_commitment(value, blinding);
    if recomputed != commitment.commitment {
        return Err(CommitmentError::OpeningMismatch);
    }
    Ok(OpenedCommitment {
        value,
        blinding: *blinding,
        commitment: commitment.commitment,
        mainnet_ready: false,
    })
}

/// Homomorphic addition simulation: XOR-combine two commitments.
///
/// `combined` = byte-wise XOR of `a.commitment` and `b.commitment`.
/// `sum_hash`  = SHA256("pedersen-sum-v1" || a.commitment || b.commitment).
pub fn add_commitments(a: &PedersenCommitment, b: &PedersenCommitment) -> CommitmentSum {
    let mut combined = [0u8; 32];
    for i in 0..32 {
        combined[i] = a.commitment[i] ^ b.commitment[i];
    }

    let mut hasher = Sha256::new();
    hasher.update(b"pedersen-sum-v1");
    hasher.update(a.commitment);
    hasher.update(b.commitment);
    let sum_hash: [u8; 32] = hasher.finalize().into();

    CommitmentSum {
        combined,
        sum_hash,
        mainnet_ready: false,
    }
}

/// Verify that a `CommitmentSum` is consistent with the two source commitments.
///
/// Recomputes both `combined` (XOR) and `sum_hash`, and checks both match
/// the values stored in `sum`.
pub fn verify_sum(sum: &CommitmentSum, a: &PedersenCommitment, b: &PedersenCommitment) -> bool {
    let mut expected_combined = [0u8; 32];
    for i in 0..32 {
        expected_combined[i] = a.commitment[i] ^ b.commitment[i];
    }

    let mut hasher = Sha256::new();
    hasher.update(b"pedersen-sum-v1");
    hasher.update(a.commitment);
    hasher.update(b.commitment);
    let expected_sum_hash: [u8; 32] = hasher.finalize().into();

    sum.combined == expected_combined && sum.sum_hash == expected_sum_hash
}

/// Return a JSON public record of the commitment.
///
/// Contains only the commitment hex and `mainnet_ready`; value and blinding
/// are intentionally omitted to preserve hiding.
pub fn commitment_public_record(c: &PedersenCommitment) -> String {
    let hex: String = c.commitment.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "commitment": hex,
        "mainnet_ready": c.mainnet_ready,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blinding(seed: u8) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[0] = seed;
        b[1] = seed.wrapping_add(1);
        b
    }

    #[test]
    fn test_commit_and_open_happy_path() {
        let value = 42u64;
        let blind = blinding(7);
        let commitment = commit(value, &blind).expect("commit should succeed");
        let opened = open_commitment(&commitment, value, &blind).expect("open should succeed");
        assert_eq!(opened.value, value);
        assert_eq!(opened.blinding, blind);
        assert_eq!(opened.commitment, commitment.commitment);
        assert!(!opened.mainnet_ready);
    }

    #[test]
    fn test_wrong_blinding_fails_open() {
        let value = 100u64;
        let blind = blinding(1);
        let wrong_blind = blinding(2);
        let commitment = commit(value, &blind).expect("commit should succeed");
        let result = open_commitment(&commitment, value, &wrong_blind);
        assert_eq!(result, Err(CommitmentError::OpeningMismatch));
    }

    #[test]
    fn test_zero_blinding_rejected() {
        let result = commit(0u64, &[0u8; 32]);
        assert_eq!(result, Err(CommitmentError::BlindingZero));
    }

    #[test]
    fn test_add_commitments_and_verify() {
        let blind_a = blinding(3);
        let blind_b = blinding(5);
        let c_a = commit(10u64, &blind_a).expect("commit a");
        let c_b = commit(20u64, &blind_b).expect("commit b");
        let sum = add_commitments(&c_a, &c_b);
        assert!(verify_sum(&sum, &c_a, &c_b));
        assert!(!sum.mainnet_ready);
    }

    #[test]
    fn test_different_values_different_commitments() {
        let blind = blinding(9);
        let c1 = commit(1u64, &blind).expect("commit 1");
        let c2 = commit(2u64, &blind).expect("commit 2");
        assert_ne!(
            c1.commitment, c2.commitment,
            "different values must produce different commitments"
        );
    }

    #[test]
    fn test_public_record_hides_value() {
        let value = 99999u64;
        let blind = blinding(11);
        let commitment = commit(value, &blind).expect("commit");
        let record = commitment_public_record(&commitment);
        // The record must not contain the literal decimal value
        assert!(
            !record.contains(&value.to_string()),
            "public record must not expose the value"
        );
        // Sanity: record contains the commitment field
        assert!(record.contains("commitment"));
        assert!(record.contains("mainnet_ready"));
    }
}
