use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeDeposit {
    pub deposit_id: [u8; 32],
    pub depositor_hash: [u8; 32],
    pub amount: u64,
    pub source_chain_hash: [u8; 32],
    pub dest_chain_hash: [u8; 32],
    pub secret_hash: [u8; 32],
    pub claimed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeClaim {
    pub claim_id: [u8; 32],
    pub deposit_id: [u8; 32],
    pub claimer_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum BridgeError {
    ZeroDepositorSecret,
    ZeroAmount,
    SameChain,
    WrongSecret,
    AlreadyClaimed,
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

pub fn create_deposit(
    depositor_secret: &[u8; 32],
    amount: u64,
    source_chain: &[u8],
    dest_chain: &[u8],
    bridge_secret: &[u8; 32],
) -> Result<BridgeDeposit, BridgeError> {
    if depositor_secret == &[0u8; 32] {
        return Err(BridgeError::ZeroDepositorSecret);
    }
    if amount == 0 {
        return Err(BridgeError::ZeroAmount);
    }
    if source_chain == dest_chain {
        return Err(BridgeError::SameChain);
    }

    let depositor_hash = sha256_multi(&[b"bridge2-depositor-v1", depositor_secret]);
    let source_chain_hash = sha256_multi(&[b"bridge2-chain-v1", source_chain]);
    let dest_chain_hash = sha256_multi(&[b"bridge2-chain-v1", dest_chain]);
    let secret_hash = sha256_multi(&[b"bridge2-secret-v1", bridge_secret]);
    let amount_le = amount.to_le_bytes();
    let deposit_id = sha256_multi(&[
        b"bridge2-deposit-v1",
        &depositor_hash,
        &amount_le,
        &source_chain_hash,
        &dest_chain_hash,
        &secret_hash,
    ]);

    Ok(BridgeDeposit {
        deposit_id,
        depositor_hash,
        amount,
        source_chain_hash,
        dest_chain_hash,
        secret_hash,
        claimed: false,
        mainnet_ready: false,
    })
}

pub fn claim_deposit(
    deposit: &mut BridgeDeposit,
    claimer_secret: &[u8; 32],
    bridge_secret: &[u8; 32],
) -> Result<BridgeClaim, BridgeError> {
    if deposit.claimed {
        return Err(BridgeError::AlreadyClaimed);
    }
    let recomputed_secret_hash = sha256_multi(&[b"bridge2-secret-v1", bridge_secret]);
    if recomputed_secret_hash != deposit.secret_hash {
        return Err(BridgeError::WrongSecret);
    }

    let claimer_hash = sha256_multi(&[b"bridge2-claimer-v1", claimer_secret]);
    let claim_id = sha256_multi(&[b"bridge2-claim-v1", &deposit.deposit_id, &claimer_hash]);

    deposit.claimed = true;

    Ok(BridgeClaim {
        claim_id,
        deposit_id: deposit.deposit_id,
        claimer_hash,
        mainnet_ready: false,
    })
}

pub fn deposit_public_record(d: &BridgeDeposit) -> String {
    serde_json::json!({
        "deposit_id": hex32(&d.deposit_id),
        "source_chain_hash": hex32(&d.source_chain_hash),
        "dest_chain_hash": hex32(&d.dest_chain_hash),
        "amount": d.amount,
        "claimed": d.claimed,
        "mainnet_ready": d.mainnet_ready,
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
    fn test_create_and_claim_happy_path() {
        let depositor = secret(0x11);
        let claimer = secret(0x22);
        let bridge_secret = secret(0x33);

        let mut deposit =
            create_deposit(&depositor, 1000, b"solana", b"ethereum", &bridge_secret).unwrap();
        assert!(!deposit.claimed);
        assert!(!deposit.mainnet_ready);

        let claim = claim_deposit(&mut deposit, &claimer, &bridge_secret).unwrap();
        assert!(deposit.claimed);
        assert!(!claim.mainnet_ready);
        assert_eq!(claim.deposit_id, deposit.deposit_id);
    }

    #[test]
    fn test_wrong_secret_rejected() {
        let depositor = secret(0x44);
        let bridge_secret = secret(0x55);
        let wrong_secret = secret(0x66);

        let mut deposit =
            create_deposit(&depositor, 500, b"solana", b"ethereum", &bridge_secret).unwrap();
        let err = claim_deposit(&mut deposit, &depositor, &wrong_secret).unwrap_err();
        assert_eq!(err, BridgeError::WrongSecret);
    }

    #[test]
    fn test_already_claimed_rejected() {
        let depositor = secret(0x77);
        let bridge_secret = secret(0x88);

        let mut deposit =
            create_deposit(&depositor, 100, b"solana", b"polygon", &bridge_secret).unwrap();
        claim_deposit(&mut deposit, &depositor, &bridge_secret).unwrap();
        let err = claim_deposit(&mut deposit, &depositor, &bridge_secret).unwrap_err();
        assert_eq!(err, BridgeError::AlreadyClaimed);
    }

    #[test]
    fn test_same_chain_rejected() {
        let depositor = secret(0x99);
        let bridge_secret = secret(0xaa);
        let err =
            create_deposit(&depositor, 100, b"solana", b"solana", &bridge_secret).unwrap_err();
        assert_eq!(err, BridgeError::SameChain);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let depositor = secret(0xbb);
        let bridge_secret = secret(0xcc);
        let err =
            create_deposit(&depositor, 0, b"solana", b"ethereum", &bridge_secret).unwrap_err();
        assert_eq!(err, BridgeError::ZeroAmount);
    }

    #[test]
    fn test_public_record_hides_depositor() {
        let depositor = secret(0xdd);
        let bridge_secret = secret(0xee);
        let deposit =
            create_deposit(&depositor, 250, b"solana", b"ethereum", &bridge_secret).unwrap();
        let record = deposit_public_record(&deposit);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["deposit_id"].is_string());
        assert_eq!(v["amount"], 250);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("depositor_hash").is_none());
        assert!(!record.contains(&hex32(&deposit.depositor_hash)));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_deposit_id_nonzero() {
        let deposit = create_deposit(&secret(0x01), 100, b"sol", b"eth", &secret(0x02)).unwrap();
        assert_ne!(deposit.deposit_id, [0u8; 32]);
    }

    #[test]
    fn test_depositor_hash_nonzero() {
        let deposit = create_deposit(&secret(0x03), 100, b"sol", b"eth", &secret(0x04)).unwrap();
        assert_ne!(deposit.depositor_hash, [0u8; 32]);
    }

    #[test]
    fn test_source_chain_hash_nonzero() {
        let deposit = create_deposit(&secret(0x05), 100, b"sol", b"eth", &secret(0x06)).unwrap();
        assert_ne!(deposit.source_chain_hash, [0u8; 32]);
    }

    #[test]
    fn test_dest_chain_hash_nonzero() {
        let deposit = create_deposit(&secret(0x07), 100, b"sol", b"eth", &secret(0x08)).unwrap();
        assert_ne!(deposit.dest_chain_hash, [0u8; 32]);
    }

    #[test]
    fn test_secret_hash_nonzero() {
        let deposit = create_deposit(&secret(0x09), 100, b"sol", b"eth", &secret(0x0a)).unwrap();
        assert_ne!(deposit.secret_hash, [0u8; 32]);
    }

    #[test]
    fn test_deposit_mainnet_ready_false() {
        let deposit = create_deposit(&secret(0x0b), 100, b"sol", b"eth", &secret(0x0c)).unwrap();
        assert!(!deposit.mainnet_ready);
    }

    #[test]
    fn test_claim_mainnet_ready_false() {
        let mut deposit =
            create_deposit(&secret(0x0d), 100, b"sol", b"eth", &secret(0x0e)).unwrap();
        let claim = claim_deposit(&mut deposit, &secret(0x0f), &secret(0x0e)).unwrap();
        assert!(!claim.mainnet_ready);
    }

    #[test]
    fn test_claim_id_nonzero() {
        let mut deposit =
            create_deposit(&secret(0x10), 100, b"sol", b"eth", &secret(0x11)).unwrap();
        let claim = claim_deposit(&mut deposit, &secret(0x12), &secret(0x11)).unwrap();
        assert_ne!(claim.claim_id, [0u8; 32]);
    }

    #[test]
    fn test_deposit_id_deterministic() {
        let d1 = create_deposit(&secret(0x13), 500, b"sol", b"eth", &secret(0x14)).unwrap();
        let d2 = create_deposit(&secret(0x13), 500, b"sol", b"eth", &secret(0x14)).unwrap();
        assert_eq!(d1.deposit_id, d2.deposit_id);
    }

    #[test]
    fn test_zero_depositor_secret_rejected() {
        let err = create_deposit(&[0u8; 32], 100, b"sol", b"eth", &secret(0x15)).unwrap_err();
        assert_eq!(err, BridgeError::ZeroDepositorSecret);
    }
}
