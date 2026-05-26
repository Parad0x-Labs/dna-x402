use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivateTransfer {
    pub transfer_id: [u8; 32],
    pub sender_commitment: [u8; 32],
    pub receiver_commitment: [u8; 32],
    pub amount_commitment: [u8; 32],
    pub nullifier: [u8; 32],
    pub settled: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum TransferError {
    ZeroSenderSecret,
    ZeroReceiverSecret,
    ZeroAmount,
    AlreadySettled,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

pub fn compute_sender_commitment(sender_secret: &[u8; 32], blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ptv2-sender-v1");
    d.extend_from_slice(sender_secret);
    d.extend_from_slice(blinding);
    sha256_bytes(&d)
}

pub fn compute_receiver_commitment(receiver_secret: &[u8; 32], blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ptv2-receiver-v1");
    d.extend_from_slice(receiver_secret);
    d.extend_from_slice(blinding);
    sha256_bytes(&d)
}

pub fn compute_amount_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ptv2-amount-v1");
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(blinding);
    sha256_bytes(&d)
}

pub fn compute_nullifier(sender_commit: &[u8; 32], amount_commit: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ptv2-null-v1");
    d.extend_from_slice(sender_commit);
    d.extend_from_slice(amount_commit);
    sha256_bytes(&d)
}

pub fn compute_transfer_id(
    sender_commit: &[u8; 32],
    receiver_commit: &[u8; 32],
    nullifier: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"ptv2-id-v1");
    d.extend_from_slice(sender_commit);
    d.extend_from_slice(receiver_commit);
    d.extend_from_slice(nullifier);
    sha256_bytes(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_transfer(
    sender_secret: &[u8; 32],
    receiver_secret: &[u8; 32],
    amount: u64,
    sender_blinding: &[u8; 32],
    receiver_blinding: &[u8; 32],
    amount_blinding: &[u8; 32],
) -> Result<PrivateTransfer, TransferError> {
    if sender_secret == &[0u8; 32] {
        return Err(TransferError::ZeroSenderSecret);
    }
    if receiver_secret == &[0u8; 32] {
        return Err(TransferError::ZeroReceiverSecret);
    }
    if amount == 0 {
        return Err(TransferError::ZeroAmount);
    }
    let sender_commitment   = compute_sender_commitment(sender_secret, sender_blinding);
    let receiver_commitment = compute_receiver_commitment(receiver_secret, receiver_blinding);
    let amount_commitment   = compute_amount_commitment(amount, amount_blinding);
    let nullifier           = compute_nullifier(&sender_commitment, &amount_commitment);
    let transfer_id         = compute_transfer_id(&sender_commitment, &receiver_commitment, &nullifier);
    Ok(PrivateTransfer {
        transfer_id,
        sender_commitment,
        receiver_commitment,
        amount_commitment,
        nullifier,
        settled: false,
        mainnet_ready: false,
    })
}

pub fn settle_transfer(transfer: &mut PrivateTransfer) -> Result<(), TransferError> {
    if transfer.settled {
        return Err(TransferError::AlreadySettled);
    }
    transfer.settled = true;
    Ok(())
}

pub fn verify_transfer(transfer: &PrivateTransfer) -> bool {
    transfer.transfer_id != [0u8; 32]
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(b: u8) -> [u8; 32] { [b; 32] }
    fn blind(b: u8)  -> [u8; 32] { [b; 32] }

    // Test 1: new_transfer all fields correct + mainnet_ready=false
    #[test]
    fn test_new_transfer_fields_correct() {
        let t = new_transfer(
            &secret(0xaa), &secret(0xbb), 1000,
            &blind(0x01), &blind(0x02), &blind(0x03),
        ).unwrap();
        assert!(!t.mainnet_ready);
        assert!(!t.settled);

        let sc  = compute_sender_commitment(&secret(0xaa), &blind(0x01));
        let rc  = compute_receiver_commitment(&secret(0xbb), &blind(0x02));
        let ac  = compute_amount_commitment(1000, &blind(0x03));
        let nul = compute_nullifier(&sc, &ac);
        let tid = compute_transfer_id(&sc, &rc, &nul);
        assert_eq!(t.sender_commitment, sc);
        assert_eq!(t.receiver_commitment, rc);
        assert_eq!(t.amount_commitment, ac);
        assert_eq!(t.nullifier, nul);
        assert_eq!(t.transfer_id, tid);
        assert!(verify_transfer(&t));
    }

    // Test 2: settle sets flag
    #[test]
    fn test_settle_sets_flag() {
        let mut t = new_transfer(
            &secret(0xaa), &secret(0xbb), 500,
            &blind(0x01), &blind(0x02), &blind(0x03),
        ).unwrap();
        assert!(!t.settled);
        settle_transfer(&mut t).unwrap();
        assert!(t.settled);
    }

    // Test 3: double-settle rejected
    #[test]
    fn test_double_settle_rejected() {
        let mut t = new_transfer(
            &secret(0xaa), &secret(0xbb), 500,
            &blind(0x01), &blind(0x02), &blind(0x03),
        ).unwrap();
        settle_transfer(&mut t).unwrap();
        let err = settle_transfer(&mut t).unwrap_err();
        assert_eq!(err, TransferError::AlreadySettled);
    }

    // Test 4: zero_sender rejected
    #[test]
    fn test_zero_sender_rejected() {
        let err = new_transfer(
            &[0u8; 32], &secret(0xbb), 500,
            &blind(0x01), &blind(0x02), &blind(0x03),
        ).unwrap_err();
        assert_eq!(err, TransferError::ZeroSenderSecret);
    }

    // Test 5: zero_amount rejected
    #[test]
    fn test_zero_amount_rejected() {
        let err = new_transfer(
            &secret(0xaa), &secret(0xbb), 0,
            &blind(0x01), &blind(0x02), &blind(0x03),
        ).unwrap_err();
        assert_eq!(err, TransferError::ZeroAmount);
    }

    // Test 6: different amounts → different amount_commitments
    #[test]
    fn test_different_amounts_different_commitments() {
        let ac1 = compute_amount_commitment(100, &blind(0x55));
        let ac2 = compute_amount_commitment(200, &blind(0x55));
        assert_ne!(ac1, ac2);
    }
}
