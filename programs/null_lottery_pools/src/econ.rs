//! Pool economics: creator fee curve, per-ticket split, jackpot cap.
//!
//! All amounts are lamports (u64); intermediate products use u128.
//!
//! # Creator fee curve
//!
//! `V` is the pool's cumulative ticket sales before a ticket, `S` the seed.
//!
//! ```text
//! Vr   = ceil(S * 10_000 / f_max_bps)                      (recoup volume)
//! f(V) = f_max_bps                                         if V <  Vr
//!      = max(f_min_bps, floor(f_max_bps * Vr / V))         if V >= Vr
//! ```
//!
//! `Vr` is the smallest cumulative volume whose fee at `f_max` reaches `S`
//! (`floor(Vr * f_max / 10_000) >= S`). After recoup the rate decays as
//! `S / V` towards the floor `f_min`.
//!
//! A ticket covers the volume interval `[V, V + p)`. The part below `Vr` is
//! charged at `f_max`; the part at or above `Vr` is charged at the rate
//! `f(max(V, Vr))`, the rate at the start of that part. One ticket can therefore
//! cross the recoup boundary and is charged piecewise:
//!
//! ```text
//! seg1 = min(V + p, Vr) - V            (0 if V >= Vr)
//! seg2 = V + p - max(V, Vr)            (0 if V + p <= Vr)
//! fee  = floor((seg1 * f_max_bps + seg2 * f(max(V, Vr))) / 10_000)
//! ```
//!
//! # Rounding direction
//!
//! Every rounding goes against the creator and the reserve and in favour of
//! the jackpot: the post-recoup rate is floored to whole basis points, the fee
//! and the reserve share are floored to whole lamports, and the jackpot gets the
//! exact remainder `p - fee - reserve`. Creator + reserve + jackpot equals the
//! ticket price to the lamport.
//!
//! # Jackpot cap
//!
//! `cap = floor(cap_bps * p * C / 10_000)` with `C = binom(n, k)`. A ticket's
//! jackpot share above the cap goes to the reserve. See [`DEFAULT_CAP_BPS`] for
//! why buying every combination never pays.
//!
//! # Second prize tier (optional, `tier2_bps > 0`)
//!
//! `tier2 = floor(p * tier2_bps / 10_000)` of each sale goes to a separate
//! tier-2 pool, taken from what would otherwise be the jackpot share:
//! `jackpot = p - creator - reserve - tier2`. A ticket that matches exactly
//! `k - 1` drawn numbers wins an equal share of the tier-2 pool locked at the
//! draw; with no registered tier-2 winner the pool rolls over. The tier-2 pool
//! is capped at `tier2_cap = floor(tier2_bps * p * C / 10_000)`; overflow goes
//! to the reserve. CreatePool requires `cap_bps + fee_max_bps + tier2_bps <=
//! 10_000`, so buying every combination still cannot return more than it
//! costs (jackpot cap + whole tier-2 pool + creator fee <= p * C). Tier 2 pays
//! only from its own pool: never from the jackpot, the reserve or a locked
//! prize.

/// Basis-point denominator.
pub const BPS: u64 = 10_000;
/// Upper bound of `f_max_bps` (30%).
pub const MAX_FEE_BPS: u16 = 3_000;
/// Upper bound of `reserve_bps` (20%).
pub const MAX_RESERVE_BPS: u16 = 2_000;
/// Lower bound of `cap_bps`. The upper bound is `10_000 - f_max_bps`.
pub const MIN_CAP_BPS: u16 = 1_000;
/// Default jackpot cap in basis points of the cost of all combinations.
///
/// Buying all `C` combinations costs `p * C` and wins at most the capped
/// jackpot. The creator also gets its fee back, at most `f_max * p * C`. The
/// buyer's net is therefore at most `cap + f_max * p * C - p * C`, which is
/// `<= 0` whenever `cap_bps + f_max_bps <= 10_000`. With the program bound
/// `f_max <= 3_000` bps, a cap of 7_000 bps keeps the full-coverage purchase
/// non-positive even for the creator charging the maximum fee, before
/// transaction fees and before any split with other winners. CreatePool
/// enforces `cap_bps + f_max_bps <= 10_000` for any cap the creator picks.
pub const DEFAULT_CAP_BPS: u16 = 7_000;

/// Pick count bounds (`k` numbers per ticket).
pub const MIN_PICK: u8 = 1;
pub const MAX_PICK: u8 = 8;
/// Number range upper bound (`n`, numbers are 1..=n). `k < n` is required.
pub const MAX_RANGE: u8 = 80;
/// Ticket price bounds in lamports.
pub const MIN_TICKET_PRICE: u64 = 10_000;
pub const MAX_TICKET_PRICE: u64 = 1_000_000_000_000; // 1_000 SOL
/// Sales length and claim window bounds in slots (about 1 minute to 7 days).
pub const MIN_ROUND_SLOTS: u64 = 150;
pub const MAX_ROUND_SLOTS: u64 = 1_512_000;
pub const MIN_CLAIM_WINDOW_SLOTS: u64 = 150;
pub const MAX_CLAIM_WINDOW_SLOTS: u64 = 1_512_000;
/// Upper bound of `tier2_bps` (20%).
pub const MAX_TIER2_BPS: u16 = 2_000;

/// Creator-chosen pool parameters (fixed at creation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolParams {
    pub seed: u64,
    pub ticket_price: u64,
    pub fee_max_bps: u16,
    pub fee_min_bps: u16,
    pub reserve_bps: u16,
    pub cap_bps: u16,
    pub pick_k: u8,
    pub range_n: u8,
    pub round_slots: u64,
    pub claim_window_slots: u64,
    /// Share of each sale to the tier-2 pool (0 = no second tier).
    pub tier2_bps: u16,
}

/// Values derived from [`PoolParams`] at creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Derived {
    pub combos: u64,
    pub cap: u64,
    pub recoup_volume: u64,
    /// Tier-2 pool cap (0 when tier 2 is off).
    pub tier2_cap: u64,
}

/// One ticket's split. `creator + reserve + tier2 + jackpot == ticket price`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    pub creator: u64,
    pub reserve: u64,
    pub tier2: u64,
    pub jackpot: u64,
}

/// `binom(n, k)`, exact; `None` on overflow.
pub fn binom(n: u8, k: u8) -> Option<u64> {
    if k > n {
        return Some(0);
    }
    let mut r: u128 = 1;
    for i in 0..k as u128 {
        // r * (n - i) / (i + 1) is an integer at every step.
        r = r.checked_mul(n as u128 - i)? / (i + 1);
    }
    u64::try_from(r).ok()
}

/// `ceil(seed * 10_000 / f_max_bps)`; `u64::MAX` when `f_max_bps == 0`
/// (a zero-fee pool never recoups and never charges).
pub fn recoup_volume(seed: u64, fee_max_bps: u16) -> Option<u64> {
    if fee_max_bps == 0 {
        return Some(u64::MAX);
    }
    let num = (seed as u128).checked_mul(BPS as u128)?;
    let d = fee_max_bps as u128;
    u64::try_from(num.div_ceil(d)).ok()
}

/// `floor(cap_bps * price * combos / 10_000)`; `None` if it does not fit u64.
pub fn jackpot_cap(cap_bps: u16, price: u64, combos: u64) -> Option<u64> {
    let v = (cap_bps as u128)
        .checked_mul(price as u128)?
        .checked_mul(combos as u128)?
        / BPS as u128;
    u64::try_from(v).ok()
}

/// Creator fee rate in bps at cumulative volume `v >= recoup_volume`.
pub fn fee_rate_after(recoup_volume: u64, fee_max_bps: u16, fee_min_bps: u16, v: u64) -> u16 {
    if v == 0 {
        return fee_max_bps;
    }
    let r = (fee_max_bps as u128) * (recoup_volume as u128) / (v as u128);
    let r = r.min(fee_max_bps as u128) as u16;
    r.max(fee_min_bps)
}

/// Creator fee rate in bps at cumulative volume `v` (the marginal rate).
pub fn fee_rate(recoup_volume: u64, fee_max_bps: u16, fee_min_bps: u16, v: u64) -> u16 {
    if v < recoup_volume {
        fee_max_bps
    } else {
        fee_rate_after(recoup_volume, fee_max_bps, fee_min_bps, v)
    }
}

/// Creator fee of a sale of `amount` lamports starting at cumulative volume
/// `v_before` (piecewise across the recoup boundary, floored).
pub fn creator_fee(
    v_before: u64,
    amount: u64,
    recoup_volume: u64,
    fee_max_bps: u16,
    fee_min_bps: u16,
) -> Option<u64> {
    let v_after = v_before.checked_add(amount)?;
    let seg1 = if v_before < recoup_volume { v_after.min(recoup_volume) - v_before } else { 0 };
    let start2 = v_before.max(recoup_volume);
    let seg2 = v_after.saturating_sub(start2);
    let rate2 = if seg2 > 0 {
        fee_rate_after(recoup_volume, fee_max_bps, fee_min_bps, start2)
    } else {
        0
    };
    let num = (seg1 as u128)
        .checked_mul(fee_max_bps as u128)?
        .checked_add((seg2 as u128).checked_mul(rate2 as u128)?)?;
    u64::try_from(num / BPS as u128).ok()
}

/// Split of one ticket sold at cumulative volume `v_before`. A retired pool
/// charges no creator fee (that share goes to the jackpot).
pub fn split_ticket(
    params: &PoolParams,
    recoup_volume: u64,
    v_before: u64,
    retired: bool,
) -> Option<Split> {
    let p = params.ticket_price;
    let creator = if retired {
        0
    } else {
        creator_fee(v_before, p, recoup_volume, params.fee_max_bps, params.fee_min_bps)?
    };
    let reserve = u64::try_from((p as u128) * (params.reserve_bps as u128) / BPS as u128).ok()?;
    let tier2 = u64::try_from((p as u128) * (params.tier2_bps as u128) / BPS as u128).ok()?;
    let jackpot = p.checked_sub(creator)?.checked_sub(reserve)?.checked_sub(tier2)?;
    Some(Split { creator, reserve, tier2, jackpot })
}

/// Add `amount` to a jackpot of `jackpot` under `cap`.
/// Returns `(to_jackpot, overflow_to_reserve)`; the two sum to `amount`.
pub fn apply_cap(jackpot: u64, amount: u64, cap: u64) -> (u64, u64) {
    let room = cap.saturating_sub(jackpot);
    let to_j = amount.min(room);
    (to_j, amount - to_j)
}

/// Validate creation parameters and derive the pool constants.
pub fn validate_params(p: &PoolParams) -> Option<Derived> {
    if p.fee_max_bps > MAX_FEE_BPS
        || p.fee_min_bps > p.fee_max_bps
        || p.reserve_bps > MAX_RESERVE_BPS
        || p.cap_bps < MIN_CAP_BPS
        || (p.cap_bps as u64) + (p.fee_max_bps as u64) > BPS
        || p.pick_k < MIN_PICK
        || p.pick_k > MAX_PICK
        || p.range_n > MAX_RANGE
        || p.pick_k >= p.range_n
        || p.ticket_price < MIN_TICKET_PRICE
        || p.ticket_price > MAX_TICKET_PRICE
        || p.round_slots < MIN_ROUND_SLOTS
        || p.round_slots > MAX_ROUND_SLOTS
        || p.claim_window_slots < MIN_CLAIM_WINDOW_SLOTS
        || p.claim_window_slots > MAX_CLAIM_WINDOW_SLOTS
        || p.tier2_bps > MAX_TIER2_BPS
        || (p.tier2_bps > 0 && p.pick_k < 2)
        || (p.cap_bps as u64) + (p.fee_max_bps as u64) + (p.tier2_bps as u64) > BPS
    {
        return None;
    }
    let combos = binom(p.range_n, p.pick_k)?;
    let cap = jackpot_cap(p.cap_bps, p.ticket_price, combos)?;
    // The seed must be a real jackpot that fits under the cap.
    if p.seed < p.ticket_price || p.seed > cap {
        return None;
    }
    let recoup_volume = recoup_volume(p.seed, p.fee_max_bps)?;
    let tier2_cap = jackpot_cap(p.tier2_bps, p.ticket_price, combos)?;
    Some(Derived { combos, cap, recoup_volume, tier2_cap })
}

/// Number of values two ticket number sets have in common (both are `k`
/// strictly ascending values, zero padded; zeros are never counted).
pub fn matches(a: &[u8; 8], b: &[u8; 8]) -> u8 {
    let mut n = 0u8;
    for &x in a.iter().filter(|x| **x != 0) {
        if b.iter().any(|y| *y == x) {
            n += 1;
        }
    }
    n
}

/// Which prize tier a ticket wins: 1 (all `k` numbers), 2 (exactly `k - 1`,
/// only when the pool has a second tier), or 0.
pub fn prize_tier(ticket: &[u8; 8], drawn: &[u8; 8], k: u8, tier2_on: bool) -> u8 {
    let m = matches(ticket, drawn);
    if m == k {
        1
    } else if tier2_on && k >= 2 && m == k - 1 {
        2
    } else {
        0
    }
}

/// Ticket numbers: `k` strictly ascending values in `1..=n`, then zeros.
pub fn valid_numbers(numbers: &[u8; 8], k: u8, n: u8) -> bool {
    let k = k as usize;
    let mut prev = 0u8;
    for (i, &x) in numbers.iter().enumerate() {
        if i < k {
            if x <= prev || x > n {
                return false;
            }
            prev = x;
        } else if x != 0 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;

    fn example() -> PoolParams {
        PoolParams {
            seed: SOL,
            ticket_price: SOL / 100,
            fee_max_bps: 2_500,
            fee_min_bps: 200,
            reserve_bps: 500,
            cap_bps: DEFAULT_CAP_BPS,
            pick_k: 5,
            range_n: 36,
            round_slots: 9_000,
            claim_window_slots: 9_000,
            tier2_bps: 0,
        }
    }

    /// Small-pool preset with the second tier (see the README).
    fn small() -> PoolParams {
        PoolParams {
            seed: SOL / 2,
            ticket_price: SOL / 100,
            fee_max_bps: 3_000,
            fee_min_bps: 1_000,
            reserve_bps: 500,
            cap_bps: 6_000,
            pick_k: 3,
            range_n: 18,
            round_slots: 9_000,
            claim_window_slots: 9_000,
            tier2_bps: 1_000,
        }
    }

    #[test]
    fn binom_values() {
        assert_eq!(binom(36, 5), Some(376_992));
        assert_eq!(binom(2, 1), Some(2));
        assert_eq!(binom(80, 8), Some(28_987_537_150));
        assert_eq!(binom(10, 0), Some(1));
    }

    #[test]
    fn recoup_volume_rounds_up() {
        assert_eq!(recoup_volume(SOL, 2_500), Some(4 * SOL));
        // 1 lamport seed at 30%: ceil(10_000 / 3_000) = 4; 4 * 0.3 = 1.2 >= 1.
        assert_eq!(recoup_volume(1, 3_000), Some(4));
        assert_eq!(recoup_volume(7, 3_000), Some(24)); // ceil(70_000 / 3_000)
    }

    #[test]
    fn recoup_volume_is_minimal() {
        for seed in [1u64, 7, 999, 1_000_003, SOL] {
            for f in [1u16, 7, 250, 2_500, 3_000] {
                let vr = recoup_volume(seed, f).unwrap();
                assert!((vr as u128) * (f as u128) / 10_000 >= seed as u128, "reaches seed");
                assert!(((vr - 1) as u128) * (f as u128) < (seed as u128) * 10_000, "minimal");
            }
        }
    }

    #[test]
    fn fee_before_and_after_recoup_and_floor() {
        let p = example();
        let vr = recoup_volume(p.seed, p.fee_max_bps).unwrap();
        // Before recoup: 25%.
        assert_eq!(fee_rate(vr, 2_500, 200, 0), 2_500);
        assert_eq!(fee_rate(vr, 2_500, 200, vr - 1), 2_500);
        // At recoup: still 25%; at 2x: 12.5%; at 8x: 3.125% -> 312 bps (floored).
        assert_eq!(fee_rate(vr, 2_500, 200, vr), 2_500);
        assert_eq!(fee_rate(vr, 2_500, 200, 2 * vr), 1_250);
        assert_eq!(fee_rate(vr, 2_500, 200, 8 * vr), 312);
        // Floor: 100 SOL of sales -> S/V = 1% < 2% floor.
        assert_eq!(fee_rate(vr, 2_500, 200, 100 * SOL), 200);
        // sim.py table: 16 SOL -> 6.25%, 40 SOL -> 2.5%.
        assert_eq!(fee_rate(vr, 2_500, 200, 16 * SOL), 625);
        assert_eq!(fee_rate(vr, 2_500, 200, 40 * SOL), 250);
    }

    #[test]
    fn fee_rounding_is_floor() {
        // 10_001 lamports at 25% = 2_500.25 -> 2_500.
        assert_eq!(creator_fee(0, 10_001, u64::MAX - 1, 2_500, 0), Some(2_500));
        // Post-recoup rate floors to whole bps: vr=4, v=6 -> 2500*4/6 = 1666.66 -> 1666.
        assert_eq!(fee_rate_after(4, 2_500, 0, 6), 1_666);
    }

    #[test]
    fn recoup_boundary_crossed_in_one_ticket() {
        // vr = 4_000_000; a 1_500_000 ticket from 3_000_000 crosses at 4_000_000.
        let vr = recoup_volume(1_000_000, 2_500).unwrap();
        assert_eq!(vr, 4_000_000);
        // seg1 = 1_000_000 @ 25%, seg2 = 500_000 @ f(4_000_000) = 25%.
        assert_eq!(creator_fee(3_000_000, 1_500_000, vr, 2_500, 200), Some(375_000));
        // Next ticket starts at 4_500_000: rate floor(2500*4/4.5) = 2222 bps.
        assert_eq!(fee_rate(vr, 2_500, 200, 4_500_000), 2_222);
        assert_eq!(creator_fee(4_500_000, 1_500_000, vr, 2_500, 200), Some(333_300));
        // Cumulative creator fees at exactly Vr equal the seed.
        let mut v = 0;
        let mut total = 0;
        while v < vr {
            let step = (vr - v).min(1_500_000);
            total += creator_fee(v, step, vr, 2_500, 200).unwrap();
            v += step;
        }
        assert_eq!(total, 1_000_000);
    }

    #[test]
    fn split_conserves_to_the_lamport() {
        let p = example();
        let d = validate_params(&p).unwrap();
        let mut v = 0u64;
        for _ in 0..10_000 {
            let s = split_ticket(&p, d.recoup_volume, v, false).unwrap();
            assert_eq!(s.creator + s.reserve + s.tier2 + s.jackpot, p.ticket_price);
            assert_eq!(s.tier2, 0);
            v += p.ticket_price;
        }
        // Odd price: rounding remainder lands in the jackpot.
        let mut q = p;
        q.ticket_price = 10_007;
        let s = split_ticket(&q, d.recoup_volume, 0, false).unwrap();
        assert_eq!(s.creator, 2_501); // floor(10_007 * 0.25)
        assert_eq!(s.reserve, 500); // floor(10_007 * 0.05)
        assert_eq!(s.jackpot, 10_007 - 2_501 - 500);
        let r = split_ticket(&q, d.recoup_volume, 0, true).unwrap();
        assert_eq!(r.creator, 0);
        assert_eq!(r.creator + r.reserve + r.jackpot, 10_007);
    }

    #[test]
    fn tier2_split_conserves_and_rounds_towards_the_jackpot() {
        let p = small();
        let d = validate_params(&p).unwrap();
        let mut v = 0u64;
        for _ in 0..2_000 {
            let s = split_ticket(&p, d.recoup_volume, v, false).unwrap();
            assert_eq!(s.creator + s.reserve + s.tier2 + s.jackpot, p.ticket_price);
            assert_eq!(s.tier2, SOL / 1_000);
            v += p.ticket_price;
        }
        let mut q = p;
        q.ticket_price = 10_007;
        let s = split_ticket(&q, d.recoup_volume, 0, false).unwrap();
        // floor(10_007 * 0.30) = 3_002, floor(10_007 * 0.05) = 500, floor(10_007 * 0.10) = 1_000.
        assert_eq!((s.creator, s.reserve, s.tier2), (3_002, 500, 1_000));
        assert_eq!(s.jackpot, 10_007 - 3_002 - 500 - 1_000);
    }

    #[test]
    fn tier2_bounds_keep_full_coverage_non_positive() {
        let p = small();
        let d = validate_params(&p).unwrap();
        assert_eq!(d.combos, 816);
        assert_eq!(d.cap, 4_896_000_000); // 0.6 * 0.01 * 816 SOL
        assert_eq!(d.tier2_cap, 816_000_000); // 0.1 * 0.01 * 816 SOL
        // Full coverage: jackpot cap + whole tier-2 pool + max creator fee <= p * C.
        let fee_all = (p.fee_max_bps as u64) * p.ticket_price * d.combos / BPS;
        assert!(d.cap + d.tier2_cap + fee_all <= p.ticket_price * d.combos);
        let bad = |f: fn(&mut PoolParams)| {
            let mut q = small();
            f(&mut q);
            validate_params(&q).is_none()
        };
        assert!(bad(|q| q.cap_bps = 6_001)); // 6_001 + 3_000 + 1_000 > 10_000
        assert!(bad(|q| q.tier2_bps = 2_001));
        assert!(bad(|q| { q.pick_k = 1; q.range_n = 18; q.seed = q.ticket_price })); // tier 2 needs k >= 2
        // Tier 2 off keeps the old bound.
        let mut q = small();
        q.tier2_bps = 0;
        q.cap_bps = 7_000;
        assert_eq!(validate_params(&q).unwrap().tier2_cap, 0);
    }

    /// Pool state after `tickets` sales with no draw: (creator fees, jackpot, reserve, tier-2 pool).
    fn run(p: &PoolParams, tickets: u64) -> (u64, u64, u64, u64) {
        let d = validate_params(p).unwrap();
        let (mut v, mut c, mut j, mut r, mut t2) = (0u64, 0u64, p.seed, 0u64, 0u64);
        for _ in 0..tickets {
            let s = split_ticket(p, d.recoup_volume, v, false).unwrap();
            c += s.creator;
            r += s.reserve;
            let (a, o) = apply_cap(j, s.jackpot, d.cap);
            j += a;
            r += o;
            let (a, o) = apply_cap(t2, s.tier2, d.tier2_cap);
            t2 += a;
            r += o;
            v += p.ticket_price;
        }
        (c, j, r, t2)
    }

    #[test]
    fn small_preset_numbers() {
        // README small preset: seed 0.5 SOL, ticket 0.01 SOL, fee 30% -> 10%,
        // reserve 5%, 3 of 18. Recoup volume 1.6667 SOL (ticket 167).
        let p = small();
        let d = validate_params(&p).unwrap();
        assert_eq!(d.recoup_volume, 1_666_666_667);
        assert!(run(&p, 166).0 < p.seed && run(&p, 167).0 >= p.seed);
        // 2 SOL and 5 SOL of sales (200 and 500 tickets).
        assert_eq!(run(&p, 200), (591_394_000, 1_608_606_000, 100_000_000, 200_000_000));
        assert_eq!(run(&p, 500), (1_050_150_000, 3_699_850_000, 250_000_000, 500_000_000));
        // Without tier 2 (cap 7000): same creator fees, jackpot 4.19985 SOL at 5 SOL.
        let mut q = p;
        q.tier2_bps = 0;
        q.cap_bps = 7_000;
        assert_eq!(validate_params(&q).unwrap().cap, 5_712_000_000);
        assert_eq!(run(&q, 500), (1_050_150_000, 4_199_850_000, 250_000_000, 0));
        // Fee at 5 SOL of sales reached the 10% floor.
        assert_eq!(fee_rate(d.recoup_volume, 3_000, 1_000, 5 * SOL), 1_000);
    }

    #[test]
    fn prize_tiers() {
        let drawn = [3, 9, 17, 0, 0, 0, 0, 0];
        assert_eq!(prize_tier(&[3, 9, 17, 0, 0, 0, 0, 0], &drawn, 3, true), 1);
        assert_eq!(prize_tier(&[3, 9, 18, 0, 0, 0, 0, 0], &drawn, 3, true), 2);
        assert_eq!(prize_tier(&[1, 9, 17, 0, 0, 0, 0, 0], &drawn, 3, true), 2);
        assert_eq!(prize_tier(&[1, 2, 17, 0, 0, 0, 0, 0], &drawn, 3, true), 0);
        assert_eq!(prize_tier(&[3, 9, 18, 0, 0, 0, 0, 0], &drawn, 3, false), 0);
        assert_eq!(prize_tier(&[3, 9, 17, 0, 0, 0, 0, 0], &drawn, 3, false), 1);
        // Exhaustive count for 3 of 18: 1 jackpot, 45 tier-2 tickets.
        let mut counts = [0u32; 3];
        for a in 1..=18u8 {
            for b in a + 1..=18 {
                for c in b + 1..=18 {
                    counts[prize_tier(&[a, b, c, 0, 0, 0, 0, 0], &drawn, 3, true) as usize] += 1;
                }
            }
        }
        assert_eq!(counts, [770, 1, 45]);
    }

    #[test]
    fn cap_overflow_goes_to_reserve() {
        assert_eq!(apply_cap(90, 20, 100), (10, 10));
        assert_eq!(apply_cap(100, 20, 100), (0, 20));
        assert_eq!(apply_cap(0, 20, 100), (20, 0));
        assert_eq!(apply_cap(150, 20, 100), (0, 20));
    }

    #[test]
    fn params_bounds() {
        let p = example();
        let d = validate_params(&p).unwrap();
        assert_eq!(d.combos, 376_992);
        assert_eq!(d.cap, 7_000 * (SOL / 100) / 10_000 * 376_992);
        let bad = |f: fn(&mut PoolParams)| {
            let mut q = example();
            f(&mut q);
            validate_params(&q).is_none()
        };
        assert!(bad(|q| q.fee_max_bps = 3_001));
        assert!(bad(|q| q.fee_min_bps = 2_501));
        assert!(bad(|q| q.reserve_bps = 2_001));
        assert!(bad(|q| q.cap_bps = 7_600)); // 7_600 + 2_500 > 10_000
        assert!(bad(|q| q.cap_bps = 999));
        assert!(bad(|q| q.pick_k = 0));
        assert!(bad(|q| q.pick_k = 9));
        assert!(bad(|q| q.range_n = 81));
        assert!(bad(|q| { q.pick_k = 5; q.range_n = 5 }));
        assert!(bad(|q| q.ticket_price = 9_999));
        assert!(bad(|q| q.seed = q.ticket_price - 1));
        assert!(bad(|q| { q.pick_k = 1; q.range_n = 2 })); // cap 0.014 SOL < seed 1 SOL
        assert!(bad(|q| q.round_slots = 149));
        assert!(bad(|q| q.claim_window_slots = 1_512_001));
        // Max cap at max fee is accepted.
        let mut q = example();
        q.fee_max_bps = 3_000;
        q.cap_bps = 7_000;
        assert!(validate_params(&q).is_some());
    }

    #[test]
    fn numbers_validation() {
        assert!(valid_numbers(&[1, 2, 3, 4, 5, 0, 0, 0], 5, 36));
        assert!(!valid_numbers(&[1, 2, 3, 4, 37, 0, 0, 0], 5, 36));
        assert!(!valid_numbers(&[2, 1, 3, 4, 5, 0, 0, 0], 5, 36));
        assert!(!valid_numbers(&[1, 1, 3, 4, 5, 0, 0, 0], 5, 36));
        assert!(!valid_numbers(&[0, 1, 3, 4, 5, 0, 0, 0], 5, 36));
        assert!(!valid_numbers(&[1, 2, 3, 4, 5, 6, 0, 0], 5, 36));
        assert!(valid_numbers(&[2, 0, 0, 0, 0, 0, 0, 0], 1, 2));
    }
}
