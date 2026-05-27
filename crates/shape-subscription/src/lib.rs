use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub enum ShapeTier {
    Basic,
    Advanced,
    Elite,
}

#[derive(Debug, Clone)]
pub struct ShapePass {
    pub pass_hash: [u8; 32],
    pub holder_hash: [u8; 32],
    pub expires_at_slot: u64,
    pub shape_tier: ShapeTier,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CamouflageGrade {
    Exposed,
    Blended,
    Invisible,
}

#[derive(Debug, Clone)]
pub struct KShapeScore {
    pub tx_hash: [u8; 32],
    pub k_anonymity: u32,
    pub camouflage_grade: CamouflageGrade,
}

#[derive(Debug, Clone)]
pub struct ChafffFiller {
    pub filler_count: u8,
    pub filler_hashes: Vec<[u8; 32]>,
}

pub fn issue_shape_pass(
    holder_hash: &[u8; 32],
    tier: ShapeTier,
    expires_at_slot: u64,
) -> ShapePass {
    let tier_byte: u8 = match tier {
        ShapeTier::Basic => 0,
        ShapeTier::Advanced => 1,
        ShapeTier::Elite => 2,
    };
    let mut hasher = Sha256::new();
    hasher.update(b"shape-pass-v1");
    hasher.update(holder_hash);
    hasher.update([tier_byte]);
    hasher.update(expires_at_slot.to_le_bytes());
    let pass_hash: [u8; 32] = hasher.finalize().into();

    ShapePass {
        pass_hash,
        holder_hash: *holder_hash,
        expires_at_slot,
        shape_tier: tier,
    }
}

pub fn score_camouflage(tx_hash: &[u8; 32], matching_count: u32) -> KShapeScore {
    let camouflage_grade = if matching_count >= 100 {
        CamouflageGrade::Invisible
    } else if matching_count >= 10 {
        CamouflageGrade::Blended
    } else {
        CamouflageGrade::Exposed
    };

    KShapeScore {
        tx_hash: *tx_hash,
        k_anonymity: matching_count,
        camouflage_grade,
    }
}

pub fn create_chaff_filler(tier: &ShapeTier, tx_hash: &[u8; 32]) -> ChafffFiller {
    let count: u8 = match tier {
        ShapeTier::Basic => 1,
        ShapeTier::Advanced => 3,
        ShapeTier::Elite => 5,
    };

    let mut filler_hashes = Vec::with_capacity(count as usize);
    for i in 0..count {
        let mut hasher = Sha256::new();
        hasher.update(b"chaff-filler-v1");
        hasher.update(tx_hash);
        hasher.update([i]);
        filler_hashes.push(hasher.finalize().into());
    }

    ChafffFiller {
        filler_count: count,
        filler_hashes,
    }
}

pub fn pass_is_valid(pass: &ShapePass, current_slot: u64) -> bool {
    current_slot <= pass.expires_at_slot
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_hash(seed: u8) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = seed;
        h
    }

    #[test]
    fn test_pass_issued_correctly() {
        let holder = dummy_hash(1);
        let pass = issue_shape_pass(&holder, ShapeTier::Advanced, 9_999);
        assert_eq!(pass.holder_hash, holder);
        assert_eq!(pass.expires_at_slot, 9_999);
        assert_eq!(pass.shape_tier, ShapeTier::Advanced);
    }

    #[test]
    fn test_pass_expires() {
        let pass = issue_shape_pass(&dummy_hash(1), ShapeTier::Basic, 500);
        assert!(pass_is_valid(&pass, 500), "valid at expiry slot");
        assert!(!pass_is_valid(&pass, 501), "invalid after expiry slot");
    }

    #[test]
    fn test_exposed_below_10() {
        let score = score_camouflage(&dummy_hash(1), 5);
        assert_eq!(score.camouflage_grade, CamouflageGrade::Exposed);
    }

    #[test]
    fn test_blended_at_50() {
        let score = score_camouflage(&dummy_hash(1), 50);
        assert_eq!(score.camouflage_grade, CamouflageGrade::Blended);
    }

    #[test]
    fn test_invisible_at_100() {
        let score = score_camouflage(&dummy_hash(1), 100);
        assert_eq!(score.camouflage_grade, CamouflageGrade::Invisible);
    }

    #[test]
    fn test_elite_tier_five_fillers() {
        let tx = dummy_hash(7);
        let filler = create_chaff_filler(&ShapeTier::Elite, &tx);
        assert_eq!(filler.filler_count, 5);
        assert_eq!(filler.filler_hashes.len(), 5);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_pass_hash_nonzero() {
        let pass = issue_shape_pass(&dummy_hash(1), ShapeTier::Basic, 1_000);
        assert_ne!(pass.pass_hash, [0u8; 32]);
    }

    #[test]
    fn test_pass_hash_deterministic() {
        let h = dummy_hash(5);
        let p1 = issue_shape_pass(&h, ShapeTier::Elite, 9_999);
        let p2 = issue_shape_pass(&h, ShapeTier::Elite, 9_999);
        assert_eq!(p1.pass_hash, p2.pass_hash);
    }

    #[test]
    fn test_pass_hash_holder_sensitive() {
        let p1 = issue_shape_pass(&dummy_hash(10), ShapeTier::Advanced, 5_000);
        let p2 = issue_shape_pass(&dummy_hash(20), ShapeTier::Advanced, 5_000);
        assert_ne!(p1.pass_hash, p2.pass_hash);
    }

    #[test]
    fn test_pass_hash_tier_sensitive() {
        let h = dummy_hash(3);
        let p1 = issue_shape_pass(&h, ShapeTier::Basic, 5_000);
        let p2 = issue_shape_pass(&h, ShapeTier::Elite, 5_000);
        assert_ne!(p1.pass_hash, p2.pass_hash);
    }

    #[test]
    fn test_blended_at_exactly_10() {
        let score = score_camouflage(&dummy_hash(2), 10);
        assert_eq!(score.camouflage_grade, CamouflageGrade::Blended);
    }

    #[test]
    fn test_exposed_at_9() {
        let score = score_camouflage(&dummy_hash(2), 9);
        assert_eq!(score.camouflage_grade, CamouflageGrade::Exposed);
    }

    #[test]
    fn test_basic_tier_one_filler() {
        let tx = dummy_hash(1);
        let filler = create_chaff_filler(&ShapeTier::Basic, &tx);
        assert_eq!(filler.filler_count, 1);
        assert_eq!(filler.filler_hashes.len(), 1);
    }

    #[test]
    fn test_advanced_tier_three_fillers() {
        let tx = dummy_hash(2);
        let filler = create_chaff_filler(&ShapeTier::Advanced, &tx);
        assert_eq!(filler.filler_count, 3);
        assert_eq!(filler.filler_hashes.len(), 3);
    }

    #[test]
    fn test_filler_hashes_nonzero() {
        let tx = dummy_hash(9);
        let filler = create_chaff_filler(&ShapeTier::Elite, &tx);
        for h in &filler.filler_hashes {
            assert_ne!(*h, [0u8; 32]);
        }
    }

    #[test]
    fn test_k_anonymity_stored() {
        let score = score_camouflage(&dummy_hash(3), 77);
        assert_eq!(score.k_anonymity, 77);
    }
}
