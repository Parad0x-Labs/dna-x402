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
}
