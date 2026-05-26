use sha2::{Sha256, Digest};

#[derive(Debug, Clone, PartialEq)]
pub enum RouteClass {
    Standard,
    Priority,
    Jito,
    SwQoS,
}

#[derive(Debug, Clone)]
pub struct InsuranceTicket {
    pub ticket_hash: [u8; 32],
    pub expected_slot_min: u64,
    pub expected_slot_max: u64,
    pub max_slippage_bps: u16,
    pub route_class: RouteClass,
    pub premium_lamports: u64,
    pub buyer_hash: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct LandingReport {
    pub ticket_hash: [u8; 32],
    pub landed_slot: u64,
    pub actual_slippage_bps: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClaimReason {
    SlotMiss,
    SlippageExceeded,
    Both,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaimCoupon {
    pub ticket_hash: [u8; 32],
    pub refund_lamports: u64,
    pub reason: ClaimReason,
    pub coupon_hash: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub enum InsuranceError {
    AlreadyClaimed,
    NoClaim,
}

pub fn create_ticket(
    buyer_hash: &[u8; 32],
    slot_min: u64,
    slot_max: u64,
    max_slippage_bps: u16,
    route_class: RouteClass,
    premium_lamports: u64,
) -> InsuranceTicket {
    let mut hasher = Sha256::new();
    hasher.update(b"insurance-ticket-v1");
    hasher.update(buyer_hash);
    hasher.update(slot_min.to_le_bytes());
    hasher.update(slot_max.to_le_bytes());
    hasher.update(max_slippage_bps.to_le_bytes());
    hasher.update(premium_lamports.to_le_bytes());
    let ticket_hash: [u8; 32] = hasher.finalize().into();

    InsuranceTicket {
        ticket_hash,
        expected_slot_min: slot_min,
        expected_slot_max: slot_max,
        max_slippage_bps,
        route_class,
        premium_lamports,
        buyer_hash: *buyer_hash,
    }
}

pub fn evaluate_claim(
    ticket: &InsuranceTicket,
    report: &LandingReport,
) -> Result<ClaimCoupon, InsuranceError> {
    let slot_ok = report.landed_slot >= ticket.expected_slot_min
        && report.landed_slot <= ticket.expected_slot_max;
    let slip_ok = report.actual_slippage_bps <= ticket.max_slippage_bps;

    if slot_ok && slip_ok {
        return Err(InsuranceError::NoClaim);
    }

    let reason = match (!slot_ok, !slip_ok) {
        (true, true) => ClaimReason::Both,
        (true, false) => ClaimReason::SlotMiss,
        (false, true) => ClaimReason::SlippageExceeded,
        (false, false) => unreachable!(),
    };

    let mut hasher = Sha256::new();
    hasher.update(b"claim-coupon-v1");
    hasher.update(ticket.ticket_hash);
    hasher.update(report.landed_slot.to_le_bytes());
    hasher.update(report.actual_slippage_bps.to_le_bytes());
    let coupon_hash: [u8; 32] = hasher.finalize().into();

    Ok(ClaimCoupon {
        ticket_hash: ticket.ticket_hash,
        refund_lamports: ticket.premium_lamports,
        reason,
        coupon_hash,
    })
}

pub fn claim_coupon(coupon: &ClaimCoupon, already_claimed: bool) -> Result<u64, InsuranceError> {
    if already_claimed {
        return Err(InsuranceError::AlreadyClaimed);
    }
    Ok(coupon.refund_lamports)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buyer() -> [u8; 32] {
        let mut h = [0u8; 32];
        h[0] = 42;
        h
    }

    fn make_ticket() -> InsuranceTicket {
        create_ticket(&buyer(), 100, 200, 50, RouteClass::Priority, 5_000)
    }

    #[test]
    fn test_ticket_created_correctly() {
        let t = make_ticket();
        assert_eq!(t.expected_slot_min, 100);
        assert_eq!(t.expected_slot_max, 200);
        assert_eq!(t.max_slippage_bps, 50);
        assert_eq!(t.premium_lamports, 5_000);
        assert_eq!(t.route_class, RouteClass::Priority);
    }

    #[test]
    fn test_slot_miss_triggers_claim() {
        let t = make_ticket();
        let report = LandingReport {
            ticket_hash: t.ticket_hash,
            landed_slot: 300, // outside [100, 200]
            actual_slippage_bps: 10,
        };
        let result = evaluate_claim(&t, &report);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().reason, ClaimReason::SlotMiss);
    }

    #[test]
    fn test_slippage_exceeded_triggers_claim() {
        let t = make_ticket();
        let report = LandingReport {
            ticket_hash: t.ticket_hash,
            landed_slot: 150, // within range
            actual_slippage_bps: 100, // exceeds 50
        };
        let result = evaluate_claim(&t, &report);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().reason, ClaimReason::SlippageExceeded);
    }

    #[test]
    fn test_within_bounds_no_claim() {
        let t = make_ticket();
        let report = LandingReport {
            ticket_hash: t.ticket_hash,
            landed_slot: 150,
            actual_slippage_bps: 30,
        };
        let result = evaluate_claim(&t, &report);
        assert_eq!(result, Err(InsuranceError::NoClaim));
    }

    #[test]
    fn test_both_miss_returns_both_reason() {
        let t = make_ticket();
        let report = LandingReport {
            ticket_hash: t.ticket_hash,
            landed_slot: 999,
            actual_slippage_bps: 200,
        };
        let result = evaluate_claim(&t, &report);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().reason, ClaimReason::Both);
    }

    #[test]
    fn test_already_claimed_rejected() {
        let t = make_ticket();
        let report = LandingReport {
            ticket_hash: t.ticket_hash,
            landed_slot: 999,
            actual_slippage_bps: 200,
        };
        let coupon = evaluate_claim(&t, &report).unwrap();
        let result = claim_coupon(&coupon, true);
        assert_eq!(result, Err(InsuranceError::AlreadyClaimed));
    }

    #[test]
    fn test_coupon_hash_deterministic() {
        let t = make_ticket();
        let report = LandingReport {
            ticket_hash: t.ticket_hash,
            landed_slot: 999,
            actual_slippage_bps: 200,
        };
        let c1 = evaluate_claim(&t, &report).unwrap();
        let c2 = evaluate_claim(&t, &report).unwrap();
        assert_eq!(c1.coupon_hash, c2.coupon_hash);
    }
}
