//! Dark Null Batch Auditor — RISC Zero zkVM guest skeleton.
//!
//! This program runs inside the RISC Zero zkVM. It:
//!   1. Reads a committed nullifier batch from the environment.
//!   2. Verifies no duplicate nullifiers.
//!   3. Verifies receipt DAG link continuity.
//!   4. Verifies relayer fee caps are respected.
//!   5. Outputs a public digest for on-chain verification via Bonsol.
//!
//! # Build
//! ```sh
//! curl -L https://risczero.com/install | bash
//! rzup install
//! cargo risczero build --manifest-path zkvm/dark_batch_auditor/Cargo.toml
//! ```
//!
//! # Wire up to Solana via Bonsol
//! ```sh
//! bonsol deploy --image-path ./target/riscv-guest/...
//! bonsol execute --image-id <ID> --input-file batch.json
//! ```

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

// ── Input types ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct BatchInput {
    /// Committed nullifiers in this batch.
    pub nullifiers: Vec<[u8; 32]>,
    /// Receipt DAG links: each entry is (parent_hash, child_hash).
    pub dag_links: Vec<([u8; 32], [u8; 32])>,
    /// Maximum allowed fee per operation in lamports.
    pub fee_cap_lamports: u64,
    /// Actual fees charged per operation.
    pub fees: Vec<u64>,
    /// Expected merkle root of the nullifier set.
    pub expected_root: [u8; 32],
}

// ── Output digest ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct BatchDigest {
    pub nullifier_count: usize,
    pub dag_link_count:  usize,
    pub max_fee_seen:    u64,
    /// SHA-256 of all nullifiers sorted — publicly verifiable.
    pub nullifier_set_hash: [u8; 32],
    pub cap_compliant:   bool,
}

// ── Guest logic ───────────────────────────────────────────────────────────────

pub fn audit_batch(input: &BatchInput) -> Result<BatchDigest, AuditError> {
    // 1. Duplicate nullifier check
    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    for n in &input.nullifiers {
        if !seen.insert(*n) {
            return Err(AuditError::DuplicateNullifier(*n));
        }
    }

    // 2. Receipt DAG continuity — each child's parent must appear in a prior link
    let mut known_hashes: HashSet<[u8; 32]> = HashSet::new();
    for (parent, child) in &input.dag_links {
        if !known_hashes.is_empty() && !known_hashes.contains(parent) {
            return Err(AuditError::DagLinkBroken(*parent));
        }
        known_hashes.insert(*parent);
        known_hashes.insert(*child);
    }

    // 3. Fee cap compliance
    let max_fee = input.fees.iter().copied().max().unwrap_or(0);
    let cap_compliant = input.fees.iter().all(|&f| f <= input.fee_cap_lamports);
    if !cap_compliant {
        return Err(AuditError::FeeCapExceeded(max_fee));
    }

    // 4. Compute public nullifier set hash
    let mut sorted: Vec<[u8; 32]> = input.nullifiers.clone();
    sorted.sort_unstable();
    let mut h = Sha256::new();
    for n in &sorted { h.update(n); }
    let nullifier_set_hash: [u8; 32] = h.finalize().into();

    Ok(BatchDigest {
        nullifier_count:    input.nullifiers.len(),
        dag_link_count:     input.dag_links.len(),
        max_fee_seen:       max_fee,
        nullifier_set_hash,
        cap_compliant:      true,
    })
}

#[derive(Debug)]
pub enum AuditError {
    DuplicateNullifier([u8; 32]),
    DagLinkBroken([u8; 32]),
    FeeCapExceeded(u64),
}

// ── Entry point (zkVM host calls this) ───────────────────────────────────────

fn main() {
    // In a real RISC Zero guest:
    //   let input: BatchInput = risc0_zkvm::guest::env::read();
    //   let digest = audit_batch(&input).expect("batch audit failed");
    //   risc0_zkvm::guest::env::commit(&digest);
    //
    // Stub for non-zkvm build:
    let stub = BatchInput {
        nullifiers: vec![[0u8; 32], [1u8; 32]],
        dag_links:  vec![([0u8; 32], [1u8; 32])],
        fee_cap_lamports: 100_000,
        fees: vec![50_000, 75_000],
        expected_root: [0u8; 32],
    };
    let digest = audit_batch(&stub).expect("stub audit failed");
    println!("batch digest: {:?}", digest);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn good_input() -> BatchInput {
        BatchInput {
            nullifiers: vec![[0u8; 32], [1u8; 32], [2u8; 32]],
            dag_links:  vec![([0u8; 32], [1u8; 32]), ([1u8; 32], [2u8; 32])],
            fee_cap_lamports: 100_000,
            fees: vec![50_000, 75_000, 90_000],
            expected_root: [0u8; 32],
        }
    }

    #[test]
    fn test_valid_batch_passes() {
        let digest = audit_batch(&good_input()).unwrap();
        assert_eq!(digest.nullifier_count, 3);
        assert!(digest.cap_compliant);
        assert_ne!(digest.nullifier_set_hash, [0u8; 32]);
    }

    #[test]
    fn test_duplicate_nullifier_rejected() {
        let mut input = good_input();
        input.nullifiers.push([0u8; 32]); // duplicate
        assert!(matches!(audit_batch(&input), Err(AuditError::DuplicateNullifier(_))));
    }

    #[test]
    fn test_fee_cap_exceeded_rejected() {
        let mut input = good_input();
        input.fees.push(200_000); // exceeds cap
        assert!(matches!(audit_batch(&input), Err(AuditError::FeeCapExceeded(_))));
    }

    #[test]
    fn test_nullifier_set_hash_stable() {
        let d1 = audit_batch(&good_input()).unwrap();
        let d2 = audit_batch(&good_input()).unwrap();
        assert_eq!(d1.nullifier_set_hash, d2.nullifier_set_hash);
    }
}
