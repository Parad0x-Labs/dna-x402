//! Draw randomness from the SlotHashes sysvar.
//!
//! A draw uses the hash of a slot fixed in advance:
//!
//! ```text
//! T_i = T_0 + i * FALLBACK_STEP_SLOTS     (i = 0, 1, 2, ...)
//! ```
//!
//! SlotHashes holds `(slot, bank hash)` for the most recent 512 produced slots,
//! newest to oldest; skipped slots have no entry. Attempt `i` is usable while the
//! window still reaches back to `T_i` (`oldest_slot <= T_i`): then the earliest
//! produced slot `>= T_i` is known exactly. The caller takes no randomness
//! input and no attempt choice; the lowest usable attempt is used:
//!
//! ```text
//! i    = 0                                         if oldest <= T_0
//!      = ceil((oldest - T_0) / FALLBACK_STEP_SLOTS) otherwise
//! used = smallest slot in SlotHashes with slot >= T_i   (TooEarly if none)
//! ```
//!
//! So while `T_0` is in the window every crank gets the same hash; once it has
//! aged out the next fixed fallback slot is used, and so on.

/// Slots between the slot that fixes a draw and its initial target slot.
pub const DRAW_DELAY_SLOTS: u64 = 32;
/// Distance between fallback target slots (one SlotHashes window).
pub const FALLBACK_STEP_SLOTS: u64 = 512;
/// SlotHashes capacity.
pub const MAX_SLOT_HASH_ENTRIES: usize = 512;

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

/// Initial target slot for a draw fixed at `slot`.
pub fn first_target(slot: u64) -> Option<u64> {
    slot.checked_add(DRAW_DELAY_SLOTS)
}

/// Pick the slot hash for a draw whose initial target is `t0`, from raw
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
    let attempt = if oldest <= t0 { 0 } else { (oldest - t0).div_ceil(FALLBACK_STEP_SLOTS) };
    let target = attempt
        .checked_mul(FALLBACK_STEP_SLOTS)
        .and_then(|x| x.checked_add(t0))
        .ok_or(SelectError::Overflow)?;
    if newest < target {
        return Err(SelectError::TooEarly);
    }
    // Entries are newest to oldest: find the last index whose slot is >= target.
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
        assert_eq!(select(&window(600, 1_031, &[]), 1_032), Err(SelectError::TooEarly));
    }

    #[test]
    fn exact_target_used_when_covered() {
        let t0 = 1_032;
        let s = select(&window(600, 1_100, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.target_slot, s.used_slot, s.hash), (0, t0, t0, h(t0)));
        let s = select(&window(1_032, 1_543, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.used_slot), (0, t0));
    }

    #[test]
    fn skipped_target_uses_next_produced_slot() {
        let s = select(&window(600, 1_100, &[1_032, 1_033]), 1_032).unwrap();
        assert_eq!((s.attempt, s.target_slot, s.used_slot), (0, 1_032, 1_034));
    }

    #[test]
    fn aged_out_target_moves_to_fallback() {
        let t0 = 1_032;
        assert_eq!(select(&window(1_033, 1_543, &[]), t0), Err(SelectError::TooEarly));
        let s = select(&window(1_100, 1_611, &[]), t0).unwrap();
        assert_eq!((s.attempt, s.target_slot, s.used_slot), (1, 1_544, 1_544));
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
}
