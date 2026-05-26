use sha2::{Digest, Sha256};

// ── Types ──────────────────────────────────────────────────────────────────────

/// A hidden LP position represented as a commitment on-chain.
/// Amounts are never stored in the clear; only the commitment hash is public.
#[derive(Debug, Clone)]
pub struct LpPosition {
    /// SHA256("lp-pos-v1" || lp_hash || amount_a_le || amount_b_le || nonce)
    pub position_commitment: [u8; 32],
    /// SHA256("lp-owner-v1" || lp_secret)
    pub lp_hash: [u8; 32],
    pub mainnet_ready: bool,
}

/// Proof that a swap occurred against the pool without revealing pool internals.
#[derive(Debug, Clone)]
pub struct SwapProof {
    /// SHA256("swap-v1" || pool_root || amount_in_le || amount_out_le || direction_byte)
    pub swap_hash: [u8; 32],
    pub direction: SwapDirection,
    pub mainnet_ready: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SwapDirection {
    AToB = 0,
    BToA = 1,
}

/// Public AMM pool state. Only commitment hashes are stored — no raw amounts.
#[derive(Debug)]
pub struct AmmPool {
    /// XOR-fold of all position_commitments, then SHA256("amm-root-v1" || xor_fold)
    pub pool_root: [u8; 32],
    pub position_count: u32,
    pub swap_count: u32,
    positions: Vec<[u8; 32]>,
    mainnet_ready: bool,
    /// Running XOR accumulator over all active commitment bytes.
    xor_accumulator: [u8; 32],
}

#[derive(Debug, PartialEq)]
pub enum AmmError {
    ZeroAmount,
    LpSecretZero,
    PositionNotFound,
    OwnershipMismatch,
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn sha256(data: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for chunk in data {
        h.update(chunk);
    }
    h.finalize().into()
}

fn xor32(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = a[i] ^ b[i];
    }
    out
}

fn recompute_root(xor_acc: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"amm-root-v1", xor_acc])
}

// ── Public API ─────────────────────────────────────────────────────────────────

/// Create an empty private AMM pool.
pub fn new_pool() -> AmmPool {
    let xor_accumulator = [0u8; 32];
    let pool_root = recompute_root(&xor_accumulator);
    AmmPool {
        pool_root,
        position_count: 0,
        swap_count: 0,
        positions: Vec::new(),
        mainnet_ready: false,
        xor_accumulator,
    }
}

/// Build a commitment for a new LP position.
///
/// Errors:
/// - `ZeroAmount`   — both amount_a and amount_b are zero
/// - `LpSecretZero` — lp_secret is the all-zero key
pub fn create_position(
    lp_secret: &[u8; 32],
    amount_a: u64,
    amount_b: u64,
    nonce: &[u8; 32],
) -> Result<LpPosition, AmmError> {
    if *lp_secret == [0u8; 32] {
        return Err(AmmError::LpSecretZero);
    }
    if amount_a == 0 && amount_b == 0 {
        return Err(AmmError::ZeroAmount);
    }

    let lp_hash = sha256(&[b"lp-owner-v1", lp_secret.as_slice()]);
    let position_commitment = sha256(&[
        b"lp-pos-v1",
        lp_hash.as_slice(),
        &amount_a.to_le_bytes(),
        &amount_b.to_le_bytes(),
        nonce.as_slice(),
    ]);

    Ok(LpPosition {
        position_commitment,
        lp_hash,
        mainnet_ready: false,
    })
}

/// Add an LP position commitment to the pool.
///
/// The pool root is updated after every addition; individual amounts remain hidden.
pub fn add_liquidity(pool: &mut AmmPool, position: &LpPosition) {
    // XOR the new commitment into the accumulator
    pool.xor_accumulator = xor32(&pool.xor_accumulator, &position.position_commitment);
    pool.pool_root = recompute_root(&pool.xor_accumulator);
    pool.position_count += 1;
    pool.positions.push(position.position_commitment);
}

/// Remove an LP position from the pool.
///
/// Errors:
/// - `PositionNotFound`   — commitment is not present in the pool
/// - `OwnershipMismatch`  — lp_secret does not match the commitment's recorded lp_hash
pub fn remove_liquidity(
    pool: &mut AmmPool,
    position: &LpPosition,
    lp_secret: &[u8; 32],
) -> Result<(), AmmError> {
    // Verify the commitment exists
    let idx = pool
        .positions
        .iter()
        .position(|c| *c == position.position_commitment)
        .ok_or(AmmError::PositionNotFound)?;

    // Verify ownership
    let expected_lp_hash = sha256(&[b"lp-owner-v1", lp_secret.as_slice()]);
    if expected_lp_hash != position.lp_hash {
        return Err(AmmError::OwnershipMismatch);
    }

    // Remove from pool: XOR the commitment back out (XOR is its own inverse)
    pool.xor_accumulator = xor32(&pool.xor_accumulator, &position.position_commitment);
    pool.pool_root = recompute_root(&pool.xor_accumulator);
    pool.positions.swap_remove(idx);
    pool.position_count -= 1;

    Ok(())
}

/// Execute a swap against the pool and return an opaque proof.
///
/// Uses a 1:1 prototype rate (amount_out == amount_in).
///
/// Errors:
/// - `ZeroAmount` — amount_in is zero
pub fn execute_swap(
    pool: &mut AmmPool,
    amount_in: u64,
    direction: SwapDirection,
) -> Result<SwapProof, AmmError> {
    if amount_in == 0 {
        return Err(AmmError::ZeroAmount);
    }

    // Prototype: 1:1 rate
    let amount_out: u64 = amount_in;
    let direction_byte = [direction.clone() as u8];

    let swap_hash = sha256(&[
        b"swap-v1",
        pool.pool_root.as_slice(),
        &amount_in.to_le_bytes(),
        &amount_out.to_le_bytes(),
        &direction_byte,
    ]);

    pool.swap_count += 1;

    Ok(SwapProof {
        swap_hash,
        direction,
        mainnet_ready: false,
    })
}

/// Serialize the pool's public record as JSON.
///
/// Individual position commitments are NOT included — only aggregate state.
pub fn pool_public_record(pool: &AmmPool) -> String {
    let root_hex: String = pool
        .pool_root
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    serde_json::json!({
        "pool_root": root_hex,
        "position_count": pool.position_count,
        "swap_count": pool.swap_count,
        "mainnet_ready": pool.mainnet_ready,
    })
    .to_string()
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_secret(byte: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[0] = byte;
        s
    }

    fn make_nonce(byte: u8) -> [u8; 32] {
        let mut n = [0u8; 32];
        n[0] = byte;
        n
    }

    // 1. Full roundtrip: create → add → remove, pool returns to initial root
    #[test]
    fn test_create_add_remove_happy_path() {
        let mut pool = new_pool();
        let initial_root = pool.pool_root;

        let secret = make_secret(0xAB);
        let nonce = make_nonce(0x01);
        let pos = create_position(&secret, 1_000_000, 2_000_000, &nonce)
            .expect("create_position should succeed");

        add_liquidity(&mut pool, &pos);
        assert_eq!(pool.position_count, 1);
        assert_ne!(pool.pool_root, initial_root, "root must change after add");

        remove_liquidity(&mut pool, &pos, &secret).expect("remove should succeed");
        assert_eq!(pool.position_count, 0);
        // After XOR-removing the only commitment the accumulator is all-zero again
        assert_eq!(pool.pool_root, initial_root, "root must restore after remove");
    }

    // 2. A different lp_secret cannot remove the position
    #[test]
    fn test_wrong_owner_remove_rejected() {
        let mut pool = new_pool();

        let real_secret = make_secret(0xAB);
        let attacker_secret = make_secret(0xCD);
        let nonce = make_nonce(0x02);

        let pos = create_position(&real_secret, 500_000, 500_000, &nonce)
            .expect("create_position should succeed");

        add_liquidity(&mut pool, &pos);

        let err = remove_liquidity(&mut pool, &pos, &attacker_secret)
            .expect_err("wrong owner must be rejected");
        assert_eq!(err, AmmError::OwnershipMismatch);
    }

    // 3. Removing a commitment that was never added returns PositionNotFound
    #[test]
    fn test_position_not_in_pool_rejected() {
        let mut pool = new_pool();

        let secret = make_secret(0x10);
        let nonce = make_nonce(0x03);
        let pos = create_position(&secret, 100, 200, &nonce)
            .expect("create_position should succeed");

        // Do NOT call add_liquidity
        let err = remove_liquidity(&mut pool, &pos, &secret)
            .expect_err("unregistered position must be rejected");
        assert_eq!(err, AmmError::PositionNotFound);
    }

    // 4. Pool root changes after each add_liquidity call
    #[test]
    fn test_pool_root_changes_on_add() {
        let mut pool = new_pool();

        let s1 = make_secret(0x11);
        let s2 = make_secret(0x22);
        let n1 = make_nonce(0xAA);
        let n2 = make_nonce(0xBB);

        let pos1 = create_position(&s1, 1, 1, &n1).unwrap();
        let pos2 = create_position(&s2, 2, 2, &n2).unwrap();

        let root0 = pool.pool_root;

        add_liquidity(&mut pool, &pos1);
        let root1 = pool.pool_root;
        assert_ne!(root0, root1, "root must change after first add");

        add_liquidity(&mut pool, &pos2);
        let root2 = pool.pool_root;
        assert_ne!(root1, root2, "root must change after second add");
        assert_ne!(root0, root2, "root must differ from initial after two adds");
    }

    // 5. execute_swap increments swap_count and returns a non-zero swap_hash
    #[test]
    fn test_execute_swap_produces_proof() {
        let mut pool = new_pool();

        // Add a position so the pool has some state
        let secret = make_secret(0x55);
        let nonce = make_nonce(0x05);
        let pos = create_position(&secret, 1_000, 1_000, &nonce).unwrap();
        add_liquidity(&mut pool, &pos);

        assert_eq!(pool.swap_count, 0);

        let proof = execute_swap(&mut pool, 500, SwapDirection::AToB)
            .expect("swap should succeed");

        assert_eq!(pool.swap_count, 1);
        assert_eq!(proof.direction, SwapDirection::AToB);
        assert!(!proof.mainnet_ready);
        assert_ne!(proof.swap_hash, [0u8; 32], "swap_hash must not be zero");
    }

    // 6. pool_public_record does not expose individual position commitment hex
    #[test]
    fn test_public_record_hides_positions() {
        let mut pool = new_pool();

        let secret = make_secret(0x77);
        let nonce = make_nonce(0x06);
        let pos = create_position(&secret, 9_999, 1_111, &nonce).unwrap();
        add_liquidity(&mut pool, &pos);

        let record = pool_public_record(&pool);

        // The record must contain pool-level fields
        assert!(record.contains("pool_root"), "record must have pool_root");
        assert!(record.contains("position_count"), "record must have position_count");
        assert!(record.contains("swap_count"), "record must have swap_count");
        assert!(record.contains("mainnet_ready"), "record must have mainnet_ready");

        // The individual position commitment must NOT appear in the output
        let pos_hex: String = pos
            .position_commitment
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert!(
            !record.contains(&pos_hex),
            "pool_public_record must not expose individual position commitment: {}",
            pos_hex
        );
    }
}
