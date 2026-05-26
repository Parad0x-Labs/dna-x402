use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub sub_id: [u8; 32],
    pub subscriber_hash: [u8; 32],
    pub plan_hash: [u8; 32],
    pub payment_commitment: [u8; 32],
    pub start_epoch: u64,
    pub end_epoch: u64,
    pub active: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum SubError {
    ZeroSubscriberSecret,
    EmptyPlan,
    EndBeforeStart,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn compute_subscriber_hash(secret: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"sub-subscriber-v1", secret])
}

fn compute_plan_hash(plan_bytes: &[u8]) -> [u8; 32] {
    sha256_multi(&[b"sub-plan-v1", plan_bytes])
}

fn compute_payment_commitment(amount: u64, blinding: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"sub-payment-v1", &amount.to_le_bytes(), blinding])
}

fn compute_sub_id(
    subscriber_hash: &[u8; 32],
    plan_hash: &[u8; 32],
    start_epoch: u64,
    end_epoch: u64,
) -> [u8; 32] {
    sha256_multi(&[
        b"sub-id-v1",
        subscriber_hash,
        plan_hash,
        &start_epoch.to_le_bytes(),
        &end_epoch.to_le_bytes(),
    ])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn new_subscription(
    subscriber_secret: &[u8; 32],
    plan_bytes: &[u8],
    amount: u64,
    blinding: &[u8; 32],
    start_epoch: u64,
    end_epoch: u64,
) -> Result<Subscription, SubError> {
    if subscriber_secret == &[0u8; 32] {
        return Err(SubError::ZeroSubscriberSecret);
    }
    if plan_bytes.is_empty() {
        return Err(SubError::EmptyPlan);
    }
    if end_epoch <= start_epoch {
        return Err(SubError::EndBeforeStart);
    }
    let subscriber_hash = compute_subscriber_hash(subscriber_secret);
    let plan_hash = compute_plan_hash(plan_bytes);
    let payment_commitment = compute_payment_commitment(amount, blinding);
    let sub_id = compute_sub_id(&subscriber_hash, &plan_hash, start_epoch, end_epoch);
    Ok(Subscription {
        sub_id,
        subscriber_hash,
        plan_hash,
        payment_commitment,
        start_epoch,
        end_epoch,
        active: true,
        mainnet_ready: false,
    })
}

pub fn cancel_subscription(sub: &mut Subscription) {
    sub.active = false;
}

pub fn is_active_at(sub: &Subscription, epoch: u64) -> bool {
    sub.active && epoch >= sub.start_epoch && epoch <= sub.end_epoch
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sub() -> Subscription {
        new_subscription(
            &[0xabu8; 32],
            b"premium-plan-v1",
            1_000_000,
            &[0x01u8; 32],
            1_000,
            2_000,
        )
        .unwrap()
    }

    #[test]
    fn new_subscription_correct_and_mainnet_ready_false() {
        let sub = make_sub();
        // Verify sub_id formula
        let sub_hash = sha256_multi(&[b"sub-subscriber-v1", &[0xabu8; 32]]);
        let plan_hash = sha256_multi(&[b"sub-plan-v1", b"premium-plan-v1"]);
        let expected_sub_id = sha256_multi(&[
            b"sub-id-v1",
            &sub_hash,
            &plan_hash,
            &1_000u64.to_le_bytes(),
            &2_000u64.to_le_bytes(),
        ]);
        assert_eq!(sub.sub_id, expected_sub_id);
        assert!(!sub.mainnet_ready);
        assert!(sub.active);
    }

    fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }

    #[test]
    fn is_active_at_within_range() {
        let sub = make_sub();
        assert!(is_active_at(&sub, 1_000));
        assert!(is_active_at(&sub, 1_500));
        assert!(is_active_at(&sub, 2_000));
    }

    #[test]
    fn is_active_at_outside_range() {
        let sub = make_sub();
        assert!(!is_active_at(&sub, 999));
        assert!(!is_active_at(&sub, 2_001));
    }

    #[test]
    fn cancel_sets_active_false() {
        let mut sub = make_sub();
        assert!(sub.active);
        cancel_subscription(&mut sub);
        assert!(!sub.active);
        assert!(!is_active_at(&sub, 1_500));
    }

    #[test]
    fn end_before_start_rejected() {
        let err =
            new_subscription(&[0xbbu8; 32], b"plan", 100, &[0x01u8; 32], 2_000, 1_000).unwrap_err();
        assert_eq!(err, SubError::EndBeforeStart);
        // Equal start/end also rejected
        let err2 =
            new_subscription(&[0xbbu8; 32], b"plan", 100, &[0x01u8; 32], 1_000, 1_000).unwrap_err();
        assert_eq!(err2, SubError::EndBeforeStart);
    }

    #[test]
    fn sub_id_is_deterministic() {
        let sub1 = make_sub();
        let sub2 = make_sub();
        assert_eq!(sub1.sub_id, sub2.sub_id);
        assert_ne!(sub1.sub_id, [0u8; 32]);
    }
}
