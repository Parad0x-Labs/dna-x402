// dark-sliding-window-budget — sliding window spending budget with committed amounts
// Prove compliance without revealing individual spend amounts.
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Configuration for a sliding-window spending budget.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetConfig {
    /// Maximum lamports spendable in any `window_slots` period.
    pub budget_cap: u64,
    /// Window size in slots (e.g., 216_000 ≈ 24 hours at 400 ms/slot).
    pub window_slots: u64,
    /// Domain binding (e.g., SHA256("dark_null_agent_budget_v1")).
    pub domain_hash: [u8; 32],
    /// Always false — this code is NOT production-ready.
    pub mainnet_ready: bool,
}

/// A single spend committed via SHA-256; the raw amount is never stored.
#[derive(Debug, Clone, PartialEq)]
pub struct SpendRecord {
    /// SHA256("spend-record-v1" || amount_le8 || slot_le8 || nonce)
    pub spend_commit: [u8; 32],
    /// Slot when the spend occurred.
    pub slot: u64,
    /// Monotonic nonce for replay protection.
    pub nonce: [u8; 32],
    /// Always false — this code is NOT production-ready.
    pub mainnet_ready: bool,
}

/// A view over the currently active records inside the sliding window.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetWindow {
    /// Records with `slot > current_slot.saturating_sub(window_slots)`.
    pub active_records: Vec<SpendRecord>,
    /// SHA256("window-root-v1" || len_le4 || sorted(spend_commits_in_window))
    pub window_root: [u8; 32],
    /// SHA256("total-commit-v1" || total_le8 || window_root)
    pub total_commit: [u8; 32],
    pub current_slot: u64,
    /// Always false — this code is NOT production-ready.
    pub mainnet_ready: bool,
}

/// A compact, publicly verifiable proof of budget compliance.
#[derive(Debug, Clone, PartialEq)]
pub struct BudgetProof {
    pub window_root: [u8; 32],
    pub total_commit: [u8; 32],
    /// True iff total spend in window <= `budget_cap`.
    pub within_budget: bool,
    pub record_count: u32,
    /// Always false — this code is NOT production-ready.
    pub mainnet_ready: bool,
}

/// Errors that can arise during budget operations.
#[derive(Debug, PartialEq)]
pub enum BudgetError {
    BudgetCapExceeded {
        total: u64,
        cap: u64,
    },
    /// `window_slots` was zero.
    InvalidWindowConfig,
    DuplicateNonce,
    SlotBeforeWindow,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute the spend commitment: SHA256("spend-record-v1" || amount_le8 || slot_le8 || nonce).
fn spend_commit_hash(amount: u64, slot: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"spend-record-v1");
    h.update(amount.to_le_bytes());
    h.update(slot.to_le_bytes());
    h.update(nonce);
    h.finalize().into()
}

/// Compute the window root from a slice of spend commitments (pre-sorted).
/// Layout: SHA256("window-root-v1" || len_le4 || commit0 || commit1 || ...)
fn compute_window_root(sorted_commits: &[[u8; 32]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"window-root-v1");
    h.update((sorted_commits.len() as u32).to_le_bytes());
    for c in sorted_commits {
        h.update(c);
    }
    h.finalize().into()
}

/// Compute the total commitment: SHA256("total-commit-v1" || total_le8 || window_root).
fn compute_total_commit(total: u64, window_root: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"total-commit-v1");
    h.update(total.to_le_bytes());
    h.update(window_root);
    h.finalize().into()
}

/// Return `true` if `slot` falls inside the window ending at `current_slot`.
/// Active slots satisfy: slot > current_slot.saturating_sub(window_slots)
fn is_active(slot: u64, current_slot: u64, window_slots: u64) -> bool {
    slot > current_slot.saturating_sub(window_slots)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Create a spend record; the `amount` is committed but not stored in plain.
pub fn record_spend(amount: u64, slot: u64, nonce: &[u8; 32]) -> SpendRecord {
    SpendRecord {
        spend_commit: spend_commit_hash(amount, slot, nonce),
        slot,
        nonce: *nonce,
        mainnet_ready: false,
    }
}

/// Verify that a record's commitment matches the supplied `(amount, slot, nonce)`.
pub fn verify_record(record: &SpendRecord, amount: u64, slot: u64, nonce: &[u8; 32]) -> bool {
    let expected = spend_commit_hash(amount, slot, nonce);
    record.spend_commit == expected && record.slot == slot && &record.nonce == nonce
}

/// Build a `BudgetWindow` from a set of records and the current slot.
///
/// Records outside the window (`slot <= current_slot - window_slots`) are
/// excluded. Active records are sorted by `spend_commit` for determinism.
///
/// Note: this function does NOT know the raw amounts — `total_commit` is
/// computed with `total = 0` as a structural placeholder. Use `check_budget`
/// when you need the real total commitment.
pub fn build_window(
    records: &[SpendRecord],
    current_slot: u64,
    config: &BudgetConfig,
) -> BudgetWindow {
    let mut active: Vec<SpendRecord> = records
        .iter()
        .filter(|r| is_active(r.slot, current_slot, config.window_slots))
        .cloned()
        .collect();

    // Sort by commit for a deterministic root.
    active.sort_by_key(|r| r.spend_commit);

    let sorted_commits: Vec<[u8; 32]> = active.iter().map(|r| r.spend_commit).collect();
    let window_root = compute_window_root(&sorted_commits);

    // Without amounts we commit to total=0 as a structural placeholder.
    let total_commit = compute_total_commit(0, &window_root);

    BudgetWindow {
        active_records: active,
        window_root,
        total_commit,
        current_slot,
        mainnet_ready: false,
    }
}

/// Check compliance: compute the real total of active spends and confirm it
/// does not exceed `budget_cap`.
///
/// `amounts[i]` corresponds to `records[i]` (same ordering as the input
/// slice). Records outside the current window are silently excluded from the
/// total.
///
/// Returns `BudgetProof` on success, or `BudgetError` when:
/// - `window_slots == 0`
/// - a duplicate nonce is detected among *active* records
/// - total spend exceeds `budget_cap`
pub fn check_budget(
    config: &BudgetConfig,
    records: &[SpendRecord],
    amounts: &[u64],
    current_slot: u64,
) -> Result<BudgetProof, BudgetError> {
    if config.window_slots == 0 {
        return Err(BudgetError::InvalidWindowConfig);
    }

    // Collect active (record, amount) pairs.
    let mut active: Vec<(&SpendRecord, u64)> = records
        .iter()
        .zip(amounts.iter().copied())
        .filter(|(r, _)| is_active(r.slot, current_slot, config.window_slots))
        .collect();

    // Duplicate-nonce check among active records.
    let mut seen_nonces: Vec<[u8; 32]> = Vec::with_capacity(active.len());
    for (r, _) in &active {
        if seen_nonces.contains(&r.nonce) {
            return Err(BudgetError::DuplicateNonce);
        }
        seen_nonces.push(r.nonce);
    }

    // Sort by commit for a deterministic root.
    active.sort_by_key(|(r, _)| r.spend_commit);

    let total: u64 = active.iter().map(|(_, a)| a).sum();

    let sorted_commits: Vec<[u8; 32]> = active.iter().map(|(r, _)| r.spend_commit).collect();
    let window_root = compute_window_root(&sorted_commits);
    let total_commit = compute_total_commit(total, &window_root);

    let within_budget = total <= config.budget_cap;

    if !within_budget {
        return Err(BudgetError::BudgetCapExceeded {
            total,
            cap: config.budget_cap,
        });
    }

    Ok(BudgetProof {
        window_root,
        total_commit,
        within_budget: true,
        record_count: active.len() as u32,
        mainnet_ready: false,
    })
}

/// Public verification of a `BudgetProof` against the expected window root.
///
/// A verifier who holds `expected_window_root` (e.g., from a chain state
/// anchor) can confirm the proof is internally consistent and reports
/// compliance, without learning any individual spend amount.
pub fn verify_budget_proof(proof: &BudgetProof, expected_window_root: &[u8; 32]) -> bool {
    proof.window_root == *expected_window_root && proof.within_budget
}

/// Slide the window forward to `new_slot`, dropping records that have expired.
pub fn advance_window(window: &BudgetWindow, new_slot: u64, config: &BudgetConfig) -> BudgetWindow {
    build_window(&window.active_records, new_slot, config)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce(seed: u8) -> [u8; 32] {
        [seed; 32]
    }

    fn domain() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"dark_null_agent_budget_v1");
        h.finalize().into()
    }

    fn cfg(cap: u64, window: u64) -> BudgetConfig {
        BudgetConfig {
            budget_cap: cap,
            window_slots: window,
            domain_hash: domain(),
            mainnet_ready: false,
        }
    }

    // -----------------------------------------------------------------------
    // 1. mainnet_ready is always false
    // -----------------------------------------------------------------------
    #[test]
    fn test_record_spend_mainnet_ready_false() {
        let r = record_spend(500, 100, &nonce(1));
        assert!(!r.mainnet_ready);
    }

    // -----------------------------------------------------------------------
    // 2. Spend commitment is deterministic
    // -----------------------------------------------------------------------
    #[test]
    fn test_spend_commit_deterministic() {
        let a = record_spend(1_000, 42, &nonce(7));
        let b = record_spend(1_000, 42, &nonce(7));
        assert_eq!(a.spend_commit, b.spend_commit);
    }

    // -----------------------------------------------------------------------
    // 3. verify_record passes for correct inputs
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_record_passes() {
        let n = nonce(3);
        let r = record_spend(250, 200, &n);
        assert!(verify_record(&r, 250, 200, &n));
    }

    // -----------------------------------------------------------------------
    // 4. verify_record fails for wrong amount
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_record_fails_wrong_amount() {
        let n = nonce(4);
        let r = record_spend(250, 200, &n);
        assert!(!verify_record(&r, 999, 200, &n));
    }

    // -----------------------------------------------------------------------
    // 5. Old records are excluded from the window
    // -----------------------------------------------------------------------
    #[test]
    fn test_build_window_excludes_old_records() {
        let config = cfg(10_000, 500);
        // slot 0 is NOT inside (current=1000, window=500):
        // active = slot > 1000 - 500 = 500, so slot 0 fails.
        let old = record_spend(100, 0, &nonce(5));
        let window = build_window(&[old], 1000, &config);
        assert!(window.active_records.is_empty());
    }

    // -----------------------------------------------------------------------
    // 6. Recent records are included
    // -----------------------------------------------------------------------
    #[test]
    fn test_build_window_includes_recent_records() {
        let config = cfg(10_000, 500);
        // slot 600 > 1000 - 500 = 500 -> active
        let recent = record_spend(100, 600, &nonce(6));
        let window = build_window(&[recent.clone()], 1000, &config);
        assert_eq!(window.active_records.len(), 1);
        assert_eq!(window.active_records[0].spend_commit, recent.spend_commit);
    }

    // -----------------------------------------------------------------------
    // 7. check_budget returns Ok when within cap
    // -----------------------------------------------------------------------
    #[test]
    fn test_check_budget_within_cap_ok() {
        let config = cfg(1_000, 500);
        let r = record_spend(400, 600, &nonce(7));
        let result = check_budget(&config, &[r], &[400], 1000);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // 8. check_budget returns Err when over cap
    // -----------------------------------------------------------------------
    #[test]
    fn test_check_budget_over_cap_err() {
        let config = cfg(500, 500);
        let r = record_spend(600, 600, &nonce(8));
        let result = check_budget(&config, &[r], &[600], 1000);
        assert_eq!(
            result,
            Err(BudgetError::BudgetCapExceeded {
                total: 600,
                cap: 500
            })
        );
    }

    // -----------------------------------------------------------------------
    // 9. Proof reports within_budget = true when compliant
    // -----------------------------------------------------------------------
    #[test]
    fn test_budget_proof_within_budget_true() {
        let config = cfg(1_000, 500);
        let r = record_spend(300, 600, &nonce(9));
        let proof = check_budget(&config, &[r], &[300], 1000).unwrap();
        assert!(proof.within_budget);
        assert!(!proof.mainnet_ready);
    }

    // -----------------------------------------------------------------------
    // 10. Over-budget returns BudgetCapExceeded (within_budget = false path)
    // -----------------------------------------------------------------------
    #[test]
    fn test_budget_proof_over_budget_false() {
        let config = cfg(100, 500);
        let r1 = record_spend(60, 600, &nonce(10));
        let r2 = record_spend(60, 700, &nonce(11));
        let result = check_budget(&config, &[r1, r2], &[60, 60], 1000);
        assert!(matches!(
            result,
            Err(BudgetError::BudgetCapExceeded {
                total: 120,
                cap: 100
            })
        ));
    }

    // -----------------------------------------------------------------------
    // 11. verify_budget_proof passes when root matches
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_budget_proof_passes() {
        let config = cfg(1_000, 500);
        let r = record_spend(200, 600, &nonce(11));
        let proof = check_budget(&config, &[r], &[200], 1000).unwrap();
        let expected_root = proof.window_root;
        assert!(verify_budget_proof(&proof, &expected_root));
    }

    // -----------------------------------------------------------------------
    // 12. advance_window drops expired records
    // -----------------------------------------------------------------------
    #[test]
    fn test_advance_window_drops_expired_records() {
        let config = cfg(10_000, 500);
        // At slot 1000, record at slot 600 is active (600 > 500).
        let r_active = record_spend(100, 600, &nonce(12));
        // At slot 1000, record at slot 400 is already expired.
        let r_expired = record_spend(50, 400, &nonce(13));
        let window = build_window(&[r_active.clone(), r_expired], 1000, &config);
        assert_eq!(window.active_records.len(), 1);

        // Advance to slot 1200: window now (1200-500, 1200] = (700, 1200].
        // Record at slot 600 is 600 <= 700, so it expires.
        let advanced = advance_window(&window, 1200, &config);
        assert!(advanced.active_records.is_empty());
    }

    // -----------------------------------------------------------------------
    // 13. Window root is independent of input order
    // -----------------------------------------------------------------------
    #[test]
    fn test_window_root_deterministic_order_independent() {
        let config = cfg(10_000, 500);
        let r1 = record_spend(100, 600, &nonce(14));
        let r2 = record_spend(200, 700, &nonce(15));

        let w_ab = build_window(&[r1.clone(), r2.clone()], 1000, &config);
        let w_ba = build_window(&[r2.clone(), r1.clone()], 1000, &config);

        assert_eq!(w_ab.window_root, w_ba.window_root);
        assert_eq!(w_ab.active_records, w_ba.active_records);
    }

    // -----------------------------------------------------------------------
    // 14. window_slots == 0 is rejected
    // -----------------------------------------------------------------------
    #[test]
    fn test_zero_window_slots_rejected() {
        let config = cfg(1_000, 0);
        let r = record_spend(100, 100, &nonce(16));
        assert_eq!(
            check_budget(&config, &[r], &[100], 200),
            Err(BudgetError::InvalidWindowConfig)
        );
    }

    // -----------------------------------------------------------------------
    // 15. Empty window produces a zero-total commitment
    // -----------------------------------------------------------------------
    #[test]
    fn test_empty_window_gives_zero_total() {
        let config = cfg(1_000, 500);
        let proof = check_budget(&config, &[], &[], 1000).unwrap();
        // No spends -> total = 0, record_count = 0, within_budget = true.
        assert!(proof.within_budget);
        assert_eq!(proof.record_count, 0);

        // The total_commit must equal SHA256("total-commit-v1" || 0u64_le || window_root).
        let expected_root = compute_window_root(&[]);
        let expected_total_commit = compute_total_commit(0, &expected_root);
        assert_eq!(proof.window_root, expected_root);
        assert_eq!(proof.total_commit, expected_total_commit);
    }

    // -----------------------------------------------------------------------
    // Bonus: duplicate nonce among active records is rejected
    // -----------------------------------------------------------------------
    #[test]
    fn test_duplicate_nonce_rejected() {
        let config = cfg(10_000, 500);
        let n = nonce(99);
        let r1 = record_spend(100, 600, &n);
        let r2 = record_spend(200, 700, &n); // same nonce
        assert_eq!(
            check_budget(&config, &[r1, r2], &[100, 200], 1000),
            Err(BudgetError::DuplicateNonce)
        );
    }
}
