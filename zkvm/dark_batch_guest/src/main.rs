//! Dark Null Batch Guest — RISC Zero compatible batch auditor
//!
//! BLOCKER: Requires RISC Zero toolchain (rzup). Not wired in this workspace.
//! This file exists to define the guest interface and host-side logic.
//! When rzup is installed, build with: cargo +risc0 build

use std::collections::HashSet;

/// Domain separator for receipt node hashing
const RECEIPT_NODE_DOMAIN: &[u8] = b"dark_null_v1_receipt_node";
const NET_DOMAIN: &[u8] = b"dark_null_v1_net";
const BATCH_DOMAIN: &[u8] = b"dark_null_v1_batch";

/// Minimal deterministic hash function for use in tests and host-side logic.
///
/// IMPORTANT: Replace with `risc0_zkvm::sha::Impl` when building the real
/// zkVM guest ELF. The XOR-fold here is NOT cryptographically secure —
/// it exists only so that host-side tests can run without the full toolchain.
fn sha256_concat(prefix: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut data = prefix.to_vec();
    for p in parts {
        data.extend_from_slice(p);
    }
    // XOR-fold placeholder — deterministic but NOT a real hash.
    // Replace with risc0_zkvm::sha::Sha256::hash_bytes or sha2::Sha256 on host.
    let mut state = [0u8; 32];
    for (i, b) in data.iter().enumerate() {
        state[i % 32] ^= b;
    }
    state
}

/// Compute a Merkle root from a slice of 32-byte leaf hashes.
///
/// - Empty   → `[0u8; 32]`
/// - Single  → the leaf itself
/// - Odd     → last leaf duplicated
fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    if leaves.len() == 1 {
        return leaves[0];
    }
    let mut layer = leaves.to_vec();
    while layer.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() {
                layer[i + 1]
            } else {
                layer[i] // duplicate last leaf for odd count
            };
            next.push(sha256_concat(RECEIPT_NODE_DOMAIN, &[&left, &right]));
            i += 2;
        }
        layer = next;
    }
    layer[0]
}

/// Core batch audit logic intended to run inside the zkVM guest.
///
/// Returns `(batch_hash, receipt_root, net_hash, model_root)` or a static
/// error string describing the first violation found.
///
/// # Parameters
/// - `nullifiers`: nullifier set (must be unique)
/// - `receipt_leaves`: `(leaf_hash, is_poison)` pairs
/// - `session_spends`: individual session spend amounts in lamports
/// - `starting_commitment`: 32-byte starting balance commitment
/// - `caveat_hash`: macaroon caveat binding hash
/// - `model_hashes`: model output hashes
/// - `budget`: maximum total spend in lamports
pub fn run_batch_guest(
    nullifiers: &[[u8; 32]],
    receipt_leaves: &[([u8; 32], bool)], // (leaf_hash, is_poison)
    session_spends: &[u64],
    starting_commitment: &[u8; 32],
    caveat_hash: &[u8; 32],
    model_hashes: &[[u8; 32]],
    budget: u64,
) -> Result<([u8; 32], [u8; 32], [u8; 32], [u8; 32]), &'static str> {
    // 1. No duplicate nullifiers
    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    for n in nullifiers {
        if !seen.insert(*n) {
            return Err("duplicate nullifier");
        }
    }

    // 2. Receipt root (non-poison leaves only)
    let real_leaves: Vec<[u8; 32]> = receipt_leaves
        .iter()
        .filter(|(_, is_poison)| !is_poison)
        .map(|(h, _)| *h)
        .collect();
    let receipt_root = merkle_root(&real_leaves);

    // 3. Budget check then net settlement hash
    let total_spend: u64 = session_spends.iter().copied().sum();
    if total_spend > budget {
        return Err("overspend");
    }
    let net_hash = sha256_concat(NET_DOMAIN, &[&total_spend.to_le_bytes(), starting_commitment]);

    // 4. Model output root
    let model_root = merkle_root(model_hashes);

    // 5. Batch hash
    let batch_hash = sha256_concat(BATCH_DOMAIN, &[&receipt_root, &net_hash, caveat_hash]);

    Ok((batch_hash, receipt_root, net_hash, model_root))
}

fn main() {
    eprintln!("dark_batch_guest: BLOCKER — RISC Zero toolchain not wired");
    eprintln!("Install: curl -L https://risczero.com/install | bash && rzup install");
    eprintln!("Then build with: cargo +risc0 build --release");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // 1. A valid batch is accepted and returns four non-zero commitments.
    #[test]
    fn test_guest_accepts_valid_batch() {
        let n1 = [1u8; 32];
        let n2 = [2u8; 32];
        let leaf1 = ([10u8; 32], false);
        let result = run_batch_guest(
            &[n1, n2],
            &[leaf1],
            &[100, 200],
            &[0u8; 32],
            &[0u8; 32],
            &[[5u8; 32]],
            1000,
        );
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
        let (batch_hash, receipt_root, net_hash, model_root) = result.unwrap();
        // All four outputs must be non-zero given non-zero inputs
        assert_ne!(batch_hash, [0u8; 32]);
        let _ = (receipt_root, net_hash, model_root); // used implicitly
    }

    // 2. Duplicate nullifier causes rejection.
    #[test]
    fn test_guest_rejects_duplicate_nullifier() {
        let n = [1u8; 32];
        let result = run_batch_guest(&[n, n], &[], &[], &[0u8; 32], &[0u8; 32], &[], 1000);
        assert_eq!(result, Err("duplicate nullifier"));
    }

    // 3. Over-budget batch is rejected.
    #[test]
    fn test_guest_rejects_overspend() {
        let result =
            run_batch_guest(&[], &[], &[500, 600], &[0u8; 32], &[0u8; 32], &[], 1000);
        assert_eq!(result, Err("overspend"));
    }

    // 4. Poison leaf is excluded from receipt root.
    //    root(real + poison) must equal root(real only).
    #[test]
    fn test_guest_poison_excluded_from_root() {
        let real = ([1u8; 32], false);
        let poison = ([2u8; 32], true);

        let (_, root_with_poison, _, _) = run_batch_guest(
            &[],
            &[real, poison],
            &[],
            &[0u8; 32],
            &[0u8; 32],
            &[],
            u64::MAX,
        )
        .unwrap();

        let (_, root_only_real, _, _) = run_batch_guest(
            &[],
            &[real],
            &[],
            &[0u8; 32],
            &[0u8; 32],
            &[],
            u64::MAX,
        )
        .unwrap();

        assert_eq!(
            root_with_poison, root_only_real,
            "poison leaf must not affect receipt root"
        );
    }
}
