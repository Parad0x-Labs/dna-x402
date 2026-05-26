use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReceiptLayer {
    Flywheel = 1,
    ZkProof = 2,
    Compute = 3,
    Compliance = 4,
    Payment = 5,
}

pub struct ReceiptEntry {
    pub layer: ReceiptLayer,
    pub receipt_hash: [u8; 32],
    pub epoch: u64,
}

/// Aggregated epoch state.
///
/// `xor_accumulator` is private — it holds the running XOR of every
/// `receipt_hash` added so far and is consumed by `finalize_epoch`.
/// It is intentionally excluded from the JSON summary.
pub struct EpochSummary {
    pub epoch: u64,
    /// Set to the final value by `finalize_epoch`.
    /// While adding entries it holds the running XOR accumulator.
    pub epoch_root: [u8; 32],
    pub entry_count: u32,
    /// index = ReceiptLayer as usize (1–5); index 0 is unused.
    pub layer_counts: [u32; 6],
    /// Always false — not yet mainnet-ready.
    pub mainnet_ready: bool,
    // Private running XOR of all receipt_hashes added before finalization.
    xor_accumulator: [u8; 32],
}

#[derive(Debug, PartialEq, Eq)]
pub enum AggregatorError {
    EmptyEpoch,
    EpochMismatch { expected: u64, got: u64 },
    Overflow,
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/// Create an empty `EpochSummary` for the given epoch.
pub fn new_epoch_summary(epoch: u64) -> EpochSummary {
    EpochSummary {
        epoch,
        epoch_root: [0u8; 32],
        entry_count: 0,
        layer_counts: [0u32; 6],
        mainnet_ready: false,
        xor_accumulator: [0u8; 32],
    }
}

/// Add a single `ReceiptEntry` to the running summary.
///
/// Returns `EpochMismatch` if `entry.epoch != summary.epoch`.
/// Returns `Overflow` if `entry_count` would exceed `u32::MAX`.
pub fn add_receipt(
    summary: &mut EpochSummary,
    entry: ReceiptEntry,
) -> Result<(), AggregatorError> {
    if entry.epoch != summary.epoch {
        return Err(AggregatorError::EpochMismatch {
            expected: summary.epoch,
            got: entry.epoch,
        });
    }

    summary.entry_count = summary
        .entry_count
        .checked_add(1)
        .ok_or(AggregatorError::Overflow)?;

    let idx = entry.layer as usize;
    summary.layer_counts[idx] = summary.layer_counts[idx]
        .checked_add(1)
        .ok_or(AggregatorError::Overflow)?;

    // XOR-fold the new hash into the accumulator.
    for (acc, &b) in summary.xor_accumulator.iter_mut().zip(entry.receipt_hash.iter()) {
        *acc ^= b;
    }

    Ok(())
}

/// Finalise the epoch: compute the canonical `epoch_root` and store it.
///
/// `epoch_root` = SHA256("epoch-root-v1" || epoch_le64 || xor_accumulator)
///
/// Returns `EmptyEpoch` if no entries were added.
pub fn finalize_epoch(summary: &mut EpochSummary) -> Result<[u8; 32], AggregatorError> {
    if summary.entry_count == 0 {
        return Err(AggregatorError::EmptyEpoch);
    }

    let root: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"epoch-root-v1");
        h.update(summary.epoch.to_le_bytes());
        h.update(summary.xor_accumulator);
        h.finalize().into()
    };

    summary.epoch_root = root;
    Ok(root)
}

/// Produce a JSON summary suitable for public publication.
///
/// Fields: `epoch`, `epoch_root` (hex), `entry_count`,
/// `layer_counts` (object with human-readable layer names), `mainnet_ready`.
pub fn epoch_summary_json(summary: &EpochSummary) -> String {
    let root_hex = hex_encode(&summary.epoch_root);

    serde_json::json!({
        "epoch":       summary.epoch,
        "epoch_root":  root_hex,
        "entry_count": summary.entry_count,
        "layer_counts": {
            "flywheel":   summary.layer_counts[ReceiptLayer::Flywheel   as usize],
            "zk_proof":   summary.layer_counts[ReceiptLayer::ZkProof    as usize],
            "compute":    summary.layer_counts[ReceiptLayer::Compute     as usize],
            "compliance": summary.layer_counts[ReceiptLayer::Compliance  as usize],
            "payment":    summary.layer_counts[ReceiptLayer::Payment     as usize],
        },
        "mainnet_ready": summary.mainnet_ready,
    })
    .to_string()
}

/// Human-readable name for a `ReceiptLayer`.
pub fn layer_name(layer: ReceiptLayer) -> &'static str {
    match layer {
        ReceiptLayer::Flywheel  => "flywheel",
        ReceiptLayer::ZkProof   => "zk_proof",
        ReceiptLayer::Compute   => "compute",
        ReceiptLayer::Compliance => "compliance",
        ReceiptLayer::Payment   => "payment",
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn make_entry(layer: ReceiptLayer, epoch: u64, seed: u8) -> ReceiptEntry {
    ReceiptEntry {
        layer,
        receipt_hash: [seed; 32],
        epoch,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const EPOCH: u64 = 42;

    // 1. Three flywheel receipts → epoch_root non-zero, entry_count = 3
    #[test]
    fn test_single_layer_epoch() {
        let mut s = new_epoch_summary(EPOCH);
        for seed in [0x11u8, 0x22, 0x33] {
            add_receipt(&mut s, make_entry(ReceiptLayer::Flywheel, EPOCH, seed)).unwrap();
        }
        let root = finalize_epoch(&mut s).unwrap();
        assert_eq!(s.entry_count, 3);
        assert_ne!(root, [0u8; 32]);
        assert_eq!(s.layer_counts[ReceiptLayer::Flywheel as usize], 3);
    }

    // 2. Three different layers → layer_counts correct
    #[test]
    fn test_mixed_layer_epoch() {
        let mut s = new_epoch_summary(EPOCH);
        add_receipt(&mut s, make_entry(ReceiptLayer::Flywheel,   EPOCH, 0x01)).unwrap();
        add_receipt(&mut s, make_entry(ReceiptLayer::ZkProof,    EPOCH, 0x02)).unwrap();
        add_receipt(&mut s, make_entry(ReceiptLayer::Compliance, EPOCH, 0x03)).unwrap();
        finalize_epoch(&mut s).unwrap();
        assert_eq!(s.layer_counts[ReceiptLayer::Flywheel   as usize], 1);
        assert_eq!(s.layer_counts[ReceiptLayer::ZkProof    as usize], 1);
        assert_eq!(s.layer_counts[ReceiptLayer::Compliance as usize], 1);
        assert_eq!(s.layer_counts[ReceiptLayer::Compute    as usize], 0);
        assert_eq!(s.layer_counts[ReceiptLayer::Payment    as usize], 0);
    }

    // 3. finalize on empty epoch → EmptyEpoch
    #[test]
    fn test_empty_epoch_fails() {
        let mut s = new_epoch_summary(EPOCH);
        assert_eq!(finalize_epoch(&mut s), Err(AggregatorError::EmptyEpoch));
    }

    // 4. Same receipts + same order → same epoch_root (deterministic)
    #[test]
    fn test_epoch_root_deterministic() {
        let build = || {
            let mut s = new_epoch_summary(EPOCH);
            for seed in [0xAAu8, 0xBB, 0xCC] {
                add_receipt(&mut s, make_entry(ReceiptLayer::Payment, EPOCH, seed)).unwrap();
            }
            finalize_epoch(&mut s).unwrap()
        };
        assert_eq!(build(), build());
    }

    // 5. Receipt with wrong epoch → EpochMismatch
    #[test]
    fn test_epoch_mismatch_rejected() {
        let mut s = new_epoch_summary(EPOCH);
        let result = add_receipt(&mut s, make_entry(ReceiptLayer::Compute, EPOCH + 1, 0xFF));
        assert_eq!(
            result,
            Err(AggregatorError::EpochMismatch { expected: EPOCH, got: EPOCH + 1 })
        );
    }
}
