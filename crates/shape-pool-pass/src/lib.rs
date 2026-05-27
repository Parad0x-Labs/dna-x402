use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShapePoolPass {
    pub pass_id: [u8; 32],
    pub shape_class_hash: [u8; 32],
    pub valid_until_slot: u64,
    pub max_uses: u32,
    pub uses_remaining: u32,
    pub owner_hash: [u8; 32],
    pub transferable: bool,
}

#[derive(Debug, PartialEq)]
pub enum PassError {
    Expired,
    Exhausted,
    WrongShape,
    NonTransferable,
}

pub fn mint_pass(
    shape_class_hash: [u8; 32],
    owner_hash: [u8; 32],
    valid_until_slot: u64,
    max_uses: u32,
    transferable: bool,
) -> ShapePoolPass {
    let mut h = Sha256::new();
    h.update(b"shape_pool_pass_v1");
    h.update(shape_class_hash);
    h.update(owner_hash);
    h.update(valid_until_slot.to_le_bytes());
    let pass_id: [u8; 32] = h.finalize().into();

    ShapePoolPass {
        pass_id,
        shape_class_hash,
        valid_until_slot,
        max_uses,
        uses_remaining: max_uses,
        owner_hash,
        transferable,
    }
}

pub fn consume_pass(
    pass: &mut ShapePoolPass,
    shape_hash: &[u8; 32],
    current_slot: u64,
) -> Result<u32, PassError> {
    if current_slot > pass.valid_until_slot {
        return Err(PassError::Expired);
    }
    if pass.uses_remaining == 0 {
        return Err(PassError::Exhausted);
    }
    if shape_hash != &pass.shape_class_hash {
        return Err(PassError::WrongShape);
    }
    pass.uses_remaining -= 1;
    Ok(pass.uses_remaining)
}

/// Price decreases as pool gets more crowded. Min price = base/10.
pub fn price_pass_by_pool_depth(pool_k: u32, base_price_lamports: u64) -> u64 {
    let divisor = (pool_k / 5).max(1) as u64;
    let price = base_price_lamports / divisor;
    let min_price = base_price_lamports / 10;
    price.max(min_price)
}

pub fn compute_k_shape_boost(pass: &ShapePoolPass, current_pool_k: u32) -> u32 {
    if pass.uses_remaining > 0 {
        10u32.min(current_pool_k + 1)
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"shape_class_alpha");
        h.finalize().into()
    }

    fn owner() -> [u8; 32] {
        [0xBEu8; 32]
    }

    #[test]
    fn test_pass_expires() {
        let mut pass = mint_pass(shape(), owner(), 100, 5, true);
        assert_eq!(
            consume_pass(&mut pass, &shape(), 101),
            Err(PassError::Expired)
        );
    }

    #[test]
    fn test_max_uses_enforced() {
        let mut pass = mint_pass(shape(), owner(), 10_000, 1, true);
        assert!(consume_pass(&mut pass, &shape(), 1000).is_ok());
        assert_eq!(
            consume_pass(&mut pass, &shape(), 1000),
            Err(PassError::Exhausted)
        );
    }

    #[test]
    fn test_wrong_shape_rejected() {
        let mut pass = mint_pass(shape(), owner(), 10_000, 5, true);
        let wrong_shape = [0xFFu8; 32];
        assert_eq!(
            consume_pass(&mut pass, &wrong_shape, 1000),
            Err(PassError::WrongShape)
        );
    }

    #[test]
    fn test_price_decreases_with_pool_depth() {
        let base = 100_000u64;
        let p5 = price_pass_by_pool_depth(5, base);
        let p10 = price_pass_by_pool_depth(10, base);
        assert!(p5 >= p10);
    }

    #[test]
    fn test_k_shape_boost_computed() {
        let pass = mint_pass(shape(), owner(), 10_000, 5, true);
        let boost = compute_k_shape_boost(&pass, 4);
        assert_eq!(boost, 5); // min(10, 4+1)
    }

    #[test]
    fn test_non_transferable_pass_minted() {
        let pass = mint_pass(shape(), owner(), 10_000, 5, false);
        assert!(!pass.transferable);
        assert_eq!(pass.uses_remaining, 5);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_pass_id_nonzero() {
        let pass = mint_pass(shape(), owner(), 10_000, 3, true);
        assert_ne!(pass.pass_id, [0u8; 32]);
    }

    #[test]
    fn test_pass_id_deterministic() {
        let p1 = mint_pass(shape(), owner(), 10_000, 3, true);
        let p2 = mint_pass(shape(), owner(), 10_000, 3, true);
        assert_eq!(p1.pass_id, p2.pass_id);
    }

    #[test]
    fn test_pass_uses_remaining_equals_max_uses() {
        let pass = mint_pass(shape(), owner(), 5_000, 7, false);
        assert_eq!(pass.uses_remaining, pass.max_uses);
        assert_eq!(pass.uses_remaining, 7);
    }

    #[test]
    fn test_consume_decrements_uses() {
        let mut pass = mint_pass(shape(), owner(), 10_000, 3, true);
        let remaining = consume_pass(&mut pass, &shape(), 1000).unwrap();
        assert_eq!(remaining, 2);
        assert_eq!(pass.uses_remaining, 2);
    }

    #[test]
    fn test_pass_at_expiry_slot_ok() {
        // current_slot > valid_until_slot is Expired; == is OK
        let mut pass = mint_pass(shape(), owner(), 500, 2, true);
        assert!(consume_pass(&mut pass, &shape(), 500).is_ok());
    }

    #[test]
    fn test_price_floor_enforced() {
        // pool_k=100 → divisor=20 → price=base/20 < base/10 → return base/10
        let base = 100_000u64;
        let price = price_pass_by_pool_depth(100, base);
        assert_eq!(price, base / 10);
    }

    #[test]
    fn test_k_boost_exhausted_pass_is_zero() {
        let mut pass = mint_pass(shape(), owner(), 10_000, 1, true);
        consume_pass(&mut pass, &shape(), 1000).unwrap();
        assert_eq!(pass.uses_remaining, 0);
        let boost = compute_k_shape_boost(&pass, 5);
        assert_eq!(boost, 0);
    }

    #[test]
    fn test_pass_id_owner_sensitive() {
        let o1 = [0xAAu8; 32];
        let o2 = [0xBBu8; 32];
        let p1 = mint_pass(shape(), o1, 10_000, 3, true);
        let p2 = mint_pass(shape(), o2, 10_000, 3, true);
        assert_ne!(p1.pass_id, p2.pass_id);
    }

    #[test]
    fn test_pass_id_shape_sensitive() {
        let s1 = [0x11u8; 32];
        let s2 = [0x22u8; 32];
        let p1 = mint_pass(s1, owner(), 10_000, 3, true);
        let p2 = mint_pass(s2, owner(), 10_000, 3, true);
        assert_ne!(p1.pass_id, p2.pass_id);
    }

    #[test]
    fn test_price_at_pool_depth_zero() {
        // pool_k=0 → divisor=max(0,1)=1 → price=base → max(base, base/10) = base
        let base = 50_000u64;
        let price = price_pass_by_pool_depth(0, base);
        assert_eq!(price, base);
    }
}
