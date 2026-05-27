use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub position_id: [u8; 32],
    pub borrower_hash: [u8; 32],
    pub collateral_commitment: [u8; 32],
    pub debt_commitment: [u8; 32],
    pub health_factor: u32,
    pub liquidatable: bool,
    pub liquidated: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Liquidation {
    pub liq_id: [u8; 32],
    pub position_id: [u8; 32],
    pub liquidator_hash: [u8; 32],
    pub repay_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum LiqError {
    ZeroBorrowerSecret,
    ZeroCollateral,
    ZeroDebt,
    NotLiquidatable,
    AlreadyLiquidated,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

// ── API ────────────────────────────────────────────────────────────────────

/// Creates a position with privacy-preserving commitments.
/// health_factor = collateral * 100 / debt (integer); liquidatable if < 100.
pub fn create_position(
    borrower_secret: &[u8; 32],
    collateral: u64,
    debt: u64,
    blinding_c: &[u8; 32],
    blinding_d: &[u8; 32],
) -> Result<Position, LiqError> {
    if borrower_secret == &[0u8; 32] {
        return Err(LiqError::ZeroBorrowerSecret);
    }
    if collateral == 0 {
        return Err(LiqError::ZeroCollateral);
    }
    if debt == 0 {
        return Err(LiqError::ZeroDebt);
    }

    let borrower_hash = sha256_multi(&[b"liq-borrower-v1", borrower_secret]);
    let collateral_commitment =
        sha256_multi(&[b"liq-collateral-v1", &collateral.to_le_bytes(), blinding_c]);
    let debt_commitment = sha256_multi(&[b"liq-debt-v1", &debt.to_le_bytes(), blinding_d]);
    let position_id = sha256_multi(&[
        b"liq-pos-v1",
        &borrower_hash,
        &collateral_commitment,
        &debt_commitment,
    ]);

    let health_factor = ((collateral as u128 * 100) / debt as u128) as u32;
    let liquidatable = health_factor < 100;

    Ok(Position {
        position_id,
        borrower_hash,
        collateral_commitment,
        debt_commitment,
        health_factor,
        liquidatable,
        liquidated: false,
        mainnet_ready: false,
    })
}

/// Liquidates a position if eligible.
pub fn liquidate(
    position: &mut Position,
    liquidator_secret: &[u8; 32],
) -> Result<Liquidation, LiqError> {
    if !position.liquidatable {
        return Err(LiqError::NotLiquidatable);
    }
    if position.liquidated {
        return Err(LiqError::AlreadyLiquidated);
    }

    let liquidator_hash = sha256_multi(&[b"liq-liquidator-v1", liquidator_secret]);
    let repay_hash = sha256_multi(&[b"liq-repay-v1", &position.position_id, &liquidator_hash]);
    let liq_id = sha256_multi(&[b"liq-id-v1", &repay_hash]);

    position.liquidated = true;

    Ok(Liquidation {
        liq_id,
        position_id: position.position_id,
        liquidator_hash,
        repay_hash,
        mainnet_ready: false,
    })
}

/// JSON: position_id, health_factor, liquidatable, mainnet_ready — NOT borrower_hash.
pub fn position_public_record(pos: &Position) -> String {
    serde_json::json!({
        "position_id": hex32(&pos.position_id),
        "health_factor": pos.health_factor,
        "liquidatable": pos.liquidatable,
        "mainnet_ready": pos.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b;
        s
    }

    #[test]
    fn test_liquidatable_position_created_and_liquidated() {
        // collateral=50, debt=100 → health_factor=50 < 100 → liquidatable
        let mut pos =
            create_position(&secret(0x01), 50, 100, &secret(0x11), &secret(0x22)).unwrap();
        assert!(pos.liquidatable);
        assert_eq!(pos.health_factor, 50);
        assert!(!pos.mainnet_ready);

        let liq = liquidate(&mut pos, &secret(0x33)).unwrap();
        assert!(!liq.mainnet_ready);
        assert_eq!(liq.position_id, pos.position_id);
        assert!(pos.liquidated);
    }

    #[test]
    fn test_non_liquidatable_rejected() {
        // collateral=200, debt=100 → health_factor=200 >= 100 → not liquidatable
        let mut pos =
            create_position(&secret(0x02), 200, 100, &secret(0x44), &secret(0x55)).unwrap();
        assert!(!pos.liquidatable);
        let err = liquidate(&mut pos, &secret(0x66)).unwrap_err();
        assert_eq!(err, LiqError::NotLiquidatable);
    }

    #[test]
    fn test_already_liquidated_rejected() {
        let mut pos =
            create_position(&secret(0x03), 50, 100, &secret(0x77), &secret(0x88)).unwrap();
        assert!(pos.liquidatable);
        let _ = liquidate(&mut pos, &secret(0x99)).unwrap();
        let err = liquidate(&mut pos, &secret(0xaa)).unwrap_err();
        assert_eq!(err, LiqError::AlreadyLiquidated);
    }

    #[test]
    fn test_zero_collateral_rejected() {
        let err = create_position(&secret(0x04), 0, 100, &secret(0xbb), &secret(0xcc)).unwrap_err();
        assert_eq!(err, LiqError::ZeroCollateral);
    }

    #[test]
    fn test_zero_borrower_rejected() {
        let err = create_position(&[0u8; 32], 50, 100, &secret(0xdd), &secret(0xee)).unwrap_err();
        assert_eq!(err, LiqError::ZeroBorrowerSecret);
    }

    #[test]
    fn test_public_record_hides_borrower() {
        let pos = create_position(&secret(0x05), 50, 100, &secret(0x12), &secret(0x13)).unwrap();
        let rec = position_public_record(&pos);
        let v: serde_json::Value = serde_json::from_str(&rec).unwrap();
        assert!(v["position_id"].is_string());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("borrower_hash").is_none());
        assert!(!rec.contains(&hex32(&pos.borrower_hash)));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_position_id_nonzero() {
        let pos = create_position(&secret(0x10), 50, 100, &secret(0x11), &secret(0x12)).unwrap();
        assert_ne!(pos.position_id, [0u8; 32]);
    }

    #[test]
    fn test_borrower_hash_nonzero() {
        let pos = create_position(&secret(0x13), 50, 100, &secret(0x14), &secret(0x15)).unwrap();
        assert_ne!(pos.borrower_hash, [0u8; 32]);
    }

    #[test]
    fn test_collateral_commitment_nonzero() {
        let pos = create_position(&secret(0x16), 50, 100, &secret(0x17), &secret(0x18)).unwrap();
        assert_ne!(pos.collateral_commitment, [0u8; 32]);
    }

    #[test]
    fn test_debt_commitment_nonzero() {
        let pos = create_position(&secret(0x19), 50, 100, &secret(0x1a), &secret(0x1b)).unwrap();
        assert_ne!(pos.debt_commitment, [0u8; 32]);
    }

    #[test]
    fn test_position_mainnet_ready_false() {
        let pos = create_position(&secret(0x1c), 50, 100, &secret(0x1d), &secret(0x1e)).unwrap();
        assert!(!pos.mainnet_ready);
    }

    #[test]
    fn test_liquidation_mainnet_ready_false() {
        let mut pos =
            create_position(&secret(0x1f), 50, 100, &secret(0x20), &secret(0x21)).unwrap();
        let liq = liquidate(&mut pos, &secret(0x22)).unwrap();
        assert!(!liq.mainnet_ready);
    }

    #[test]
    fn test_liq_id_nonzero() {
        let mut pos =
            create_position(&secret(0x23), 50, 100, &secret(0x24), &secret(0x25)).unwrap();
        let liq = liquidate(&mut pos, &secret(0x26)).unwrap();
        assert_ne!(liq.liq_id, [0u8; 32]);
    }

    #[test]
    fn test_zero_debt_rejected() {
        let err = create_position(&secret(0x27), 100, 0, &secret(0x28), &secret(0x29)).unwrap_err();
        assert_eq!(err, LiqError::ZeroDebt);
    }

    #[test]
    fn test_health_above_100_not_liquidatable() {
        let pos = create_position(&secret(0x2a), 200, 100, &secret(0x2b), &secret(0x2c)).unwrap();
        assert!(!pos.liquidatable);
        assert_eq!(pos.health_factor, 200);
    }

    #[test]
    fn test_liquidated_flag_set() {
        let mut pos =
            create_position(&secret(0x2d), 50, 100, &secret(0x2e), &secret(0x2f)).unwrap();
        liquidate(&mut pos, &secret(0x30)).unwrap();
        assert!(pos.liquidated);
    }
}
