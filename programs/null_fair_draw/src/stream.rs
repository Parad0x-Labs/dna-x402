//! Randomness stream, bias-bounded reduction and drawing without replacement.
//!
//! ```text
//! seed_r  = SHA-256("null-fair-draw:seed:v1" || draw[32] || round[1] || target_slot_le[8]
//!                   || used_slot_le[8] || slot_hash[32] || root[32] || total_le[8] || count_le[8])
//! B(j, b) = SHA-256("null-fair-draw:stream:v1" || seed_r || j_le[8] || b[1])      b in {0, 1}
//! X_j     = B(j, 0) || B(j, 1)          read as a 512-bit big-endian integer
//! u_j     = X_j mod m                   m = remaining weight (total - weight already won)
//! ```
//!
//! **Bias bound.** If `X` is uniform on `[0, 2^512)` and `1 <= m < 2^64`, each
//! residue has `floor(2^512 / m)` or `floor(2^512 / m) + 1` preimages, so
//! `|P(u = x) - 1/m| <= 2^-512` for every `x` and the statistical distance of
//! `u` from uniform on `[0, m)` is at most `m / 2^513 < 2^-449` (below the
//! `2^-128` target by more than 2^320). See MATH.md.
//!
//! **Without replacement.** Slot `j` draws `u_j` uniformly from the weight not
//! yet won and maps it onto `[0, total)` by skipping every won interval, in
//! ascending order of start:
//!
//! ```text
//! p = u_j
//! for (start, weight) in won intervals sorted by start:
//!     if start <= p { p += weight } else { break }
//! ```
//!
//! The map is the increasing bijection from `[0, m)` onto the points of
//! `[0, total)` outside the won intervals, so `p` is uniform over the
//! remaining points, and the leaf containing `p` is chosen with probability
//! `w_i / m`: exactly the distribution of re-drawing on a collision with a
//! previous winner, with one stream value per slot instead of an unbounded
//! number of retries. With all weights 1 this is uniform sampling without
//! replacement of indices (a partial Fisher-Yates shuffle in distribution).

use solana_program::hash::hashv;

/// Seed domain tag.
pub const SEED_TAG: &[u8] = b"null-fair-draw:seed:v1";
/// Stream domain tag.
pub const STREAM_TAG: &[u8] = b"null-fair-draw:stream:v1";

/// Per-round seed (see module docs).
#[allow(clippy::too_many_arguments)]
pub fn seed(
    draw: &[u8; 32],
    round: u8,
    target_slot: u64,
    used_slot: u64,
    slot_hash: &[u8; 32],
    root: &[u8; 32],
    total: u64,
    count: u64,
) -> [u8; 32] {
    hashv(&[
        SEED_TAG,
        draw,
        &[round],
        &target_slot.to_le_bytes(),
        &used_slot.to_le_bytes(),
        slot_hash,
        root,
        &total.to_le_bytes(),
        &count.to_le_bytes(),
    ])
    .to_bytes()
}

/// The 64 stream bytes of slot `j`.
pub fn block(seed: &[u8; 32], j: u64) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&hashv(&[STREAM_TAG, seed, &j.to_le_bytes(), &[0]]).to_bytes());
    out[32..].copy_from_slice(&hashv(&[STREAM_TAG, seed, &j.to_le_bytes(), &[1]]).to_bytes());
    out
}

/// `X mod m` for the 512-bit big-endian integer `X` (`m >= 1`).
pub fn wide_mod(x: &[u8; 64], m: u64) -> u64 {
    let m = m as u128;
    let mut acc: u128 = 0;
    for chunk in x.chunks_exact(8) {
        let mut b = [0u8; 8];
        b.copy_from_slice(chunk);
        acc = ((acc << 64) | u64::from_be_bytes(b) as u128) % m;
    }
    acc as u64
}

/// Uniform point in `[0, m)` for slot `j` (`m >= 1`).
pub fn point(seed: &[u8; 32], j: u64, m: u64) -> u64 {
    wide_mod(&block(seed, j), m)
}

/// Map `u` in `[0, total - won)` onto `[0, total)` past the won intervals
/// `(start, weight)`, given in ascending order of start. `None` on overflow.
pub fn remap<I: IntoIterator<Item = (u64, u64)>>(u: u64, won_sorted: I) -> Option<u64> {
    let mut p = u;
    for (start, weight) in won_sorted {
        if start <= p {
            p = p.checked_add(weight)?;
        } else {
            break;
        }
    }
    Some(p)
}

/// Off-chain reference: winners (leaf indices, in slot order) of drawing
/// `slots` slots from leaves with `weights`, continuing after the leaves in
/// `already_won` (slot order), with the given per-slot seed. Returns `None`
/// for a slot once the remaining weight is zero (a void slot). `first_slot`
/// is the global index of the slot this call starts at.
pub fn reference_draw(
    weights: &[u64],
    already_won: &[usize],
    seed: &[u8; 32],
    first_slot: u64,
    slots: usize,
) -> Vec<Option<usize>> {
    let mut starts = Vec::with_capacity(weights.len());
    let mut acc = 0u64;
    for w in weights {
        starts.push(acc);
        acc += w;
    }
    let total = acc;
    let mut won: Vec<(u64, u64)> = already_won.iter().map(|&i| (starts[i], weights[i])).collect();
    won.sort_unstable();
    let mut won_weight: u64 = won.iter().map(|x| x.1).sum();
    let mut out = Vec::with_capacity(slots);
    for s in 0..slots {
        let m = total - won_weight;
        if m == 0 {
            out.push(None);
            continue;
        }
        let u = point(seed, first_slot + s as u64, m);
        let p = remap(u, won.iter().copied()).unwrap();
        // Leaf containing p: last start <= p with non-zero weight.
        let i = match starts.binary_search(&p) {
            Ok(mut i) => {
                while weights[i] == 0 {
                    i += 1;
                }
                i
            }
            Err(i) => i - 1,
        };
        debug_assert!(starts[i] <= p && p < starts[i] + weights[i]);
        let pos = won.partition_point(|x| x.0 < starts[i]);
        won.insert(pos, (starts[i], weights[i]));
        won_weight += weights[i];
        out.push(Some(i));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_mod_matches_schoolbook() {
        // X = 2^448 * 1 + 5 (limb 0 = 1, limb 7 = 5): X mod m via u128 steps.
        let mut x = [0u8; 64];
        x[7] = 1;
        x[63] = 5;
        for m in [1u64, 2, 3, 7, 1_000_003, u64::MAX] {
            // 2^448 mod m by repeated squaring of 2^64.
            let mut r: u128 = 1 % m as u128;
            for _ in 0..7 {
                r = (r << 64) % m as u128;
            }
            let expect = ((r + 5) % m as u128) as u64;
            assert_eq!(wide_mod(&x, m), expect, "m = {m}");
        }
        assert_eq!(wide_mod(&[0xff; 64], 1), 0);
    }

    #[test]
    fn remap_skips_won_intervals() {
        // Won [2, 5) and [7, 8) of [0, 10): remaining points 0,1,5,6,8,9.
        let won = [(2u64, 3u64), (7, 1)];
        let got: Vec<u64> = (0..6).map(|u| remap(u, won).unwrap()).collect();
        assert_eq!(got, vec![0, 1, 5, 6, 8, 9]);
    }

    #[test]
    fn reference_draw_never_repeats_and_voids_when_exhausted() {
        let weights = [5u64, 1, 0, 3, 1];
        let seed = [9u8; 32];
        let w = reference_draw(&weights, &[], &seed, 0, 6);
        let got: Vec<usize> = w.iter().flatten().copied().collect();
        assert_eq!(got.len(), 4, "four non-zero leaves");
        let mut s = got.clone();
        s.sort();
        assert_eq!(s, vec![0, 1, 3, 4]);
        assert_eq!(&w[4..], &[None, None]);
        // Continuing after some winners matches drawing them all at once.
        let head = reference_draw(&weights, &[], &seed, 0, 2);
        let won: Vec<usize> = head.iter().flatten().copied().collect();
        let rest = reference_draw(&weights, &won, &seed, 2, 4);
        assert_eq!([head, rest].concat(), w);
    }
}
