use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FeeStatus {
    Pending,
    Released,
    Refunded,
}

impl FeeStatus {
    fn as_str(&self) -> &'static str {
        match self {
            FeeStatus::Pending => "Pending",
            FeeStatus::Released => "Released",
            FeeStatus::Refunded => "Refunded",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeeEscrow {
    pub escrow_id: [u8; 32],
    pub payer_hash: [u8; 32],
    pub fee_amount: u64,
    pub service_hash: [u8; 32],
    pub status: FeeStatus,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum FeeError {
    ZeroPayerSecret,
    ZeroFee,
    EmptyService,
    AlreadySettled,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_payer_hash(payer_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"fee-payer-v1");
    d.extend_from_slice(payer_secret);
    sha256(&d)
}

fn compute_service_hash(service_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"fee-service-v1");
    d.extend_from_slice(service_bytes);
    sha256(&d)
}

fn compute_escrow_id(
    payer_hash: &[u8; 32],
    fee_amount: u64,
    service_hash: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"fee-escrow-v1");
    d.extend_from_slice(payer_hash);
    d.extend_from_slice(&fee_amount.to_le_bytes());
    d.extend_from_slice(service_hash);
    d.extend_from_slice(nonce);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_fee_escrow(
    payer_secret: &[u8; 32],
    fee_amount: u64,
    service_bytes: &[u8],
    nonce: &[u8; 32],
) -> Result<FeeEscrow, FeeError> {
    if payer_secret == &[0u8; 32] {
        return Err(FeeError::ZeroPayerSecret);
    }
    if fee_amount == 0 {
        return Err(FeeError::ZeroFee);
    }
    if service_bytes.is_empty() {
        return Err(FeeError::EmptyService);
    }
    let payer_hash = compute_payer_hash(payer_secret);
    let service_hash = compute_service_hash(service_bytes);
    let escrow_id = compute_escrow_id(&payer_hash, fee_amount, &service_hash, nonce);
    Ok(FeeEscrow {
        escrow_id,
        payer_hash,
        fee_amount,
        service_hash,
        status: FeeStatus::Pending,
        mainnet_ready: false,
    })
}

pub fn release_fee(escrow: &mut FeeEscrow) -> Result<[u8; 32], FeeError> {
    if escrow.status != FeeStatus::Pending {
        return Err(FeeError::AlreadySettled);
    }
    escrow.status = FeeStatus::Released;
    Ok(escrow.escrow_id)
}

pub fn refund_fee(escrow: &mut FeeEscrow) -> Result<[u8; 32], FeeError> {
    if escrow.status != FeeStatus::Pending {
        return Err(FeeError::AlreadySettled);
    }
    escrow.status = FeeStatus::Refunded;
    Ok(escrow.escrow_id)
}

pub fn escrow_public_record(escrow: &FeeEscrow) -> String {
    serde_json::json!({
        "escrow_id": hex(&escrow.escrow_id),
        "fee_amount": escrow.fee_amount,
        "service_hash": hex(&escrow.service_hash),
        "status": escrow.status.as_str(),
        "mainnet_ready": escrow.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn payer() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xab;
        s
    }
    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x01;
        n
    }

    // Test 1: create + release happy path
    #[test]
    fn test_create_and_release() {
        let mut escrow = create_fee_escrow(&payer(), 500, b"agent-service", &nonce()).unwrap();
        assert_eq!(escrow.status, FeeStatus::Pending);
        assert!(!escrow.mainnet_ready);
        let id = release_fee(&mut escrow).unwrap();
        assert_eq!(id, escrow.escrow_id);
        assert_eq!(escrow.status, FeeStatus::Released);
    }

    // Test 2: create + refund happy path
    #[test]
    fn test_create_and_refund() {
        let mut escrow = create_fee_escrow(&payer(), 200, b"agent-service", &nonce()).unwrap();
        let id = refund_fee(&mut escrow).unwrap();
        assert_eq!(id, escrow.escrow_id);
        assert_eq!(escrow.status, FeeStatus::Refunded);
    }

    // Test 3: double release rejected (AlreadySettled)
    #[test]
    fn test_double_release_rejected() {
        let mut escrow = create_fee_escrow(&payer(), 100, b"svc", &nonce()).unwrap();
        release_fee(&mut escrow).unwrap();
        let err = release_fee(&mut escrow).unwrap_err();
        assert_eq!(err, FeeError::AlreadySettled);
    }

    // Test 4: zero payer secret rejected
    #[test]
    fn test_zero_payer_rejected() {
        let err = create_fee_escrow(&[0u8; 32], 100, b"svc", &nonce()).unwrap_err();
        assert_eq!(err, FeeError::ZeroPayerSecret);
    }

    // Test 5: zero fee rejected
    #[test]
    fn test_zero_fee_rejected() {
        let err = create_fee_escrow(&payer(), 0, b"svc", &nonce()).unwrap_err();
        assert_eq!(err, FeeError::ZeroFee);
    }

    // Test 6: public record hides payer_hash
    #[test]
    fn test_public_record_hides_payer() {
        let escrow = create_fee_escrow(&payer(), 750, b"agent-service", &nonce()).unwrap();
        let record = escrow_public_record(&escrow);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["escrow_id"].is_string());
        assert_eq!(v["fee_amount"], 750u64);
        assert_eq!(v["status"], "Pending");
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("payer_hash").is_none());
    }
}
