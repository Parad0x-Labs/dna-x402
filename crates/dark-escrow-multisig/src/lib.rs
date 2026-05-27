use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultisigEscrow {
    pub escrow_id: [u8; 32],
    pub signers: Vec<[u8; 32]>,
    pub threshold: u8,
    pub amount: u64,
    pub condition_hash: [u8; 32],
    pub approved_count: u8,
    pub released: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Approval {
    pub signer_hash: [u8; 32],
    pub approval_hash: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum EscrowError {
    ZeroAmount,
    ThresholdZero,
    ThresholdExceedsSigners,
    AlreadyReleased,
    InsufficientApprovals,
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

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

fn compute_signer_hash(signer_secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"msig-signer-v1");
    d.extend_from_slice(signer_secret);
    sha256(&d)
}

fn compute_condition_hash(condition_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"msig-condition-v1");
    d.extend_from_slice(condition_bytes);
    sha256(&d)
}

fn compute_escrow_id(
    signer_hashes: &[[u8; 32]],
    amount: u64,
    condition_hash: &[u8; 32],
    threshold: u8,
) -> [u8; 32] {
    let xor = xor_fold(signer_hashes);
    let mut d = Vec::new();
    d.extend_from_slice(b"msig-escrow-v1");
    d.extend_from_slice(&xor);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(condition_hash);
    d.push(threshold);
    sha256(&d)
}

fn compute_approval_hash(escrow_id: &[u8; 32], signer_hash: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"msig-approve-v1");
    d.extend_from_slice(escrow_id);
    d.extend_from_slice(signer_hash);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_escrow(
    signer_secrets: &[[u8; 32]],
    threshold: u8,
    amount: u64,
    condition_bytes: &[u8],
) -> Result<MultisigEscrow, EscrowError> {
    if amount == 0 {
        return Err(EscrowError::ZeroAmount);
    }
    if threshold == 0 {
        return Err(EscrowError::ThresholdZero);
    }
    if threshold as usize > signer_secrets.len() {
        return Err(EscrowError::ThresholdExceedsSigners);
    }

    let signer_hashes: Vec<[u8; 32]> = signer_secrets
        .iter()
        .map(|s| compute_signer_hash(s))
        .collect();
    let condition_hash = compute_condition_hash(condition_bytes);
    let escrow_id = compute_escrow_id(&signer_hashes, amount, &condition_hash, threshold);

    Ok(MultisigEscrow {
        escrow_id,
        signers: signer_hashes,
        threshold,
        amount,
        condition_hash,
        approved_count: 0,
        released: false,
        mainnet_ready: false,
    })
}

pub fn approve(escrow: &MultisigEscrow, signer_secret: &[u8; 32]) -> Approval {
    let signer_hash = compute_signer_hash(signer_secret);
    let approval_hash = compute_approval_hash(&escrow.escrow_id, &signer_hash);
    Approval {
        signer_hash,
        approval_hash,
    }
}

pub fn release(
    escrow: &mut MultisigEscrow,
    approvals: &[Approval],
) -> Result<[u8; 32], EscrowError> {
    if escrow.released {
        return Err(EscrowError::AlreadyReleased);
    }
    if (approvals.len() as u8) < escrow.threshold {
        return Err(EscrowError::InsufficientApprovals);
    }

    escrow.approved_count = approvals.len() as u8;
    escrow.released = true;
    Ok(escrow.escrow_id)
}

pub fn escrow_public_record(escrow: &MultisigEscrow) -> String {
    serde_json::json!({
        "escrow_id": hex(&escrow.escrow_id),
        "threshold": escrow.threshold,
        "amount": escrow.amount,
        "approved_count": escrow.approved_count,
        "released": escrow.released,
        "mainnet_ready": escrow.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = b + 1;
        s
    }

    fn three_signers() -> Vec<[u8; 32]> {
        vec![secret(1), secret(2), secret(3)]
    }

    // Test 1: create + approve + release happy path (3 signers, threshold=2)
    #[test]
    fn test_happy_path() {
        let secrets = three_signers();
        let mut escrow = create_escrow(&secrets, 2, 5000, b"release-on-delivery").unwrap();
        assert!(!escrow.mainnet_ready);
        assert!(!escrow.released);

        let a1 = approve(&escrow, &secrets[0]);
        let a2 = approve(&escrow, &secrets[1]);

        let eid = release(&mut escrow, &[a1, a2]).unwrap();
        assert_eq!(eid, escrow.escrow_id);
        assert!(escrow.released);
        assert_eq!(escrow.approved_count, 2);
    }

    // Test 2: insufficient approvals rejected
    #[test]
    fn test_insufficient_approvals() {
        let secrets = three_signers();
        let mut escrow = create_escrow(&secrets, 2, 1000, b"cond").unwrap();
        let a1 = approve(&escrow, &secrets[0]);
        let err = release(&mut escrow, &[a1]).unwrap_err();
        assert_eq!(err, EscrowError::InsufficientApprovals);
    }

    // Test 3: zero amount rejected
    #[test]
    fn test_zero_amount_rejected() {
        let err = create_escrow(&three_signers(), 1, 0, b"cond").unwrap_err();
        assert_eq!(err, EscrowError::ZeroAmount);
    }

    // Test 4: threshold zero rejected
    #[test]
    fn test_threshold_zero_rejected() {
        let err = create_escrow(&three_signers(), 0, 1000, b"cond").unwrap_err();
        assert_eq!(err, EscrowError::ThresholdZero);
    }

    // Test 5: already released rejected
    #[test]
    fn test_already_released() {
        let secrets = three_signers();
        let mut escrow = create_escrow(&secrets, 1, 999, b"cond").unwrap();
        let a1 = approve(&escrow, &secrets[0]);
        let a2 = approve(&escrow, &secrets[0]);
        release(&mut escrow, &[a1]).unwrap();
        let err = release(&mut escrow, &[a2]).unwrap_err();
        assert_eq!(err, EscrowError::AlreadyReleased);
    }

    // Test 6: public record hides signer secrets
    #[test]
    fn test_public_record_hides_signers() {
        let secrets = three_signers();
        let escrow = create_escrow(&secrets, 2, 7777, b"release-cond").unwrap();
        let record = escrow_public_record(&escrow);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["escrow_id"].is_string());
        assert_eq!(v["threshold"], 2u8);
        assert_eq!(v["amount"], 7777u64);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("signers").is_none());
        assert!(v.get("signer_secrets").is_none());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_escrow_id_nonzero() {
        let escrow = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        assert_ne!(escrow.escrow_id, [0u8; 32]);
    }

    #[test]
    fn test_escrow_id_deterministic() {
        let e1 = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        let e2 = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        assert_eq!(e1.escrow_id, e2.escrow_id);
    }

    #[test]
    fn test_approval_hash_nonzero() {
        let escrow = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        let approval = approve(&escrow, &three_signers()[0]);
        assert_ne!(approval.approval_hash, [0u8; 32]);
    }

    #[test]
    fn test_approval_deterministic() {
        let escrow = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        let a1 = approve(&escrow, &three_signers()[0]);
        let a2 = approve(&escrow, &three_signers()[0]);
        assert_eq!(a1.approval_hash, a2.approval_hash);
    }

    #[test]
    fn test_mainnet_ready_always_false() {
        let escrow = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        assert!(!escrow.mainnet_ready);
    }

    #[test]
    fn test_threshold_exceeds_signers_rejected() {
        let secrets = vec![secret(1), secret(2)]; // 2 signers
        let err = create_escrow(&secrets, 3, 1000, b"cond").unwrap_err(); // threshold=3 > 2
        assert_eq!(err, EscrowError::ThresholdExceedsSigners);
    }

    #[test]
    fn test_released_starts_false() {
        let escrow = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        assert!(!escrow.released);
    }

    #[test]
    fn test_approved_count_starts_zero() {
        let escrow = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        assert_eq!(escrow.approved_count, 0);
    }

    #[test]
    fn test_release_at_exact_threshold_ok() {
        let secrets = three_signers();
        let mut escrow = create_escrow(&secrets, 2, 1000, b"cond").unwrap();
        let a1 = approve(&escrow, &secrets[0]);
        let a2 = approve(&escrow, &secrets[1]);
        // exactly threshold approvals
        assert!(release(&mut escrow, &[a1, a2]).is_ok());
    }

    #[test]
    fn test_escrow_id_amount_sensitive() {
        let e1 = create_escrow(&three_signers(), 2, 1000, b"cond").unwrap();
        let e2 = create_escrow(&three_signers(), 2, 2000, b"cond").unwrap();
        assert_ne!(e1.escrow_id, e2.escrow_id);
    }
}
