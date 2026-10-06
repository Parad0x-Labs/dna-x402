//! Draw randomness from the SlotHashes sysvar.
//!
//! Sales of a round close at `close_slot` (fixed when the round opens). The
//! draw uses the hash of a slot fixed in advance:
//!
//! ```text
//! T_i = close_slot + DRAW_DELAY_SLOTS + i * FALLBACK_STEP_SLOTS     (i = 0, 1, 2, ...)
//! ```
//!
//! SlotHashes holds `(slot, bank hash)` for the most recent 512 produced slots,
//! newest first; skipped slots have no entry. Attempt `i` is usable while the
//! window still reaches back to `T_i` (`oldest_slot <= T_i`): then the first
//! produced slot `>= T_i` is known exactly. The Draw instruction takes no
//! randomness input and no attempt choice; it uses the lowest usable attempt:
//!
//! ```text
//! i    = 0                                         if oldest <= T_0
//!      = ceil((oldest - T_0) / FALLBACK_STEP_SLOTS) otherwise
//! used = smallest slot in SlotHashes with slot >= T_i   (DrawTooEarly if none)
//! ```
//!
//! So while `T_0` is in the window every crank gets the same hash; once it has
//! aged out the next fixed fallback slot is used, and so on.
//!
//! ```text
//! entropy = SHA-256("null-lottery-pools:draw:v1" || pool[32] || round_id_le[8]
//!                   || T_i_le[8] || used_le[8] || slot_hash[32]
//!                   || tickets_root[32] || ticket_count_le[8])
//! r_j     = u64_le(SHA-256("null-lottery-pools:number:v1" || entropy || [j])[0..8])
//! ```
//!
//! Numbers: a partial Fisher-Yates shuffle of `[1..=n]` with
//! `swap(a[j], a[j + r_j mod (n - j)])` for `j in 0..k`; the drawn numbers are
//! `a[0..k]` sorted ascending and zero padded to 8 bytes. The modulo bias is at
//! most `n / 2^64` per pick (n <= 80).

use solana_program::hash::hashv;

/// Slots between the close slot and the first target slot.
pub const DRAW_DELAY_SLOTS: u64 = 32;
/// Distance between fallback target slots (one SlotHashes window).
pub const FALLBACK_STEP_SLOTS: u64 = 512;
/// SlotHashes capacity.
pub const MAX_SLOT_HASH_ENTRIES: usize = 512;
/// Entropy domain tag.
pub const ENTROPY_TAG: &[u8] = b"null-lottery-pools:draw:v1";
/// Per-number domain tag.
pub const NUMBER_TAG: &[u8] = b"null-lottery-pools:number:v1";

const ENTRY_LEN: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectError {
    /// Malformed SlotHashes data.
    Malformed,
    /// The active target slot has no produced slot at or after it yet.
    TooEarly,
    /// Slot arithmetic overflow.
    Overflow,
}

/// The slot hash a draw uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Selection {
    pub attempt: u64,
    pub target_slot: u64,
    pub used_slot: u64,
    pub hash: [u8; 32],
}

fn read_u64(d: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[off..off + 8]);
    u64::from_le_bytes(b)
}

fn entry_slot(d: &[u8], i: usize) -> u64 {
    read_u64(d, 8 + i * ENTRY_LEN)
}

/// First target slot of a round.
pub fn first_target(close_slot: u64) -> Option<u64> {
    close_slot.checked_add(DRAW_DELAY_SLOTS)
}

/// Pick the slot hash for a round whose first target is `t0`, from raw
/// SlotHashes account data (`u64 len || len x (u64 slot, [u8; 32] hash)`,
/// strictly descending slots).
pub fn select(data: &[u8], t0: u64) -> Result<Selection, SelectError> {
    if data.len() < 8 {
        return Err(SelectError::Malformed);
    }
    let len = read_u64(data, 0) as usize;
    if len == 0 || len > MAX_SLOT_HASH_ENTRIES || data.len() < 8 + len * ENTRY_LEN {
        return Err(SelectError::Malformed);
    }
    let newest = entry_slot(data, 0);
    let oldest = entry_slot(data, len - 1);
    if oldest > newest {
        return Err(SelectError::Malformed);
    }
    let attempt = if oldest <= t0 {
        0
    } else {
        (oldest - t0).div_ceil(FALLBACK_STEP_SLOTS)
    };
    let target = attempt
        .checked_mul(FALLBACK_STEP_SLOTS)
        .and_then(|x| x.checked_add(t0))
        .ok_or(SelectError::Overflow)?;
    if newest < target {
        return Err(SelectError::TooEarly);
    }
    // Entries are newest first: find the last index whose slot is >= target.
    let (mut lo, mut hi) = (0usize, len - 1); // entry_slot(lo) >= target holds
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if entry_slot(data, mid) >= target {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let off = 8 + lo * ENTRY_LEN;
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[off + 8..off + 40]);
    Ok(Selection { attempt, target_slot: target, used_slot: entry_slot(data, lo), hash })
}

/// Draw entropy (see module docs).
pub fn entropy(
    pool: &[u8; 32],
    round_id: u64,
    sel: &Selection,
    tickets_root: &[u8; 32],
    ticket_count: u64,
) -> [u8; 32] {
    hashv(&[
        ENTROPY_TAG,
        pool,
        &round_id.to_le_bytes(),
        &sel.target_slot.to_le_bytes(),
        &sel.used_slot.to_le_bytes(),
        &sel.hash,
        tickets_root,
        &ticket_count.to_le_bytes(),
    ])
    .to_bytes()
}

/// `k` distinct numbers in `1..=n`, ascending, zero padded (requires
/// `1 <= k < n <= 80`, `k <= 8`).
pub fn draw_numbers(entropy: &[u8; 32], k: u8, n: u8) -> [u8; 8] {
    let mut a = [0u8; 80];
    for (i, x) in a.iter_mut().enumerate().take(n as usize) {
        *x = i as u8 + 1;
    }
    for j in 0..k as usize {
        let h = hashv(&[NUMBER_TAG, entropy, &[j as u8]]).to_bytes();
        let mut b = [0u8; 8];
        b.copy_from_slice(&h[..8]);
        let r = u64::from_le_bytes(b);
        let span = (n as usize - j) as u64;
        let pick = j + (r % span) as usize;
        a.swap(j, pick);
    }
    let mut out = [0u8; 8];
    out[..k as usize].copy_from_slice(&a[..k as usize]);
    out[..k as usize].sort_unstable();
    out
}

/// Off-chain helper: SlotHashes account bytes for `entries` (any order).
pub fn encode_slot_hashes(entries: &[(u64, [u8; 32])]) -> Vec<u8> {
    let mut e = entries.to_vec();
    e.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = Vec::with_capacity(8 + e.len() * ENTRY_LEN);
    out.extend_from_slice(&(e.len() as u64).to_le_bytes());
    for (s, h) in e {
        out.extend_from_slice(&s.to_le_bytes());
        out.extend_from_slice(&h);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(x: u64) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[..8].copy_from_slice(&x.to_le_bytes());
        b
    }

    fn window(from: u64, to: u64, skip: &[u64]) -> Vec<u8> {
        let e: Vec<_> = (from..=to).filter(|s| !skip.contains(s)).map(|s| (s, h(s))).collect();
        encode_slot_hashes(&e)
    }

    #[test]
    fn too_early_before_target() {
        let t0 = 1_032;
        assert_eq!(select(&window(600, 1_031, &[]), t0), Err(SelectError::TooEarly));
    }

    #[test]
    fn exact_target_used_when_covered() {
        let t0 = 1_032;
        let s = select(&window(600, 1_100, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.target_slot, s.used_slot, s.hash), (0, t0, t0, h(t0)));
        // T_1 is also in the window later; T_0 still wins while covered.
        let s = select(&window(1_032, 1_543, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.used_slot), (0, t0));
    }

    #[test]
    fn skipped_target_uses_next_produced_slot() {
        let t0 = 1_032;
        let s = select(&window(600, 1_100, &[1_032, 1_033]), t0).unwrap();
        assert_eq!((s.attempt, s.target_slot, s.used_slot), (0, t0, 1_034));
    }

    #[test]
    fn aged_out_target_moves_to_fallback() {
        let t0 = 1_032;
        // Oldest entry 1_033 > T_0: attempt 1, T_1 = 1_544.
        assert_eq!(select(&window(1_033, 1_543, &[]), t0), Err(SelectError::TooEarly));
        let s = select(&window(1_100, 1_611, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.target_slot, s.used_slot), (1, 1_544, 1_544));
        // Far later: attempt 3.
        let s = select(&window(2_100, 2_611, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.target_slot), (3, 1_032 + 3 * 512));
    }

    #[test]
    fn malformed_rejected() {
        assert_eq!(select(&[], 5), Err(SelectError::Malformed));
        assert_eq!(select(&0u64.to_le_bytes(), 5), Err(SelectError::Malformed));
        let mut d = window(1, 10, &[]);
        d.truncate(d.len() - 1);
        assert_eq!(select(&d, 5), Err(SelectError::Malformed));
    }

    #[test]
    fn numbers_are_distinct_sorted_in_range() {
        for seed in 0..500u64 {
            let e = hashv(&[&seed.to_le_bytes()]).to_bytes();
            for (k, n) in [(1u8, 2u8), (5, 36), (6, 49), (8, 80), (7, 8)] {
                let d = draw_numbers(&e, k, n);
                assert!(crate::econ::valid_numbers(&d, k, n), "{:?} k={} n={}", d, k, n);
            }
        }
    }
}
