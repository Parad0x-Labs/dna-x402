use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Private helper
// ---------------------------------------------------------------------------

fn sha256_domain(domain: &[u8], inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(domain);
    for i in inputs {
        h.update(i);
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SpendShadowKind {
    Real,
    Decoy,
    Delayed,
    Poison,
    Maintenance,
}

impl SpendShadowKind {
    pub fn kind_byte(&self) -> u8 {
        match self {
            Self::Real => 0x01,
            Self::Decoy => 0x02,
            Self::Delayed => 0x03,
            Self::Poison => 0x04,
            Self::Maintenance => 0x05,
        }
    }
}

/// A single shadow leaf — all leaves have the same canonical byte length.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShadowLeaf {
    pub kind: SpendShadowKind,
    pub leaf_hash: [u8; 32],
    /// For Delayed: the slot after which this can be revealed. 0 for others.
    pub reveal_slot: u64,
    /// For Maintenance: hash of the useful maintenance job. [0;32] for others.
    pub maintenance_job_hash: [u8; 32],
    pub expiry_slot: u64,
}

impl ShadowLeaf {
    /// Fixed-width canonical serialization: 81 bytes for any leaf kind.
    /// Layout: [kind_byte:1][leaf_hash:32][reveal_slot:8][maintenance_job_hash:32][expiry_slot:8]
    pub fn canonical_bytes(&self) -> [u8; 81] {
        let mut out = [0u8; 81];
        out[0] = self.kind.kind_byte();
        out[1..33].copy_from_slice(&self.leaf_hash);
        out[33..41].copy_from_slice(&self.reveal_slot.to_le_bytes());
        out[41..73].copy_from_slice(&self.maintenance_job_hash);
        out[73..81].copy_from_slice(&self.expiry_slot.to_le_bytes());
        out
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ShadowRevealPolicy {
    /// Holder knows index of real leaf (not stored publicly)
    HolderKnows,
    /// Real leaf revealed at a specific slot
    TimeRevealed { slot: u64 },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShadowBundle {
    pub bundle_id: [u8; 32],
    /// Hidden commitment to the real leaf — not stored in public_leaves
    pub real_commitment_hidden: [u8; 32],
    pub public_leaves: Vec<ShadowLeaf>,
    pub reveal_policy: ShadowRevealPolicy,
    pub expiry_slot: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShadowError {
    PoisonLeafCannotRedeem,
    DelayedLeafTooEarly { reveal_at: u64, current: u64 },
    EmptyBundle,
    NoRealLeaf,
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/// Build a shadow bundle with one real leaf + decoys + optional delayed + optional maintenance.
pub fn new_shadow_bundle(
    real_leaf_hash: [u8; 32],
    decoy_count: usize,
    delayed_slot: Option<u64>,
    maintenance_hash: Option<[u8; 32]>,
    expiry_slot: u64,
) -> ShadowBundle {
    let mut public_leaves: Vec<ShadowLeaf> = Vec::new();

    // Real leaf
    let real_leaf = ShadowLeaf {
        kind: SpendShadowKind::Real,
        leaf_hash: real_leaf_hash,
        reveal_slot: 0,
        maintenance_job_hash: [0u8; 32],
        expiry_slot,
    };
    public_leaves.push(real_leaf);

    // Decoy leaves
    for i in 0..decoy_count {
        let decoy_seed = sha256_domain(
            b"dark_null_v1_shadow_decoy",
            &[real_leaf_hash.as_ref(), &(i as u64).to_le_bytes()],
        );
        public_leaves.push(ShadowLeaf {
            kind: SpendShadowKind::Decoy,
            leaf_hash: decoy_seed,
            reveal_slot: 0,
            maintenance_job_hash: [0u8; 32],
            expiry_slot,
        });
    }

    // Optional delayed leaf
    if let Some(slot) = delayed_slot {
        let delayed_seed = sha256_domain(
            b"dark_null_v1_shadow_delayed",
            &[real_leaf_hash.as_ref(), &slot.to_le_bytes()],
        );
        public_leaves.push(ShadowLeaf {
            kind: SpendShadowKind::Delayed,
            leaf_hash: delayed_seed,
            reveal_slot: slot,
            maintenance_job_hash: [0u8; 32],
            expiry_slot,
        });
    }

    // Optional maintenance leaf
    if let Some(mhash) = maintenance_hash {
        let maint_seed = sha256_domain(
            b"dark_null_v1_shadow_maintenance",
            &[real_leaf_hash.as_ref(), mhash.as_ref()],
        );
        public_leaves.push(ShadowLeaf {
            kind: SpendShadowKind::Maintenance,
            leaf_hash: maint_seed,
            reveal_slot: 0,
            maintenance_job_hash: mhash,
            expiry_slot,
        });
    }

    // Bundle ID: deterministic hash of all leaf canonical bytes
    let leaf_bytes_refs: Vec<Vec<u8>> = public_leaves
        .iter()
        .map(|l| l.canonical_bytes().to_vec())
        .collect();
    let leaf_slices: Vec<&[u8]> = leaf_bytes_refs.iter().map(|v| v.as_slice()).collect();
    let bundle_id = sha256_domain(b"dark_null_v1_shadow_bundle", &leaf_slices);

    // Hidden commitment to the real leaf (not in public_leaves conceptually, but we store
    // a blinded hash so the holder can prove knowledge without revealing which is real)
    let real_commitment_hidden = sha256_domain(
        b"dark_null_v1_real_commitment",
        &[real_leaf_hash.as_ref(), &expiry_slot.to_le_bytes()],
    );

    ShadowBundle {
        bundle_id,
        real_commitment_hidden,
        public_leaves,
        reveal_policy: ShadowRevealPolicy::HolderKnows,
        expiry_slot,
    }
}

/// Can this leaf be revealed at current_slot?
pub fn can_reveal_leaf(leaf: &ShadowLeaf, current_slot: u64) -> Result<(), ShadowError> {
    if leaf.kind == SpendShadowKind::Delayed && current_slot < leaf.reveal_slot {
        return Err(ShadowError::DelayedLeafTooEarly {
            reveal_at: leaf.reveal_slot,
            current: current_slot,
        });
    }
    Ok(())
}

/// Can this leaf be redeemed? Poison leaves always return Err.
pub fn can_redeem_leaf(leaf: &ShadowLeaf) -> Result<(), ShadowError> {
    if leaf.kind == SpendShadowKind::Poison {
        return Err(ShadowError::PoisonLeafCannotRedeem);
    }
    Ok(())
}

/// Precision an adversarial copy-sniper achieves: 1.0 / public_leaves.len().
/// Returns 1.0 for empty bundle (no cover at all).
pub fn copy_sniper_precision(bundle: &ShadowBundle) -> f32 {
    let n = bundle.public_leaves.len();
    if n == 0 {
        return 1.0_f32;
    }
    1.0_f32 / n as f32
}

/// Count how many Real leaves are in the bundle (should be exactly 1).
pub fn count_real_leaves(bundle: &ShadowBundle) -> usize {
    bundle
        .public_leaves
        .iter()
        .filter(|l| l.kind == SpendShadowKind::Real)
        .count()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_leaf(kind: SpendShadowKind, seed: u8) -> ShadowLeaf {
        ShadowLeaf {
            kind,
            leaf_hash: [seed; 32],
            reveal_slot: 0,
            maintenance_job_hash: [0u8; 32],
            expiry_slot: 9999,
        }
    }

    #[test]
    fn test_bundle_has_exactly_one_real_leaf() {
        let bundle = new_shadow_bundle([0x01u8; 32], 3, None, None, 9999);
        assert_eq!(count_real_leaves(&bundle), 1);
        assert_eq!(bundle.public_leaves.len(), 4); // 1 real + 3 decoys
    }

    #[test]
    fn test_poison_cannot_redeem() {
        let leaf = make_leaf(SpendShadowKind::Poison, 0xFF);
        let result = can_redeem_leaf(&leaf);
        assert!(matches!(result, Err(ShadowError::PoisonLeafCannotRedeem)));
    }

    #[test]
    fn test_delayed_cannot_reveal_before_slot() {
        let mut leaf = make_leaf(SpendShadowKind::Delayed, 0x10);
        leaf.reveal_slot = 1000;

        // Too early
        let result = can_reveal_leaf(&leaf, 500);
        assert!(matches!(
            result,
            Err(ShadowError::DelayedLeafTooEarly {
                reveal_at: 1000,
                current: 500
            })
        ));

        // Exactly at reveal_slot → Ok
        let result2 = can_reveal_leaf(&leaf, 1000);
        assert!(result2.is_ok());
    }

    #[test]
    fn test_all_leaves_same_canonical_byte_length() {
        let kinds = [
            SpendShadowKind::Real,
            SpendShadowKind::Decoy,
            SpendShadowKind::Delayed,
            SpendShadowKind::Poison,
            SpendShadowKind::Maintenance,
        ];
        for kind in &kinds {
            let leaf = make_leaf(kind.clone(), 0x01);
            assert_eq!(
                leaf.canonical_bytes().len(),
                81,
                "kind {:?} should produce 81 bytes",
                kind
            );
        }
    }

    #[test]
    fn test_copy_sniper_precision_decreases() {
        let bundle2 = new_shadow_bundle([0x01u8; 32], 1, None, None, 9999); // 2 leaves
        let bundle5 = new_shadow_bundle([0x01u8; 32], 4, None, None, 9999); // 5 leaves

        let precision2 = copy_sniper_precision(&bundle2);
        let precision5 = copy_sniper_precision(&bundle5);

        assert!(
            precision2 > precision5,
            "2-leaf bundle ({}) should have higher sniper precision than 5-leaf ({})",
            precision2,
            precision5
        );
    }

    #[test]
    fn test_maintenance_leaf_has_job_hash() {
        let job_hash = [0xAAu8; 32];
        let mut leaf = make_leaf(SpendShadowKind::Maintenance, 0x05);
        leaf.maintenance_job_hash = job_hash;
        assert_eq!(leaf.maintenance_job_hash, [0xAAu8; 32]);

        // Also verify it survives canonical_bytes round-trip
        let cb = leaf.canonical_bytes();
        assert_eq!(&cb[41..73], &[0xAAu8; 32]);
    }

    #[test]
    fn test_real_leaf_can_be_revealed_and_redeemed() {
        let leaf = make_leaf(SpendShadowKind::Real, 0x01);
        // Real leaf has no reveal_slot restriction
        let reveal_result = can_reveal_leaf(&leaf, leaf.expiry_slot - 1);
        assert!(reveal_result.is_ok());

        let redeem_result = can_redeem_leaf(&leaf);
        assert!(redeem_result.is_ok());
    }

    #[test]
    fn test_bundle_id_deterministic() {
        let real_hash = [0x42u8; 32];
        let expiry = 5000u64;

        let bundle_a = new_shadow_bundle(real_hash, 2, None, None, expiry);
        let bundle_b = new_shadow_bundle(real_hash, 2, None, None, expiry);

        assert_eq!(
            bundle_a.bundle_id, bundle_b.bundle_id,
            "same inputs must produce identical bundle_id"
        );
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_bundle_id_nonzero() {
        let bundle = new_shadow_bundle([0x01u8; 32], 2, None, None, 9999);
        assert_ne!(bundle.bundle_id, [0u8; 32]);
    }

    #[test]
    fn test_real_commitment_nonzero() {
        let bundle = new_shadow_bundle([0x01u8; 32], 2, None, None, 9999);
        assert_ne!(bundle.real_commitment_hidden, [0u8; 32]);
    }

    #[test]
    fn test_kind_bytes_distinct() {
        let kinds = [
            SpendShadowKind::Real,
            SpendShadowKind::Decoy,
            SpendShadowKind::Delayed,
            SpendShadowKind::Poison,
            SpendShadowKind::Maintenance,
        ];
        let bytes: Vec<u8> = kinds.iter().map(|k| k.kind_byte()).collect();
        let unique: std::collections::HashSet<u8> = bytes.iter().cloned().collect();
        assert_eq!(unique.len(), kinds.len(), "all kind bytes must be distinct");
    }

    #[test]
    fn test_copy_sniper_one_leaf_full_precision() {
        // 0 decoys → 1 real leaf → precision = 1.0 / 1 = 1.0
        let bundle = new_shadow_bundle([0x01u8; 32], 0, None, None, 9999);
        assert_eq!(copy_sniper_precision(&bundle), 1.0);
    }

    #[test]
    fn test_maintenance_leaf_can_be_redeemed() {
        let leaf = make_leaf(SpendShadowKind::Maintenance, 0x05);
        assert!(can_redeem_leaf(&leaf).is_ok());
    }

    #[test]
    fn test_no_delayed_leaf_in_simple_bundle() {
        let bundle = new_shadow_bundle([0x01u8; 32], 3, None, None, 9999);
        let delayed_count = bundle
            .public_leaves
            .iter()
            .filter(|l| l.kind == SpendShadowKind::Delayed)
            .count();
        assert_eq!(delayed_count, 0);
    }

    #[test]
    fn test_bundle_with_maintenance_has_maintenance_leaf() {
        let maint_hash = [0xBBu8; 32];
        let bundle = new_shadow_bundle([0x01u8; 32], 2, None, Some(maint_hash), 9999);
        let maint_count = bundle
            .public_leaves
            .iter()
            .filter(|l| l.kind == SpendShadowKind::Maintenance)
            .count();
        assert_eq!(maint_count, 1);
    }

    #[test]
    fn test_poison_canonical_byte_is_kind_byte() {
        let leaf = make_leaf(SpendShadowKind::Poison, 0x10);
        let cb = leaf.canonical_bytes();
        assert_eq!(cb[0], SpendShadowKind::Poison.kind_byte());
    }
}
