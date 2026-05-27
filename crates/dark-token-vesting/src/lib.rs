use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VestingSchedule {
    pub schedule_id: [u8; 32],
    pub beneficiary_hash: [u8; 32],
    pub total_amount: u64,
    pub cliff_unix: i64,
    pub end_unix: i64,
    pub released: u64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VestingClaim {
    pub claim_id: [u8; 32],
    pub schedule_id: [u8; 32],
    pub amount: u64,
    pub claimed_at_unix: i64,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum VestingError {
    ZeroBeneficiarySecret,
    ZeroAmount,
    CliffAfterEnd,
    BeforeCliff { cliff: i64, current: i64 },
    ExceedsVested,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

fn sha256_2(a: &[u8], b: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(a);
    h.update(b);
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

/// beneficiary_hash = SHA256("vest-beneficiary-v1" || beneficiary_secret)
fn compute_beneficiary_hash(beneficiary_secret: &[u8; 32]) -> [u8; 32] {
    sha256_2(b"vest-beneficiary-v1", beneficiary_secret)
}

/// schedule_id = SHA256("vest-schedule-v1" || beneficiary_hash || total_amount_le || cliff_le || end_le || nonce)
fn compute_schedule_id(
    beneficiary_hash: &[u8; 32],
    total_amount: u64,
    cliff_unix: i64,
    end_unix: i64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"vest-schedule-v1");
    hasher.update(beneficiary_hash);
    hasher.update(&total_amount.to_le_bytes());
    hasher.update(&cliff_unix.to_le_bytes());
    hasher.update(&end_unix.to_le_bytes());
    hasher.update(nonce);
    hasher.finalize().into()
}

/// Vested amount at time t:
/// - t < cliff  → 0
/// - t >= end   → total_amount
/// - else       → floor(total_amount * (t - cliff) / (end - cliff))
fn vested_at(schedule: &VestingSchedule, t: i64) -> u64 {
    if t < schedule.cliff_unix {
        return 0;
    }
    if t >= schedule.end_unix {
        return schedule.total_amount;
    }
    let elapsed = (t - schedule.cliff_unix) as u128;
    let duration = (schedule.end_unix - schedule.cliff_unix) as u128;
    ((schedule.total_amount as u128 * elapsed) / duration) as u64
}

/// claim_id = SHA256("vest-claim-v1" || schedule_id || amount_le || claimed_at_le)
fn compute_claim_id(schedule_id: &[u8; 32], amount: u64, claimed_at_unix: i64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"vest-claim-v1");
    hasher.update(schedule_id);
    hasher.update(&amount.to_le_bytes());
    hasher.update(&claimed_at_unix.to_le_bytes());
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a token vesting schedule.
///
/// Errors: ZeroBeneficiarySecret, ZeroAmount, CliffAfterEnd
pub fn create_schedule(
    beneficiary_secret: &[u8; 32],
    total_amount: u64,
    cliff_unix: i64,
    end_unix: i64,
    nonce: &[u8; 32],
) -> Result<VestingSchedule, VestingError> {
    if *beneficiary_secret == [0u8; 32] {
        return Err(VestingError::ZeroBeneficiarySecret);
    }
    if total_amount == 0 {
        return Err(VestingError::ZeroAmount);
    }
    if cliff_unix >= end_unix {
        return Err(VestingError::CliffAfterEnd);
    }

    let beneficiary_hash = compute_beneficiary_hash(beneficiary_secret);
    let schedule_id =
        compute_schedule_id(&beneficiary_hash, total_amount, cliff_unix, end_unix, nonce);

    Ok(VestingSchedule {
        schedule_id,
        beneficiary_hash,
        total_amount,
        cliff_unix,
        end_unix,
        released: 0,
        mainnet_ready: false,
    })
}

/// Claim vested tokens.
///
/// Errors: BeforeCliff, ExceedsVested
pub fn claim_vested(
    schedule: &mut VestingSchedule,
    _beneficiary_secret: &[u8; 32],
    amount: u64,
    current_unix: i64,
) -> Result<VestingClaim, VestingError> {
    if current_unix < schedule.cliff_unix {
        return Err(VestingError::BeforeCliff {
            cliff: schedule.cliff_unix,
            current: current_unix,
        });
    }

    let vested = vested_at(schedule, current_unix);
    let available = vested.saturating_sub(schedule.released);
    if amount > available {
        return Err(VestingError::ExceedsVested);
    }

    schedule.released = schedule.released.saturating_add(amount);

    let claim_id = compute_claim_id(&schedule.schedule_id, amount, current_unix);

    Ok(VestingClaim {
        claim_id,
        schedule_id: schedule.schedule_id,
        amount,
        claimed_at_unix: current_unix,
        mainnet_ready: false,
    })
}

/// Public JSON record: exposes schedule_id, total_amount, cliff_unix, end_unix, released, mainnet_ready.
/// Does NOT expose beneficiary_hash.
pub fn schedule_public_record(s: &VestingSchedule) -> String {
    let sid_hex: String = s.schedule_id.iter().map(|b| format!("{:02x}", b)).collect();
    serde_json::json!({
        "schedule_id": sid_hex,
        "total_amount": s.total_amount,
        "cliff_unix": s.cliff_unix,
        "end_unix": s.end_unix,
        "released": s.released,
        "mainnet_ready": s.mainnet_ready,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn bsecret() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xBE;
        s
    }

    fn nonce() -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = 0x1A;
        n
    }

    // Timestamps: cliff=1000, end=2000, fully vested at 2000
    const CLIFF: i64 = 1_000;
    const END: i64 = 2_000;
    const TOTAL: u64 = 10_000;

    fn make_schedule() -> VestingSchedule {
        create_schedule(&bsecret(), TOTAL, CLIFF, END, &nonce()).unwrap()
    }

    #[test]
    fn test_create_and_claim_at_end_fully_vested() {
        let mut schedule = make_schedule();
        assert!(!schedule.mainnet_ready);

        // At t=END, fully vested
        let claim = claim_vested(&mut schedule, &bsecret(), TOTAL, END).unwrap();
        assert_eq!(claim.amount, TOTAL);
        assert!(!claim.mainnet_ready);
        assert_eq!(schedule.released, TOTAL);
    }

    #[test]
    fn test_before_cliff_rejected() {
        let mut schedule = make_schedule();
        let err = claim_vested(&mut schedule, &bsecret(), 1, CLIFF - 1).unwrap_err();
        assert_eq!(
            err,
            VestingError::BeforeCliff {
                cliff: CLIFF,
                current: CLIFF - 1
            }
        );
    }

    #[test]
    fn test_exceeds_vested_rejected() {
        let mut schedule = make_schedule();
        // At midpoint, only half is vested
        let mid = (CLIFF + END) / 2; // 1500
        let vested = TOTAL / 2; // 5000

        // Trying to claim more than vested should fail
        let err = claim_vested(&mut schedule, &bsecret(), vested + 1, mid).unwrap_err();
        assert_eq!(err, VestingError::ExceedsVested);
    }

    #[test]
    fn test_cliff_after_end_rejected() {
        let err = create_schedule(&bsecret(), TOTAL, END, CLIFF, &nonce()).unwrap_err();
        assert_eq!(err, VestingError::CliffAfterEnd);

        // equal cliff==end also rejected
        let err2 = create_schedule(&bsecret(), TOTAL, CLIFF, CLIFF, &nonce()).unwrap_err();
        assert_eq!(err2, VestingError::CliffAfterEnd);
    }

    #[test]
    fn test_claim_id_deterministic() {
        let mut s1 = make_schedule();
        let mut s2 = make_schedule();

        let c1 = claim_vested(&mut s1, &bsecret(), 1000, END).unwrap();
        let c2 = claim_vested(&mut s2, &bsecret(), 1000, END).unwrap();
        assert_eq!(c1.claim_id, c2.claim_id);
    }

    #[test]
    fn test_public_record_hides_beneficiary() {
        let schedule = make_schedule();
        let record = schedule_public_record(&schedule);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();

        let bh_hex: String = schedule
            .beneficiary_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(!record.contains(&bh_hex));
        assert!(v.get("beneficiary_hash").is_none());
        assert_eq!(v["mainnet_ready"], false);
        assert!(v["schedule_id"].is_string());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let s = make_schedule();
        assert!(!s.mainnet_ready);
        let mut s2 = make_schedule();
        let c = claim_vested(&mut s2, &bsecret(), 100, END).unwrap();
        assert!(!c.mainnet_ready);
    }

    #[test]
    fn test_zero_beneficiary_secret_rejected() {
        let err = create_schedule(&[0u8; 32], TOTAL, CLIFF, END, &nonce()).unwrap_err();
        assert_eq!(err, VestingError::ZeroBeneficiarySecret);
    }

    #[test]
    fn test_zero_amount_rejected() {
        let err = create_schedule(&bsecret(), 0, CLIFF, END, &nonce()).unwrap_err();
        assert_eq!(err, VestingError::ZeroAmount);
    }

    #[test]
    fn test_partial_claim_then_remaining() {
        let mut s = make_schedule();
        // claim half at midpoint
        let mid = (CLIFF + END) / 2;
        let half = TOTAL / 2;
        claim_vested(&mut s, &bsecret(), half, mid).unwrap();
        assert_eq!(s.released, half);
        // claim remaining at end
        claim_vested(&mut s, &bsecret(), half, END).unwrap();
        assert_eq!(s.released, TOTAL);
    }

    #[test]
    fn test_schedule_id_deterministic() {
        let s1 = make_schedule();
        let s2 = make_schedule();
        assert_eq!(s1.schedule_id, s2.schedule_id);
    }

    #[test]
    fn test_schedule_id_sensitive_to_nonce() {
        let s1 = make_schedule();
        let mut n2 = nonce();
        n2[0] ^= 0xFF;
        let s2 = create_schedule(&bsecret(), TOTAL, CLIFF, END, &n2).unwrap();
        assert_ne!(s1.schedule_id, s2.schedule_id);
    }

    #[test]
    fn test_vested_at_exact_cliff_is_zero() {
        let mut s = make_schedule();
        // at cliff, 0 is vested (t == cliff → start of vesting, 0 elapsed)
        let err = claim_vested(&mut s, &bsecret(), 1, CLIFF - 1).unwrap_err();
        assert_eq!(
            err,
            VestingError::BeforeCliff {
                cliff: CLIFF,
                current: CLIFF - 1
            }
        );
    }

    #[test]
    fn test_released_tracked_correctly() {
        let mut s = make_schedule();
        assert_eq!(s.released, 0);
        claim_vested(&mut s, &bsecret(), 500, END).unwrap();
        assert_eq!(s.released, 500);
    }

    #[test]
    fn test_public_record_has_expected_fields() {
        let s = make_schedule();
        let record = schedule_public_record(&s);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["schedule_id"].is_string());
        assert_eq!(v["total_amount"], TOTAL);
        assert_eq!(v["cliff_unix"], CLIFF);
        assert_eq!(v["end_unix"], END);
        assert_eq!(v["released"], 0u64);
    }

    #[test]
    fn test_claim_id_sensitive_to_amount() {
        let mut s1 = make_schedule();
        let mut s2 = make_schedule();
        let c1 = claim_vested(&mut s1, &bsecret(), 100, END).unwrap();
        let c2 = claim_vested(&mut s2, &bsecret(), 200, END).unwrap();
        assert_ne!(c1.claim_id, c2.claim_id);
    }
}
