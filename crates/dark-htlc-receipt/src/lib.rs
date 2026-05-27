use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DOMAIN_CONTRACT: &[u8] = b"dark-htlc-contract-v1";
const DOMAIN_PARTY: &[u8] = b"dark-htlc-party-v1";
const DOMAIN_STATUS: &[u8] = b"dark-htlc-status-v1";
const DOMAIN_CLAIM: &[u8] = b"dark-htlc-claim-v1";
const DOMAIN_REFUND: &[u8] = b"dark-htlc-refund-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HtlcReceipt {
    pub contract_id: [u8; 32],
    pub payer_hash: [u8; 32],
    pub receiver_hash: [u8; 32],
    pub hashlock: [u8; 32],
    pub amount: u64,
    pub created_slot: u64,
    pub timeout_slot: u64,
    pub status_commitment: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HtlcClaim {
    pub contract_id: [u8; 32],
    pub preimage_hash: [u8; 32],
    pub claimed_slot: u64,
    pub receipt_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HtlcRefund {
    pub contract_id: [u8; 32],
    pub refunded_slot: u64,
    pub receipt_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HtlcError {
    EmptyParty,
    ZeroAmount,
    TimeoutNotFuture,
    InvalidPreimage,
    ClaimAfterTimeout,
    RefundBeforeTimeout,
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for part in parts {
        h.update(part);
    }
    h.finalize().into()
}

fn party_hash(party_id: &[u8]) -> Result<[u8; 32], HtlcError> {
    if party_id.is_empty() {
        return Err(HtlcError::EmptyParty);
    }
    Ok(sha256(&[DOMAIN_PARTY, party_id]))
}

fn contract_id(
    payer_hash: &[u8; 32],
    receiver_hash: &[u8; 32],
    hashlock: &[u8; 32],
    amount: u64,
    created_slot: u64,
    timeout_slot: u64,
) -> [u8; 32] {
    sha256(&[
        DOMAIN_CONTRACT,
        payer_hash,
        receiver_hash,
        hashlock,
        &amount.to_be_bytes(),
        &created_slot.to_be_bytes(),
        &timeout_slot.to_be_bytes(),
    ])
}

fn status_commitment(contract_id: &[u8; 32], label: &[u8], slot: u64) -> [u8; 32] {
    sha256(&[DOMAIN_STATUS, contract_id, label, &slot.to_be_bytes()])
}

pub fn hash_preimage(preimage: &[u8]) -> [u8; 32] {
    sha256(&[b"dark-htlc-preimage-v1", preimage])
}

pub fn create_htlc(
    payer_id: &[u8],
    receiver_id: &[u8],
    hashlock: [u8; 32],
    amount: u64,
    created_slot: u64,
    timeout_slot: u64,
) -> Result<HtlcReceipt, HtlcError> {
    if amount == 0 {
        return Err(HtlcError::ZeroAmount);
    }
    if timeout_slot <= created_slot {
        return Err(HtlcError::TimeoutNotFuture);
    }
    let payer_hash = party_hash(payer_id)?;
    let receiver_hash = party_hash(receiver_id)?;
    let contract_id = contract_id(
        &payer_hash,
        &receiver_hash,
        &hashlock,
        amount,
        created_slot,
        timeout_slot,
    );
    Ok(HtlcReceipt {
        contract_id,
        payer_hash,
        receiver_hash,
        hashlock,
        amount,
        created_slot,
        timeout_slot,
        status_commitment: status_commitment(&contract_id, b"open", created_slot),
        mainnet_ready: false,
    })
}

pub fn claim_htlc(
    receipt: &HtlcReceipt,
    preimage: &[u8],
    claimed_slot: u64,
) -> Result<HtlcClaim, HtlcError> {
    if claimed_slot > receipt.timeout_slot {
        return Err(HtlcError::ClaimAfterTimeout);
    }
    let preimage_hash = hash_preimage(preimage);
    if preimage_hash != receipt.hashlock {
        return Err(HtlcError::InvalidPreimage);
    }
    let receipt_hash = sha256(&[
        DOMAIN_CLAIM,
        &receipt.contract_id,
        &preimage_hash,
        &claimed_slot.to_be_bytes(),
    ]);
    Ok(HtlcClaim {
        contract_id: receipt.contract_id,
        preimage_hash,
        claimed_slot,
        receipt_hash,
        mainnet_ready: false,
    })
}

pub fn refund_htlc(receipt: &HtlcReceipt, refunded_slot: u64) -> Result<HtlcRefund, HtlcError> {
    if refunded_slot < receipt.timeout_slot {
        return Err(HtlcError::RefundBeforeTimeout);
    }
    let receipt_hash = sha256(&[
        DOMAIN_REFUND,
        &receipt.contract_id,
        &refunded_slot.to_be_bytes(),
    ]);
    Ok(HtlcRefund {
        contract_id: receipt.contract_id,
        refunded_slot,
        receipt_hash,
        mainnet_ready: false,
    })
}

pub fn public_record(receipt: &HtlcReceipt) -> String {
    serde_json::json!({
        "contract_id": hex(&receipt.contract_id),
        "hashlock": hex(&receipt.hashlock),
        "amount": receipt.amount,
        "created_slot": receipt.created_slot,
        "timeout_slot": receipt.timeout_slot,
        "status_commitment": hex(&receipt.status_commitment),
        "mainnet_ready": receipt.mainnet_ready,
    })
    .to_string()
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> HtlcReceipt {
        create_htlc(b"payer", b"receiver", hash_preimage(b"secret"), 500, 10, 20).unwrap()
    }

    #[test]
    fn create_and_claim_happy_path() {
        let r = sample();
        let c = claim_htlc(&r, b"secret", 15).unwrap();
        assert_eq!(c.contract_id, r.contract_id);
        assert_eq!(c.preimage_hash, r.hashlock);
        assert!(!c.mainnet_ready);
    }

    #[test]
    fn wrong_preimage_rejected() {
        assert_eq!(
            claim_htlc(&sample(), b"wrong", 15).unwrap_err(),
            HtlcError::InvalidPreimage
        );
    }

    #[test]
    fn claim_after_timeout_rejected() {
        assert_eq!(
            claim_htlc(&sample(), b"secret", 21).unwrap_err(),
            HtlcError::ClaimAfterTimeout
        );
    }

    #[test]
    fn refund_after_timeout_ok() {
        let refund = refund_htlc(&sample(), 20).unwrap();
        assert_eq!(refund.refunded_slot, 20);
        assert!(!refund.mainnet_ready);
    }

    #[test]
    fn refund_before_timeout_rejected() {
        assert_eq!(
            refund_htlc(&sample(), 19).unwrap_err(),
            HtlcError::RefundBeforeTimeout
        );
    }

    #[test]
    fn zero_amount_rejected() {
        assert_eq!(
            create_htlc(b"payer", b"receiver", hash_preimage(b"x"), 0, 1, 2).unwrap_err(),
            HtlcError::ZeroAmount
        );
    }

    #[test]
    fn timeout_must_be_future() {
        assert_eq!(
            create_htlc(b"payer", b"receiver", hash_preimage(b"x"), 1, 2, 2).unwrap_err(),
            HtlcError::TimeoutNotFuture
        );
    }

    #[test]
    fn public_record_hides_parties() {
        let record = public_record(&sample());
        assert!(!record.contains("payer"));
        assert!(!record.contains("receiver"));
        assert!(record.contains("contract_id"));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let r = sample();
        assert!(!r.mainnet_ready);
        let c = claim_htlc(&r, b"secret", 15).unwrap();
        assert!(!c.mainnet_ready);
        let rf = refund_htlc(&r, 20).unwrap();
        assert!(!rf.mainnet_ready);
    }

    #[test]
    fn test_hash_preimage_deterministic() {
        let h1 = hash_preimage(b"my-secret");
        let h2 = hash_preimage(b"my-secret");
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_different_preimage_different_hash() {
        let h1 = hash_preimage(b"secret-alpha");
        let h2 = hash_preimage(b"secret-beta");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_contract_id_deterministic() {
        let r1 = create_htlc(b"payer", b"recv", hash_preimage(b"s"), 100, 1, 50).unwrap();
        let r2 = create_htlc(b"payer", b"recv", hash_preimage(b"s"), 100, 1, 50).unwrap();
        assert_eq!(r1.contract_id, r2.contract_id);
    }

    #[test]
    fn test_contract_id_sensitive_to_amount() {
        let r1 = create_htlc(b"payer", b"recv", hash_preimage(b"s"), 100, 1, 50).unwrap();
        let r2 = create_htlc(b"payer", b"recv", hash_preimage(b"s"), 200, 1, 50).unwrap();
        assert_ne!(r1.contract_id, r2.contract_id);
    }

    #[test]
    fn test_claim_exactly_at_timeout_slot_succeeds() {
        // current implementation uses > (strict), so claiming at timeout_slot is allowed
        let r = sample(); // timeout_slot = 20
        let c = claim_htlc(&r, b"secret", 20).unwrap();
        assert_eq!(c.claimed_slot, 20);
    }

    #[test]
    fn test_claim_receipt_hash_deterministic() {
        let r = sample();
        let c1 = claim_htlc(&r, b"secret", 15).unwrap();
        let c2 = claim_htlc(&r, b"secret", 15).unwrap();
        assert_eq!(c1.receipt_hash, c2.receipt_hash);
    }

    #[test]
    fn test_claim_receipt_hash_slot_sensitive() {
        let r = sample();
        let c1 = claim_htlc(&r, b"secret", 14).unwrap();
        let c2 = claim_htlc(&r, b"secret", 15).unwrap();
        assert_ne!(c1.receipt_hash, c2.receipt_hash);
    }

    #[test]
    fn test_refund_receipt_hash_deterministic() {
        let r = sample();
        let rf1 = refund_htlc(&r, 25).unwrap();
        let rf2 = refund_htlc(&r, 25).unwrap();
        assert_eq!(rf1.receipt_hash, rf2.receipt_hash);
    }

    #[test]
    fn test_empty_payer_rejected() {
        let err = create_htlc(b"", b"recv", hash_preimage(b"s"), 100, 1, 50).unwrap_err();
        assert_eq!(err, HtlcError::EmptyParty);
    }

    #[test]
    fn test_public_record_contains_hashlock_and_amount() {
        let record = public_record(&sample());
        assert!(record.contains("hashlock"));
        assert!(record.contains("amount"));
        assert!(record.contains("timeout_slot"));
    }
}
