use sha2::{Digest, Sha256};

// Domain prefixes
const DOMAIN_DISPUTE: u8 = 0x40;
const DOMAIN_RESOLUTION: u8 = 0x41;

#[derive(Clone, Debug)]
pub struct DisputeReceipt {
    pub dispute_id: [u8; 32],
    pub receipt_hash: [u8; 32],
    pub service_hash: [u8; 32],
    pub failure_code_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub deadline_slot: u64,
    pub requested_refund_lamports: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DisputeError {
    AfterDeadline,
    WrongReceipt,
    RefundExceedsReceipt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    RefundApproved,
    RefundDenied,
    PartialRefund(u64),
}

#[derive(Clone, Debug)]
pub struct ResolutionCapsule {
    pub dispute_id: [u8; 32],
    pub resolution: Resolution,
    pub counter_signer: [u8; 32],
}

/// SHA256(0x40 || dispute_id || receipt_hash || service_hash || failure_code_hash || evidence_hash || deadline_slot || requested_refund_lamports)
pub fn dispute_commitment(d: &DisputeReceipt) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update([DOMAIN_DISPUTE]);
    h.update(d.dispute_id);
    h.update(d.receipt_hash);
    h.update(d.service_hash);
    h.update(d.failure_code_hash);
    h.update(d.evidence_hash);
    h.update(d.deadline_slot.to_le_bytes());
    h.update(d.requested_refund_lamports.to_le_bytes());
    h.finalize().into()
}

/// File a dispute. `max_refund_lamports` is the original spend amount used to cap refunds.
pub fn file_dispute(
    receipt_hash: [u8; 32],
    dispute_id: [u8; 32],
    service_hash: [u8; 32],
    failure_code_hash: [u8; 32],
    evidence_hash: [u8; 32],
    deadline_slot: u64,
    requested_refund_lamports: u64,
    max_refund_lamports: u64,
    expected_receipt_hash: [u8; 32],
    current_slot: u64,
) -> Result<DisputeReceipt, DisputeError> {
    if current_slot > deadline_slot {
        return Err(DisputeError::AfterDeadline);
    }
    if receipt_hash != expected_receipt_hash {
        return Err(DisputeError::WrongReceipt);
    }
    if requested_refund_lamports > max_refund_lamports {
        return Err(DisputeError::RefundExceedsReceipt);
    }
    Ok(DisputeReceipt {
        dispute_id,
        receipt_hash,
        service_hash,
        failure_code_hash,
        evidence_hash,
        deadline_slot,
        requested_refund_lamports,
    })
}

/// Counter-sign a dispute with a resolution. Returns a capsule binding the resolution to the dispute.
pub fn counter_sign(
    dispute: &DisputeReceipt,
    resolution: Resolution,
    signer_hash: [u8; 32],
) -> ResolutionCapsule {
    ResolutionCapsule {
        dispute_id: dispute.dispute_id,
        resolution,
        counter_signer: signer_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_dispute() -> DisputeReceipt {
        DisputeReceipt {
            dispute_id: [0x01u8; 32],
            receipt_hash: [0x02u8; 32],
            service_hash: [0x03u8; 32],
            failure_code_hash: [0x04u8; 32],
            evidence_hash: [0x05u8; 32],
            deadline_slot: 5000,
            requested_refund_lamports: 500_000,
        }
    }

    #[test]
    fn test_file_dispute_ok() {
        let d = file_dispute(
            [0x02u8; 32], // receipt_hash matches expected
            [0x01u8; 32], // dispute_id
            [0x03u8; 32], // service_hash
            [0x04u8; 32], // failure_code_hash
            [0x05u8; 32], // evidence_hash
            5000,         // deadline_slot
            500_000,      // requested_refund
            1_000_000,    // max_refund
            [0x02u8; 32], // expected_receipt_hash
            4000,         // current_slot (before deadline)
        )
        .unwrap();
        assert_eq!(d.requested_refund_lamports, 500_000);
    }

    #[test]
    fn test_late_dispute_rejected() {
        let err = file_dispute(
            [0x02u8; 32],
            [0x01u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
            [0x05u8; 32],
            5000,
            500_000,
            1_000_000,
            [0x02u8; 32],
            5001, // after deadline
        )
        .unwrap_err();
        assert_eq!(err, DisputeError::AfterDeadline);
    }

    #[test]
    fn test_wrong_receipt_rejected() {
        let err = file_dispute(
            [0xFFu8; 32], // receipt_hash does not match expected
            [0x01u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
            [0x05u8; 32],
            5000,
            500_000,
            1_000_000,
            [0x02u8; 32], // expected differs
            4000,
        )
        .unwrap_err();
        assert_eq!(err, DisputeError::WrongReceipt);
    }

    #[test]
    fn test_refund_exceeds_rejected() {
        let err = file_dispute(
            [0x02u8; 32],
            [0x01u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
            [0x05u8; 32],
            5000,
            2_000_000, // requested exceeds max
            1_000_000, // max
            [0x02u8; 32],
            4000,
        )
        .unwrap_err();
        assert_eq!(err, DisputeError::RefundExceedsReceipt);
    }

    #[test]
    fn test_counter_sign() {
        let dispute = make_dispute();
        let signer = [0xAAu8; 32];
        let capsule = counter_sign(&dispute, Resolution::RefundApproved, signer);
        assert_eq!(capsule.dispute_id, dispute.dispute_id);
        assert_eq!(capsule.resolution, Resolution::RefundApproved);
        assert_eq!(capsule.counter_signer, signer);
    }

    #[test]
    fn test_dispute_commitment_deterministic() {
        let d = make_dispute();
        assert_eq!(dispute_commitment(&d), dispute_commitment(&d));
        // Changing any field changes the commitment
        let mut d2 = d.clone();
        d2.requested_refund_lamports = 1;
        assert_ne!(dispute_commitment(&d), dispute_commitment(&d2));
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_dispute_at_exact_deadline_ok() {
        // current_slot == deadline_slot: condition is >, so this must pass
        let d = file_dispute(
            [0x02u8; 32],
            [0x01u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
            [0x05u8; 32],
            5000,
            500_000,
            1_000_000,
            [0x02u8; 32],
            5000,
        )
        .unwrap();
        assert_eq!(d.deadline_slot, 5000);
    }

    #[test]
    fn test_refund_at_exact_max_ok() {
        // requested == max: condition is >, so this must pass
        let d = file_dispute(
            [0x02u8; 32],
            [0x01u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
            [0x05u8; 32],
            5000,
            1_000_000,
            1_000_000,
            [0x02u8; 32],
            4000,
        )
        .unwrap();
        assert_eq!(d.requested_refund_lamports, 1_000_000);
    }

    #[test]
    fn test_dispute_commitment_nonzero() {
        let d = make_dispute();
        assert_ne!(dispute_commitment(&d), [0u8; 32]);
    }

    #[test]
    fn test_commitment_receipt_hash_sensitive() {
        let d = make_dispute();
        let mut d2 = d.clone();
        d2.receipt_hash = [0xFFu8; 32];
        assert_ne!(dispute_commitment(&d), dispute_commitment(&d2));
    }

    #[test]
    fn test_commitment_refund_amount_sensitive() {
        let d = make_dispute();
        let mut d2 = d.clone();
        d2.requested_refund_lamports = 999_999;
        assert_ne!(dispute_commitment(&d), dispute_commitment(&d2));
    }

    #[test]
    fn test_counter_sign_partial_refund() {
        let dispute = make_dispute();
        let capsule = counter_sign(&dispute, Resolution::PartialRefund(100_000), [0xBBu8; 32]);
        assert_eq!(capsule.resolution, Resolution::PartialRefund(100_000));
        assert_eq!(capsule.dispute_id, dispute.dispute_id);
    }

    #[test]
    fn test_counter_sign_refund_denied() {
        let dispute = make_dispute();
        let capsule = counter_sign(&dispute, Resolution::RefundDenied, [0xCCu8; 32]);
        assert_eq!(capsule.resolution, Resolution::RefundDenied);
    }

    #[test]
    fn test_dispute_fields_preserved() {
        let d = file_dispute(
            [0x02u8; 32],
            [0x01u8; 32],
            [0x03u8; 32],
            [0x04u8; 32],
            [0x05u8; 32],
            5000,
            500_000,
            1_000_000,
            [0x02u8; 32],
            4000,
        )
        .unwrap();
        assert_eq!(d.dispute_id, [0x01u8; 32]);
        assert_eq!(d.service_hash, [0x03u8; 32]);
        assert_eq!(d.evidence_hash, [0x05u8; 32]);
    }

    #[test]
    fn test_commitment_dispute_id_sensitive() {
        let d = make_dispute();
        let mut d2 = d.clone();
        d2.dispute_id = [0xFFu8; 32];
        assert_ne!(dispute_commitment(&d), dispute_commitment(&d2));
    }

    #[test]
    fn test_commitment_evidence_hash_sensitive() {
        let d = make_dispute();
        let mut d2 = d.clone();
        d2.evidence_hash = [0xEEu8; 32];
        assert_ne!(dispute_commitment(&d), dispute_commitment(&d2));
    }
}
