//! Draw randomness from the SlotHashes sysvar.
//!
//! Sales of a round close at `close_slot` (fixed when the round opens). The
//! draw uses the hash of a slot fixed in advance (selection code shared with
//! `null_fair_draw` in the `null-draw-common` crate):
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

pub use null_draw_common::slot_hashes::{
    encode_slot_hashes, first_target, select, SelectError, Selection, DRAW_DELAY_SLOTS,
    FALLBACK_STEP_SLOTS, MAX_SLOT_HASH_ENTRIES,
};

/// Entropy domain tag.
pub const ENTROPY_TAG: &[u8] = b"null-lottery-pools:draw:v1";
/// Per-number domain tag.
pub const NUMBER_TAG: &[u8] = b"null-lottery-pools:number:v1";

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

#[cfg(test)]
mod tests {
    use super::*;

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
