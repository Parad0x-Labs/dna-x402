// NULL_FLYWHEEL_VAULT_V1 — execution receipts for public auditability
// NOT_PRODUCTION — devnet design only — no audit — mainnet_ready = false

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// Merkle-style root of all fee events in this epoch.
#[derive(Debug, Clone)]
pub struct FeeSourceRoot {
    pub root: [u8; 32],
    pub epoch: u64,
    pub event_count: u32,
}

/// Publicly-auditable record of a single flywheel execution.
#[derive(Debug, Clone)]
pub struct FlywheelExecutionReceipt {
    pub receipt_hash: [u8; 32],
    pub epoch: u64,
    pub executed_at_slot: u64,
    /// SHA256("alloc-amount" || lamports.to_le_bytes())
    pub allocated_lamports_hash: [u8; 32],
    pub fee_source_root: [u8; 32],
    /// SHA256("destination" || destination_label_bytes)
    pub destination_hash: [u8; 32],
    /// Hash of the ScheduleReveal that authorized this execution.
    pub schedule_reveal_hash: [u8; 32],
    pub is_public: bool,
    /// Always false — this is a devnet-only design.
    pub mainnet_ready: bool,
}

/// XOR-fold aggregate of all receipts in one epoch.
#[derive(Debug, Clone)]
pub struct EpochReceiptAggregate {
    pub epoch: u64,
    pub total_receipts: u32,
    /// XOR-fold of all receipt_hash values (simple, not Merkle).
    pub aggregate_root: [u8; 32],
    pub total_allocated_hash: [u8; 32],
}

// ---------------------------------------------------------------------------
// Helper — hash a raw lamport amount
// ---------------------------------------------------------------------------

fn hash_allocated_lamports(lamports: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"alloc-amount");
    h.update(lamports.to_le_bytes());
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Helper — hash a destination label
// ---------------------------------------------------------------------------

fn hash_destination(label: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"destination");
    h.update(label.as_bytes());
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Helper — compute the canonical receipt_hash from its fields
// ---------------------------------------------------------------------------

fn compute_receipt_hash(
    epoch: u64,
    executed_at_slot: u64,
    allocated_lamports_hash: &[u8; 32],
    fee_source_root: &[u8; 32],
    destination_hash: &[u8; 32],
    schedule_reveal_hash: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"flywheel-receipt-v1");
    h.update(epoch.to_le_bytes());
    h.update(executed_at_slot.to_le_bytes());
    h.update(allocated_lamports_hash);
    h.update(fee_source_root);
    h.update(destination_hash);
    h.update(schedule_reveal_hash);
    h.finalize().into()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Fold multiple fee-event hashes into a single epoch-level root.
///
/// `root = SHA256("fee-root-v1" || event_hashes[0] || event_hashes[1] || ...)`
pub fn build_fee_source_root(event_hashes: &[[u8; 32]], epoch: u64) -> FeeSourceRoot {
    let mut h = Sha256::new();
    h.update(b"fee-root-v1");
    for ev in event_hashes {
        h.update(ev);
    }
    let root: [u8; 32] = h.finalize().into();
    FeeSourceRoot {
        root,
        epoch,
        event_count: event_hashes.len() as u32,
    }
}

/// Create a new execution receipt.  `mainnet_ready` is always `false`.
pub fn build_execution_receipt(
    epoch: u64,
    executed_at_slot: u64,
    allocated_lamports: u64,
    fee_source_root: &[u8; 32],
    destination_label: &str,
    schedule_reveal_hash: &[u8; 32],
) -> FlywheelExecutionReceipt {
    let allocated_lamports_hash = hash_allocated_lamports(allocated_lamports);
    let destination_hash = hash_destination(destination_label);

    let receipt_hash = compute_receipt_hash(
        epoch,
        executed_at_slot,
        &allocated_lamports_hash,
        fee_source_root,
        &destination_hash,
        schedule_reveal_hash,
    );

    FlywheelExecutionReceipt {
        receipt_hash,
        epoch,
        executed_at_slot,
        allocated_lamports_hash,
        fee_source_root: *fee_source_root,
        destination_hash,
        schedule_reveal_hash: *schedule_reveal_hash,
        is_public: true,
        mainnet_ready: false,
    }
}

/// Recompute `receipt_hash` from the stored fields and compare.
/// Returns `true` if the receipt is unmodified.
pub fn verify_execution_receipt(receipt: &FlywheelExecutionReceipt) -> bool {
    let expected = compute_receipt_hash(
        receipt.epoch,
        receipt.executed_at_slot,
        &receipt.allocated_lamports_hash,
        &receipt.fee_source_root,
        &receipt.destination_hash,
        &receipt.schedule_reveal_hash,
    );
    expected == receipt.receipt_hash
}

/// Return a `serde_json::Value` containing only hashes — no raw amounts.
///
/// Fields: `receipt_hash`, `epoch`, `fee_source_root`, `destination_hash`,
/// `is_public` (true), `mainnet_ready` (false).
pub fn redacted_public_receipt(receipt: &FlywheelExecutionReceipt) -> serde_json::Value {
    serde_json::json!({
        "receipt_hash":    hex_encode(&receipt.receipt_hash),
        "epoch":           receipt.epoch,
        "fee_source_root": hex_encode(&receipt.fee_source_root),
        "destination_hash": hex_encode(&receipt.destination_hash),
        "is_public":       true,
        "mainnet_ready":   false,
    })
}

/// XOR-fold all `receipt_hash` values into a single `EpochReceiptAggregate`.
pub fn aggregate_epoch_receipts(
    receipts: &[FlywheelExecutionReceipt],
    epoch: u64,
) -> EpochReceiptAggregate {
    let mut aggregate_root = [0u8; 32];
    for r in receipts {
        for (i, b) in r.receipt_hash.iter().enumerate() {
            aggregate_root[i] ^= b;
        }
    }

    // total_allocated_hash is a SHA256 of all allocated_lamports_hash values
    // concatenated — this gives a compact commitment to the set of hashed amounts.
    let mut h = Sha256::new();
    h.update(b"epoch-alloc-total-v1");
    for r in receipts {
        h.update(r.allocated_lamports_hash);
    }
    let total_allocated_hash: [u8; 32] = h.finalize().into();

    EpochReceiptAggregate {
        epoch,
        total_receipts: receipts.len() as u32,
        aggregate_root,
        total_allocated_hash,
    }
}

// ---------------------------------------------------------------------------
// Internal helper — lowercase hex encoding without pulling in extra deps
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_fee_root() -> [u8; 32] {
        let ev1 = [1u8; 32];
        let ev2 = [2u8; 32];
        build_fee_source_root(&[ev1, ev2], 42).root
    }

    fn dummy_schedule_reveal_hash() -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"test-schedule-reveal");
        h.finalize().into()
    }

    // 1. Same params → same receipt_hash
    #[test]
    fn test_receipt_hash_deterministic() {
        let fee_root = dummy_fee_root();
        let srh = dummy_schedule_reveal_hash();

        let r1 = build_execution_receipt(7, 1_000, 250_000, &fee_root, "treasury", &srh);
        let r2 = build_execution_receipt(7, 1_000, 250_000, &fee_root, "treasury", &srh);

        assert_eq!(r1.receipt_hash, r2.receipt_hash);
    }

    // 2. build → verify returns true
    #[test]
    fn test_verify_receipt_roundtrip() {
        let fee_root = dummy_fee_root();
        let srh = dummy_schedule_reveal_hash();

        let receipt = build_execution_receipt(1, 500, 100_000, &fee_root, "burn-sink", &srh);
        assert!(verify_execution_receipt(&receipt));
    }

    // 3. Mutate epoch → verify returns false
    #[test]
    fn test_verify_detects_tampering() {
        let fee_root = dummy_fee_root();
        let srh = dummy_schedule_reveal_hash();

        let mut receipt = build_execution_receipt(3, 900, 99_000, &fee_root, "stakers", &srh);
        receipt.epoch = 999; // tamper
        assert!(!verify_execution_receipt(&receipt));
    }

    // 4. mainnet_ready is always false
    #[test]
    fn test_mainnet_ready_always_false() {
        let fee_root = dummy_fee_root();
        let srh = dummy_schedule_reveal_hash();

        let receipt = build_execution_receipt(0, 0, 1, &fee_root, "devnet-only", &srh);
        assert!(!receipt.mainnet_ready);
    }

    // 5. Public receipt JSON does not contain the raw lamport amount
    #[test]
    fn test_redacted_public_receipt_no_raw_amounts() {
        let fee_root = dummy_fee_root();
        let srh = dummy_schedule_reveal_hash();

        let receipt = build_execution_receipt(5, 200, 500_000, &fee_root, "vault", &srh);
        let public_json = redacted_public_receipt(&receipt);
        let serialized = serde_json::to_string(&public_json).expect("serialize ok");

        // The raw lamport amount must NOT appear in the public receipt.
        assert!(
            !serialized.contains("500000"),
            "raw lamport amount leaked into public receipt: {serialized}"
        );
    }

    // 6. Same receipts produce same aggregate_root
    #[test]
    fn test_aggregate_epoch_receipts_deterministic() {
        let fee_root = dummy_fee_root();
        let srh = dummy_schedule_reveal_hash();

        let receipts: Vec<_> = (0u64..3)
            .map(|i| build_execution_receipt(10, i * 100, 10_000 * i, &fee_root, "pool", &srh))
            .collect();

        let agg1 = aggregate_epoch_receipts(&receipts, 10);
        let agg2 = aggregate_epoch_receipts(&receipts, 10);

        assert_eq!(agg1.aggregate_root, agg2.aggregate_root);
        assert_eq!(agg1.total_receipts, 3);
    }
}
