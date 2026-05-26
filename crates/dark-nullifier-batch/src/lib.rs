use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_BATCH: usize = 64;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NullifierBatch {
    pub batch_id: [u8; 32],
    pub nullifiers: Vec<[u8; 32]>,
    pub batch_root: [u8; 32],
    pub epoch: u64,
    pub submitted: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum BatchError {
    EmptyBatch,
    TooLarge,
    DuplicateNullifier,
    AlreadySubmitted,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256_multi(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts { h.update(p); }
    h.finalize().into()
}

fn xor_fold(bufs: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for b in bufs {
        for i in 0..32 { acc[i] ^= b[i]; }
    }
    acc
}

fn hex32(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn compute_batch_root(nullifiers: &[[u8; 32]], epoch: u64) -> [u8; 32] {
    let xor_null = xor_fold(nullifiers);
    let count = nullifiers.len() as u32;
    sha256_multi(&[b"nbatch-root-v1", &xor_null, &count.to_le_bytes(), &epoch.to_le_bytes()])
}

fn compute_batch_id(batch_root: &[u8; 32]) -> [u8; 32] {
    sha256_multi(&[b"nbatch-id-v1", batch_root])
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_batch(nullifiers: Vec<[u8; 32]>, epoch: u64) -> Result<NullifierBatch, BatchError> {
    if nullifiers.is_empty() {
        return Err(BatchError::EmptyBatch);
    }
    if nullifiers.len() > MAX_BATCH {
        return Err(BatchError::TooLarge);
    }
    // Check for duplicates
    let mut seen = HashSet::new();
    for n in &nullifiers {
        if !seen.insert(n) {
            return Err(BatchError::DuplicateNullifier);
        }
    }
    let batch_root = compute_batch_root(&nullifiers, epoch);
    let batch_id = compute_batch_id(&batch_root);
    Ok(NullifierBatch {
        batch_id,
        nullifiers,
        batch_root,
        epoch,
        submitted: false,
        mainnet_ready: false,
    })
}

pub fn submit_batch(batch: &mut NullifierBatch) -> Result<[u8; 32], BatchError> {
    if batch.submitted {
        return Err(BatchError::AlreadySubmitted);
    }
    batch.submitted = true;
    Ok(batch.batch_id)
}

pub fn verify_batch_integrity(batch: &NullifierBatch) -> bool {
    let expected_root = compute_batch_root(&batch.nullifiers, batch.epoch);
    if expected_root != batch.batch_root { return false; }
    let expected_id = compute_batch_id(&batch.batch_root);
    expected_id == batch.batch_id
}

pub fn batch_public_record(batch: &NullifierBatch) -> String {
    serde_json::json!({
        "batch_id": hex32(&batch.batch_id),
        "batch_root": hex32(&batch.batch_root),
        "nullifier_count": batch.nullifiers.len(),
        "epoch": batch.epoch,
        "submitted": batch.submitted,
        "mainnet_ready": batch.mainnet_ready,
    }).to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn null(b: u8) -> [u8; 32] { let mut s = [0u8; 32]; s[0] = b; s }

    // Test 1: create + submit
    #[test]
    fn test_create_and_submit() {
        let nullifiers = vec![null(0x01), null(0x02), null(0x03)];
        let mut batch = create_batch(nullifiers, 42).unwrap();
        assert!(!batch.submitted);
        assert!(!batch.mainnet_ready);
        let bid = submit_batch(&mut batch).unwrap();
        assert!(batch.submitted);
        assert_eq!(bid, batch.batch_id);
    }

    // Test 2: verify integrity
    #[test]
    fn test_verify_integrity() {
        let nullifiers = vec![null(0x10), null(0x20), null(0x30)];
        let batch = create_batch(nullifiers, 7).unwrap();
        assert!(verify_batch_integrity(&batch));
    }

    // Test 3: empty batch rejected
    #[test]
    fn test_empty_batch_rejected() {
        let err = create_batch(vec![], 1).unwrap_err();
        assert_eq!(err, BatchError::EmptyBatch);
    }

    // Test 4: too large rejected
    #[test]
    fn test_too_large_rejected() {
        let nullifiers: Vec<[u8; 32]> = (0..=MAX_BATCH as u8).map(|i| null(i)).collect();
        let err = create_batch(nullifiers, 1).unwrap_err();
        assert_eq!(err, BatchError::TooLarge);
    }

    // Test 5: duplicate nullifier rejected
    #[test]
    fn test_duplicate_nullifier_rejected() {
        let nullifiers = vec![null(0xAA), null(0xBB), null(0xAA)]; // duplicate
        let err = create_batch(nullifiers, 1).unwrap_err();
        assert_eq!(err, BatchError::DuplicateNullifier);
    }

    // Test 6: already submitted rejected
    #[test]
    fn test_already_submitted_rejected() {
        let nullifiers = vec![null(0x11), null(0x22)];
        let mut batch = create_batch(nullifiers, 5).unwrap();
        submit_batch(&mut batch).unwrap();
        let err = submit_batch(&mut batch).unwrap_err();
        assert_eq!(err, BatchError::AlreadySubmitted);
    }
}
