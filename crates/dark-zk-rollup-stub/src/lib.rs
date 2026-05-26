use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Constants ──────────────────────────────────────────────────────────────

pub const MAX_BATCH_TXS: usize = 64;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollupBatch {
    pub batch_id: [u8; 32],
    pub tx_root: [u8; 32],
    pub state_root: [u8; 32],
    pub proof_hash: [u8; 32],
    pub tx_count: u32,
    pub is_stub: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollupTx {
    pub tx_hash: [u8; 32],
    pub sender_hash: [u8; 32],
    pub receiver_hash: [u8; 32],
    pub amount: u64,
}

#[derive(Debug, PartialEq)]
pub enum RollupError {
    EmptyBatch,
    TooManyTxs,
    ZeroOperatorKey,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

fn hex(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn xor_fold(hashes: &[[u8; 32]]) -> [u8; 32] {
    let mut acc = [0u8; 32];
    for h in hashes {
        for i in 0..32 {
            acc[i] ^= h[i];
        }
    }
    acc
}

pub fn compute_tx_hash(sender_hash: &[u8; 32], receiver_hash: &[u8; 32], amount: u64) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rollup-tx-v1");
    d.extend_from_slice(sender_hash);
    d.extend_from_slice(receiver_hash);
    d.extend_from_slice(&amount.to_le_bytes());
    sha256(&d)
}

fn compute_tx_root(tx_hashes: &[[u8; 32]], count: u32) -> [u8; 32] {
    let xor = xor_fold(tx_hashes);
    let mut d = Vec::new();
    d.extend_from_slice(b"rollup-tx-root-v1");
    d.extend_from_slice(&xor);
    d.extend_from_slice(&count.to_le_bytes());
    sha256(&d)
}

fn compute_state_root(prev_state_root: &[u8; 32], tx_root: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rollup-state-v1");
    d.extend_from_slice(prev_state_root);
    d.extend_from_slice(tx_root);
    sha256(&d)
}

fn compute_proof_hash(
    operator_key: &[u8; 32],
    tx_root: &[u8; 32],
    state_root: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rollup-proof-v1");
    d.extend_from_slice(operator_key);
    d.extend_from_slice(tx_root);
    d.extend_from_slice(state_root);
    sha256(&d)
}

fn compute_batch_id(proof_hash: &[u8; 32], tx_count: u32) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"rollup-batch-v1");
    d.extend_from_slice(proof_hash);
    d.extend_from_slice(&tx_count.to_le_bytes());
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_batch(
    operator_key: &[u8; 32],
    txs: &[RollupTx],
    prev_state_root: &[u8; 32],
) -> Result<RollupBatch, RollupError> {
    if operator_key == &[0u8; 32] {
        return Err(RollupError::ZeroOperatorKey);
    }
    if txs.is_empty() {
        return Err(RollupError::EmptyBatch);
    }
    if txs.len() > MAX_BATCH_TXS {
        return Err(RollupError::TooManyTxs);
    }

    let tx_count = txs.len() as u32;
    let tx_hashes: Vec<[u8; 32]> = txs.iter().map(|tx| tx.tx_hash).collect();
    let tx_root = compute_tx_root(&tx_hashes, tx_count);
    let state_root = compute_state_root(prev_state_root, &tx_root);
    let proof_hash = compute_proof_hash(operator_key, &tx_root, &state_root);
    let batch_id = compute_batch_id(&proof_hash, tx_count);

    Ok(RollupBatch {
        batch_id,
        tx_root,
        state_root,
        proof_hash,
        tx_count,
        is_stub: true,
        mainnet_ready: false,
    })
}

pub fn verify_batch(batch: &RollupBatch, operator_key: &[u8; 32]) -> bool {
    // We cannot recompute tx_root without the original tx_hashes here,
    // so we verify proof_hash and batch_id from stored fields.
    let expected_proof_hash = compute_proof_hash(operator_key, &batch.tx_root, &batch.state_root);
    if expected_proof_hash != batch.proof_hash {
        return false;
    }
    let expected_batch_id = compute_batch_id(&batch.proof_hash, batch.tx_count);
    expected_batch_id == batch.batch_id
}

pub fn batch_public_record(batch: &RollupBatch) -> String {
    serde_json::json!({
        "batch_id": hex(&batch.batch_id),
        "tx_root": hex(&batch.tx_root),
        "state_root": hex(&batch.state_root),
        "tx_count": batch.tx_count,
        "is_stub": batch.is_stub,
        "mainnet_ready": batch.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn op_key() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[0] = 0xde;
        k[1] = 0xad;
        k
    }

    fn prev_root() -> [u8; 32] {
        let mut r = [0u8; 32];
        r[0] = 0x01;
        r
    }

    fn make_tx(a: u8, b: u8, amount: u64) -> RollupTx {
        let mut sh = [0u8; 32];
        sh[0] = a;
        let mut rh = [0u8; 32];
        rh[0] = b;
        let tx_hash = compute_tx_hash(&sh, &rh, amount);
        RollupTx {
            tx_hash,
            sender_hash: sh,
            receiver_hash: rh,
            amount,
        }
    }

    // Test 1: create + verify passes
    #[test]
    fn test_create_and_verify() {
        let txs = vec![make_tx(1, 2, 1000), make_tx(3, 4, 2000)];
        let batch = create_batch(&op_key(), &txs, &prev_root()).unwrap();
        assert!(batch.is_stub);
        assert!(!batch.mainnet_ready);
        assert_eq!(batch.tx_count, 2);
        assert!(verify_batch(&batch, &op_key()));
    }

    // Test 2: deterministic — same inputs → same batch
    #[test]
    fn test_deterministic() {
        let txs = vec![make_tx(1, 2, 500)];
        let b1 = create_batch(&op_key(), &txs, &prev_root()).unwrap();
        let b2 = create_batch(&op_key(), &txs, &prev_root()).unwrap();
        assert_eq!(b1.batch_id, b2.batch_id);
        assert_eq!(b1.tx_root, b2.tx_root);
        assert_eq!(b1.state_root, b2.state_root);
    }

    // Test 3: tx_root sensitive to txs
    #[test]
    fn test_tx_root_sensitive() {
        let txs1 = vec![make_tx(1, 2, 100)];
        let txs2 = vec![make_tx(5, 6, 999)];
        let b1 = create_batch(&op_key(), &txs1, &prev_root()).unwrap();
        let b2 = create_batch(&op_key(), &txs2, &prev_root()).unwrap();
        assert_ne!(b1.tx_root, b2.tx_root);
        assert_ne!(b1.batch_id, b2.batch_id);
    }

    // Test 4: empty batch rejected
    #[test]
    fn test_empty_batch_rejected() {
        let err = create_batch(&op_key(), &[], &prev_root()).unwrap_err();
        assert_eq!(err, RollupError::EmptyBatch);
    }

    // Test 5: too many txs rejected
    #[test]
    fn test_too_many_txs_rejected() {
        let txs: Vec<RollupTx> = (0..65u8)
            .map(|i| make_tx(i, i.wrapping_add(1), 1))
            .collect();
        let err = create_batch(&op_key(), &txs, &prev_root()).unwrap_err();
        assert_eq!(err, RollupError::TooManyTxs);
    }

    // Test 6: is_stub=true and mainnet_ready=false
    #[test]
    fn test_stub_and_not_mainnet() {
        let txs = vec![make_tx(1, 2, 1)];
        let batch = create_batch(&op_key(), &txs, &prev_root()).unwrap();
        assert!(batch.is_stub);
        assert!(!batch.mainnet_ready);

        let record = batch_public_record(&batch);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["is_stub"], true);
        assert_eq!(v["mainnet_ready"], false);
    }
}
