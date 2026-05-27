// dark-proof-of-innocence - non-membership proof for transaction sets
// Prove "I am NOT in set S" without revealing set contents.
// NOT_PRODUCTION - devnet design only - no audit - mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// A committed set of tainted / sanctioned transaction hashes.
#[derive(Debug, Clone, PartialEq)]
pub struct TaintedSet {
    /// Sorted list of tainted transaction hashes (lexicographic ascending).
    pub members: Vec<[u8; 32]>,
    /// SHA256("set-root-v1" || count_le4 || sorted(members))
    pub root: [u8; 32],
    /// Always false - devnet only, no audit.
    pub mainnet_ready: bool,
}

/// Describes where in the sorted set the candidate falls.
#[derive(Debug, Clone, PartialEq)]
pub enum WitnessPosition {
    /// candidate < all members - sentinel left = [0u8;32].
    BelowAll { right_neighbor: [u8; 32] },
    /// candidate > all members - sentinel right = [0xFFu8;32].
    AboveAll { left_neighbor: [u8; 32] },
    /// left_neighbor < candidate < right_neighbor, both in set, adjacent.
    Between {
        left_neighbor: [u8; 32],
        right_neighbor: [u8; 32],
    },
}

/// A compact non-membership argument anchored to a specific set root.
#[derive(Debug, Clone, PartialEq)]
pub struct InnocenceProof {
    /// The hash being proven absent.
    pub candidate_hash: [u8; 32],
    /// The set root this proof is anchored to.
    pub set_root: [u8; 32],
    /// Witness proving the candidate falls outside all members.
    pub witness: WitnessPosition,
    /// Always false - devnet only, no audit.
    pub mainnet_ready: bool,
}

/// Errors returned by the proof functions.
#[derive(Debug, PartialEq)]
pub enum InnocenceError {
    /// The hash IS in the set - not innocent.
    HashInSet,
    /// Cannot prove non-membership of an empty set.
    EmptySet,
    /// Witness doesn't match set root or candidate.
    InvalidWitness,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute the set root: SHA256("set-root-v1" || count_le4 || sorted_members).
fn compute_root(sorted: &[[u8; 32]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"set-root-v1");
    let count = sorted.len() as u32;
    hasher.update(count.to_le_bytes());
    for h in sorted {
        hasher.update(h);
    }
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build a tainted set from a list of transaction hashes.
/// Returns `Err(EmptySet)` if the slice is empty.
pub fn build_tainted_set(tx_hashes: &[[u8; 32]]) -> Result<TaintedSet, InnocenceError> {
    if tx_hashes.is_empty() {
        return Err(InnocenceError::EmptySet);
    }
    let mut sorted = tx_hashes.to_vec();
    sorted.sort_unstable();
    let root = compute_root(&sorted);
    Ok(TaintedSet {
        members: sorted,
        root,
        mainnet_ready: false,
    })
}

/// Prove that `candidate_hash` is NOT in the tainted set.
/// Returns `Err(HashInSet)` if the hash is actually in the set,
/// `Err(EmptySet)` if the set is empty.
pub fn prove_innocence(
    set: &TaintedSet,
    candidate_hash: &[u8; 32],
) -> Result<InnocenceProof, InnocenceError> {
    if set.members.is_empty() {
        return Err(InnocenceError::EmptySet);
    }

    // Binary search for candidate in sorted set.
    match set.members.binary_search(candidate_hash) {
        Ok(_) => Err(InnocenceError::HashInSet),
        Err(pos) => {
            // pos == 0 -> below all  |  pos == len -> above all  |  otherwise between
            let witness = if pos == 0 {
                WitnessPosition::BelowAll {
                    right_neighbor: set.members[0],
                }
            } else if pos == set.members.len() {
                WitnessPosition::AboveAll {
                    left_neighbor: set.members[set.members.len() - 1],
                }
            } else {
                WitnessPosition::Between {
                    left_neighbor: set.members[pos - 1],
                    right_neighbor: set.members[pos],
                }
            };

            Ok(InnocenceProof {
                candidate_hash: *candidate_hash,
                set_root: set.root,
                witness,
                mainnet_ready: false,
            })
        }
    }
}

/// Verify an innocence proof against the given tainted set.
///
/// Checks:
/// 1. The proof's set_root matches the set's root.
/// 2. The candidate is genuinely absent based on the witness and ordering.
/// 3. Witness neighbors are actually present and adjacent in the set.
pub fn verify_innocence(proof: &InnocenceProof, set: &TaintedSet) -> bool {
    // 1. Root binding.
    if proof.set_root != set.root {
        return false;
    }

    // 2. Candidate must not be directly present (fast check).
    if set.members.binary_search(&proof.candidate_hash).is_ok() {
        return false;
    }

    let c = &proof.candidate_hash;

    match &proof.witness {
        WitnessPosition::BelowAll { right_neighbor } => {
            // candidate < right_neighbor AND right_neighbor is smallest element.
            if c >= right_neighbor {
                return false;
            }
            // right_neighbor must be the first element.
            if set.members.is_empty() || &set.members[0] != right_neighbor {
                return false;
            }
        }
        WitnessPosition::AboveAll { left_neighbor } => {
            // candidate > left_neighbor AND left_neighbor is largest element.
            if c <= left_neighbor {
                return false;
            }
            let last = set.members.last().unwrap();
            if last != left_neighbor {
                return false;
            }
        }
        WitnessPosition::Between {
            left_neighbor,
            right_neighbor,
        } => {
            // left < candidate < right.
            if left_neighbor >= c || c >= right_neighbor {
                return false;
            }
            // Both neighbors must be in the set and adjacent.
            let left_pos = match set.members.binary_search(left_neighbor) {
                Ok(p) => p,
                Err(_) => return false,
            };
            let right_pos = match set.members.binary_search(right_neighbor) {
                Ok(p) => p,
                Err(_) => return false,
            };
            if right_pos != left_pos + 1 {
                return false;
            }
        }
    }

    true
}

/// Check if a hash is in the tainted set (simple membership test).
pub fn is_tainted(set: &TaintedSet, candidate_hash: &[u8; 32]) -> bool {
    set.members.binary_search(candidate_hash).is_ok()
}

/// Generate a privacy-safe JSON evidence blob.
/// Contains `set_root`, `candidate_hash` (hex), and `verdict` (bool).
/// Does NOT include the full member list.
pub fn innocence_evidence_json(proof: &InnocenceProof, verdict: bool) -> String {
    let set_root_hex = hex_encode(&proof.set_root);
    let candidate_hex = hex_encode(&proof.candidate_hash);
    format!(
        r#"{{"set_root":"{set_root_hex}","candidate_hash":"{candidate_hex}","verdict":{verdict}}}"#
    )
}

// ---------------------------------------------------------------------------
// Internal hex encoder (no external dep needed)
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    fn hash_from_byte(b: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = b;
        h
    }

    fn hash_all(b: u8) -> [u8; 32] {
        [b; 32]
    }

    // ------------------------------------------------------------------
    // 1. mainnet_ready is always false
    // ------------------------------------------------------------------
    #[test]
    fn test_tainted_set_mainnet_ready_false() {
        let set = build_tainted_set(&[hash_from_byte(1)]).unwrap();
        assert!(!set.mainnet_ready);

        let proof = prove_innocence(&set, &hash_from_byte(2)).unwrap();
        assert!(!proof.mainnet_ready);
    }

    // ------------------------------------------------------------------
    // 2. set root is deterministic
    // ------------------------------------------------------------------
    #[test]
    fn test_set_root_deterministic() {
        let h1 = hash_from_byte(10);
        let h2 = hash_from_byte(20);
        let set_a = build_tainted_set(&[h1, h2]).unwrap();
        let set_b = build_tainted_set(&[h1, h2]).unwrap();
        assert_eq!(set_a.root, set_b.root);
    }

    // ------------------------------------------------------------------
    // 3. same hashes in different order -> same root
    // ------------------------------------------------------------------
    #[test]
    fn test_set_root_order_independent() {
        let h1 = hash_from_byte(5);
        let h2 = hash_from_byte(50);
        let h3 = hash_from_byte(200);

        let set_a = build_tainted_set(&[h1, h2, h3]).unwrap();
        let set_b = build_tainted_set(&[h3, h1, h2]).unwrap();
        let set_c = build_tainted_set(&[h2, h3, h1]).unwrap();

        assert_eq!(set_a.root, set_b.root);
        assert_eq!(set_b.root, set_c.root);
    }

    // ------------------------------------------------------------------
    // 4. prove innocence - single element set
    // ------------------------------------------------------------------
    #[test]
    fn test_prove_innocence_single_element_set() {
        let member = hash_from_byte(128);
        let set = build_tainted_set(&[member]).unwrap();

        // Below the single element.
        let below = hash_from_byte(10);
        let proof = prove_innocence(&set, &below).unwrap();
        assert_eq!(proof.candidate_hash, below);
        assert!(matches!(proof.witness, WitnessPosition::BelowAll { .. }));

        // Above the single element.
        let above = hash_from_byte(200);
        let proof2 = prove_innocence(&set, &above).unwrap();
        assert!(matches!(proof2.witness, WitnessPosition::AboveAll { .. }));
    }

    // ------------------------------------------------------------------
    // 5. prove innocence - below all
    // ------------------------------------------------------------------
    #[test]
    fn test_prove_innocence_below_all() {
        let set = build_tainted_set(&[hash_from_byte(50), hash_from_byte(100)]).unwrap();
        let candidate = hash_from_byte(1);
        let proof = prove_innocence(&set, &candidate).unwrap();
        match proof.witness {
            WitnessPosition::BelowAll { right_neighbor } => {
                assert_eq!(right_neighbor, hash_from_byte(50));
            }
            _ => panic!("expected BelowAll"),
        }
    }

    // ------------------------------------------------------------------
    // 6. prove innocence - above all
    // ------------------------------------------------------------------
    #[test]
    fn test_prove_innocence_above_all() {
        let set = build_tainted_set(&[hash_from_byte(50), hash_from_byte(100)]).unwrap();
        let candidate = hash_from_byte(200);
        let proof = prove_innocence(&set, &candidate).unwrap();
        match proof.witness {
            WitnessPosition::AboveAll { left_neighbor } => {
                assert_eq!(left_neighbor, hash_from_byte(100));
            }
            _ => panic!("expected AboveAll"),
        }
    }

    // ------------------------------------------------------------------
    // 7. prove innocence - between two
    // ------------------------------------------------------------------
    #[test]
    fn test_prove_innocence_between_two() {
        let left = hash_from_byte(30);
        let right = hash_from_byte(60);
        let set = build_tainted_set(&[left, right]).unwrap();
        let candidate = hash_from_byte(45);
        let proof = prove_innocence(&set, &candidate).unwrap();
        match proof.witness {
            WitnessPosition::Between {
                left_neighbor,
                right_neighbor,
            } => {
                assert_eq!(left_neighbor, left);
                assert_eq!(right_neighbor, right);
            }
            _ => panic!("expected Between"),
        }
    }

    // ------------------------------------------------------------------
    // 8. tainted hash -> Err(HashInSet)
    // ------------------------------------------------------------------
    #[test]
    fn test_tainted_hash_rejected() {
        let member = hash_from_byte(77);
        let set = build_tainted_set(&[member, hash_from_byte(10)]).unwrap();
        let result = prove_innocence(&set, &member);
        assert_eq!(result, Err(InnocenceError::HashInSet));
    }

    // ------------------------------------------------------------------
    // 9. verify_innocence passes for valid proof
    // ------------------------------------------------------------------
    #[test]
    fn test_verify_innocence_passes() {
        let set = build_tainted_set(&[hash_from_byte(40), hash_from_byte(80)]).unwrap();
        let candidate = hash_from_byte(60);
        let proof = prove_innocence(&set, &candidate).unwrap();
        assert!(verify_innocence(&proof, &set));
    }

    // ------------------------------------------------------------------
    // 10. verify_innocence fails when the candidate IS a member
    // ------------------------------------------------------------------
    #[test]
    fn test_verify_innocence_fails_for_member() {
        let member = hash_from_byte(40);
        let set = build_tainted_set(&[member, hash_from_byte(80)]).unwrap();

        // Build a proof for a neighbouring innocent hash.
        let innocent = hash_from_byte(60);
        let mut proof = prove_innocence(&set, &innocent).unwrap();

        // Tamper: swap in the member as the "candidate".
        proof.candidate_hash = member;

        // verify_innocence must reject this.
        assert!(!verify_innocence(&proof, &set));
    }

    // ------------------------------------------------------------------
    // 11. is_tainted returns true for a member
    // ------------------------------------------------------------------
    #[test]
    fn test_is_tainted_true_for_member() {
        let member = hash_from_byte(99);
        let set = build_tainted_set(&[member]).unwrap();
        assert!(is_tainted(&set, &member));
    }

    // ------------------------------------------------------------------
    // 12. is_tainted returns false for a non-member
    // ------------------------------------------------------------------
    #[test]
    fn test_is_tainted_false_for_non_member() {
        let set = build_tainted_set(&[hash_from_byte(99)]).unwrap();
        assert!(!is_tainted(&set, &hash_from_byte(1)));
    }

    // ------------------------------------------------------------------
    // 13. empty set -> Err(EmptySet)
    // ------------------------------------------------------------------
    #[test]
    fn test_empty_set_rejected() {
        let result = build_tainted_set(&[]);
        assert_eq!(result, Err(InnocenceError::EmptySet));
    }

    // ------------------------------------------------------------------
    // 14. innocence JSON has required fields
    // ------------------------------------------------------------------
    #[test]
    fn test_innocence_json_structure() {
        let set = build_tainted_set(&[hash_from_byte(10)]).unwrap();
        let candidate = hash_from_byte(200);
        let proof = prove_innocence(&set, &candidate).unwrap();
        let json = innocence_evidence_json(&proof, true);

        assert!(json.contains("\"set_root\""), "missing set_root");
        assert!(
            json.contains("\"candidate_hash\""),
            "missing candidate_hash"
        );
        assert!(json.contains("\"verdict\":true"), "missing verdict");
        // Must NOT expose member list.
        assert!(!json.contains("members"), "must not expose member list");

        // Verify it's valid-ish JSON by checking braces.
        assert!(json.starts_with('{'));
        assert!(json.ends_with('}'));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_set_root_nonzero() {
        let set = build_tainted_set(&[hash_from_byte(1), hash_from_byte(2)]).unwrap();
        assert_ne!(set.root, [0u8; 32]);
    }

    // ------------------------------------------------------------------
    // 15. prove innocence for values in each gap of a 5-element set
    // ------------------------------------------------------------------
    #[test]
    fn test_proof_for_each_gap_in_5_element_set() {
        // Use all-N byte hashes so ordering is clear (byte 0 dominates).
        let members: Vec<[u8; 32]> = [10u8, 40, 70, 120, 200]
            .iter()
            .map(|&b| hash_all(b))
            .collect();
        let set = build_tainted_set(&members).unwrap();

        // Gap 0: below all (< 10)
        let below = hash_all(1);
        let p0 = prove_innocence(&set, &below).unwrap();
        assert!(matches!(p0.witness, WitnessPosition::BelowAll { .. }));
        assert!(verify_innocence(&p0, &set));

        // Gap 1: between 10 and 40
        let g1 = hash_all(20);
        let p1 = prove_innocence(&set, &g1).unwrap();
        assert!(matches!(p1.witness, WitnessPosition::Between { .. }));
        assert!(verify_innocence(&p1, &set));

        // Gap 2: between 40 and 70
        let g2 = hash_all(55);
        let p2 = prove_innocence(&set, &g2).unwrap();
        assert!(matches!(p2.witness, WitnessPosition::Between { .. }));
        assert!(verify_innocence(&p2, &set));

        // Gap 3: between 70 and 120
        let g3 = hash_all(90);
        let p3 = prove_innocence(&set, &g3).unwrap();
        assert!(matches!(p3.witness, WitnessPosition::Between { .. }));
        assert!(verify_innocence(&p3, &set));

        // Gap 4: between 120 and 200
        let g4 = hash_all(150);
        let p4 = prove_innocence(&set, &g4).unwrap();
        assert!(matches!(p4.witness, WitnessPosition::Between { .. }));
        assert!(verify_innocence(&p4, &set));

        // Gap 5: above all (> 200)
        let above = hash_all(255);
        let p5 = prove_innocence(&set, &above).unwrap();
        assert!(matches!(p5.witness, WitnessPosition::AboveAll { .. }));
        assert!(verify_innocence(&p5, &set));
    }
}
