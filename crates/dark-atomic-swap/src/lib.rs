use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtomicSwap {
    pub swap_id: [u8; 32],
    pub party_a_hash: [u8; 32],
    pub party_b_hash: [u8; 32],
    pub asset_a_hash: [u8; 32],
    pub asset_b_hash: [u8; 32],
    pub amount_a: u64,
    pub amount_b: u64,
    pub hash_lock: [u8; 32],
    pub completed: bool,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapProof {
    pub swap_id: [u8; 32],
    pub preimage_hash: [u8; 32],
    pub mainnet_ready: bool,
}

#[derive(Debug, PartialEq)]
pub enum AtomicError {
    ZeroPartySecret,
    AmountZero,
    SameAssets,
    AlreadyCompleted,
    WrongPreimage,
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

fn compute_party_hash(secret: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"atomic-party-v1");
    d.extend_from_slice(secret);
    sha256(&d)
}

fn compute_asset_hash(asset_bytes: &[u8]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"atomic-asset-v1");
    d.extend_from_slice(asset_bytes);
    sha256(&d)
}

fn compute_hash_lock(preimage: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"atomic-lock-v1");
    d.extend_from_slice(preimage);
    sha256(&d)
}

fn compute_preimage_hash(preimage: &[u8; 32]) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"atomic-preimage-v1");
    d.extend_from_slice(preimage);
    sha256(&d)
}

fn compute_swap_id(
    party_a_hash: &[u8; 32],
    party_b_hash: &[u8; 32],
    asset_a_hash: &[u8; 32],
    asset_b_hash: &[u8; 32],
    amount_a: u64,
    amount_b: u64,
    hash_lock: &[u8; 32],
) -> [u8; 32] {
    let mut d = Vec::new();
    d.extend_from_slice(b"atomic-swap-v1");
    d.extend_from_slice(party_a_hash);
    d.extend_from_slice(party_b_hash);
    d.extend_from_slice(asset_a_hash);
    d.extend_from_slice(asset_b_hash);
    d.extend_from_slice(&amount_a.to_le_bytes());
    d.extend_from_slice(&amount_b.to_le_bytes());
    d.extend_from_slice(hash_lock);
    sha256(&d)
}

// ── API ────────────────────────────────────────────────────────────────────

pub fn create_swap(
    party_a_secret: &[u8; 32],
    party_b_secret: &[u8; 32],
    asset_a: &[u8],
    asset_b: &[u8],
    amount_a: u64,
    amount_b: u64,
    preimage: &[u8; 32],
) -> Result<AtomicSwap, AtomicError> {
    if party_a_secret == &[0u8; 32] || party_b_secret == &[0u8; 32] {
        return Err(AtomicError::ZeroPartySecret);
    }
    if amount_a == 0 || amount_b == 0 {
        return Err(AtomicError::AmountZero);
    }
    let asset_a_hash = compute_asset_hash(asset_a);
    let asset_b_hash = compute_asset_hash(asset_b);
    if asset_a_hash == asset_b_hash {
        return Err(AtomicError::SameAssets);
    }
    let party_a_hash = compute_party_hash(party_a_secret);
    let party_b_hash = compute_party_hash(party_b_secret);
    let hash_lock = compute_hash_lock(preimage);
    let swap_id = compute_swap_id(
        &party_a_hash,
        &party_b_hash,
        &asset_a_hash,
        &asset_b_hash,
        amount_a,
        amount_b,
        &hash_lock,
    );
    Ok(AtomicSwap {
        swap_id,
        party_a_hash,
        party_b_hash,
        asset_a_hash,
        asset_b_hash,
        amount_a,
        amount_b,
        hash_lock,
        completed: false,
        mainnet_ready: false,
    })
}

pub fn claim_swap(swap: &mut AtomicSwap, preimage: &[u8; 32]) -> Result<SwapProof, AtomicError> {
    if swap.completed {
        return Err(AtomicError::AlreadyCompleted);
    }
    let hash_lock_check = compute_hash_lock(preimage);
    if hash_lock_check != swap.hash_lock {
        return Err(AtomicError::WrongPreimage);
    }
    swap.completed = true;
    let preimage_hash = compute_preimage_hash(preimage);
    Ok(SwapProof {
        swap_id: swap.swap_id,
        preimage_hash,
        mainnet_ready: false,
    })
}

pub fn swap_public_record(swap: &AtomicSwap) -> String {
    serde_json::json!({
        "swap_id":      hex(&swap.swap_id),
        "asset_a_hash": hex(&swap.asset_a_hash),
        "asset_b_hash": hex(&swap.asset_b_hash),
        "amount_a":     swap.amount_a,
        "amount_b":     swap.amount_b,
        "completed":    swap.completed,
        "mainnet_ready": swap.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn party_a() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x11;
        s
    }
    fn party_b() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0x22;
        s
    }
    fn preimage() -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = 0xab;
        s
    }

    // Test 1: create + claim happy path
    #[test]
    fn test_create_and_claim() {
        let mut swap = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            100,
            200,
            &preimage(),
        )
        .unwrap();
        assert!(!swap.completed);
        assert!(!swap.mainnet_ready);
        let proof = claim_swap(&mut swap, &preimage()).unwrap();
        assert_eq!(proof.swap_id, swap.swap_id);
        assert!(swap.completed);
        assert!(!proof.mainnet_ready);
    }

    // Test 2: wrong preimage rejected
    #[test]
    fn test_wrong_preimage_rejected() {
        let mut swap = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            100,
            200,
            &preimage(),
        )
        .unwrap();
        let mut wrong = [0u8; 32];
        wrong[0] = 0xff;
        let err = claim_swap(&mut swap, &wrong).unwrap_err();
        assert_eq!(err, AtomicError::WrongPreimage);
    }

    // Test 3: same assets rejected
    #[test]
    fn test_same_assets_rejected() {
        let err = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"SOL",
            100,
            200,
            &preimage(),
        )
        .unwrap_err();
        assert_eq!(err, AtomicError::SameAssets);
    }

    // Test 4: already completed rejected
    #[test]
    fn test_already_completed_rejected() {
        let mut swap = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            100,
            200,
            &preimage(),
        )
        .unwrap();
        claim_swap(&mut swap, &preimage()).unwrap();
        let err = claim_swap(&mut swap, &preimage()).unwrap_err();
        assert_eq!(err, AtomicError::AlreadyCompleted);
    }

    // Test 5: swap_id is deterministic
    #[test]
    fn test_swap_id_deterministic() {
        let s1 = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            100,
            200,
            &preimage(),
        )
        .unwrap();
        let s2 = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            100,
            200,
            &preimage(),
        )
        .unwrap();
        assert_eq!(s1.swap_id, s2.swap_id);
        // Different amounts → different swap_id
        let s3 = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            999,
            200,
            &preimage(),
        )
        .unwrap();
        assert_ne!(s1.swap_id, s3.swap_id);
    }

    // Test 6: public record hides party hashes
    #[test]
    fn test_public_record_hides_parties() {
        let swap = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            100,
            200,
            &preimage(),
        )
        .unwrap();
        let record = swap_public_record(&swap);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert!(v["swap_id"].is_string());
        assert_eq!(v["completed"], false);
        assert_eq!(v["mainnet_ready"], false);
        assert!(v.get("party_a_hash").is_none());
        assert!(v.get("party_b_hash").is_none());
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_mainnet_ready_always_false() {
        let swap = create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 1, 2, &preimage()).unwrap();
        assert!(!swap.mainnet_ready);
    }

    #[test]
    fn test_completed_starts_false() {
        let swap = create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 1, 2, &preimage()).unwrap();
        assert!(!swap.completed);
    }

    #[test]
    fn test_completed_set_after_claim() {
        let mut swap =
            create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 1, 2, &preimage()).unwrap();
        claim_swap(&mut swap, &preimage()).unwrap();
        assert!(swap.completed);
    }

    #[test]
    fn test_swap_proof_mainnet_ready_false() {
        let mut swap =
            create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 1, 2, &preimage()).unwrap();
        let proof = claim_swap(&mut swap, &preimage()).unwrap();
        assert!(!proof.mainnet_ready);
    }

    #[test]
    fn test_wrong_preimage_returns_error() {
        let mut swap =
            create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 1, 2, &preimage()).unwrap();
        let mut wrong = [0u8; 32];
        wrong[0] = 0xFF;
        let err = claim_swap(&mut swap, &wrong).unwrap_err();
        assert_eq!(err, AtomicError::WrongPreimage);
    }

    #[test]
    fn test_zero_amount_a_rejected() {
        let err =
            create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 0, 200, &preimage()).unwrap_err();
        assert_eq!(err, AtomicError::AmountZero);
    }

    #[test]
    fn test_zero_amount_b_rejected() {
        let err =
            create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 100, 0, &preimage()).unwrap_err();
        assert_eq!(err, AtomicError::AmountZero);
    }

    #[test]
    fn test_same_assets_not_allowed() {
        let err = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"SOL",
            100,
            200,
            &preimage(),
        )
        .unwrap_err();
        assert_eq!(err, AtomicError::SameAssets);
    }

    #[test]
    fn test_swap_id_sensitive_to_preimage() {
        let p1 = preimage();
        let mut p2 = [0u8; 32];
        p2[0] = 0xFF;
        let s1 = create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 100, 200, &p1).unwrap();
        let s2 = create_swap(&party_a(), &party_b(), b"SOL", b"USDC", 100, 200, &p2).unwrap();
        assert_ne!(s1.swap_id, s2.swap_id);
    }

    #[test]
    fn test_public_record_has_amounts() {
        let swap = create_swap(
            &party_a(),
            &party_b(),
            b"SOL",
            b"USDC",
            333,
            444,
            &preimage(),
        )
        .unwrap();
        let record = swap_public_record(&swap);
        let v: serde_json::Value = serde_json::from_str(&record).unwrap();
        assert_eq!(v["amount_a"], 333u64);
        assert_eq!(v["amount_b"], 444u64);
    }
}
