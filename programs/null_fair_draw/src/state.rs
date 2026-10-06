//! Account layouts (little-endian, fixed offsets).
//!
//! | Account | PDA seeds | Size |
//! |---|---|---|
//! | Draw (also the SOL vault) | `["draw", organizer, draw_id_le]` | [`draw_len`] |
//! | SPL prize vault (token account, authority = draw) | `["vault", draw]` | 165 |
//! | Entrant record (only with a per-wallet cap) | `["entrant", draw, owner]` | [`ENTRANT_LEN`] |
//!
//! The draw account is a fixed header ([`HEADER_LEN`]), then the open-raffle
//! frontier ([`FRONTIER_LEN`] bytes, open raffle only), then `capacity` winner
//! slots ([`SLOT_LEN`] each), then up to `capacity` won intervals
//! `(start u64, weight u64)` sorted by start ([`WON_LEN`] each; the leading
//! `won_count` are used). `capacity = prizes * (1 + redraw_rounds)`.

use crate::sumtree::FRONTIER_LEN;

pub const DRAW_SEED: &[u8] = b"draw";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ENTRANT_SEED: &[u8] = b"entrant";

pub const DRAW_DISC: [u8; 8] = *b"NFDDRAW1";
pub const ENTRANT_DISC: [u8; 8] = *b"NFDENTR1";

pub const MAX_TIERS: usize = 8;
pub const MAX_ROUNDS: usize = 4; // round 0 plus up to 3 re-draw rounds
pub const MAX_REDRAW_ROUNDS: u8 = (MAX_ROUNDS - 1) as u8;
/// Largest number of winner slots (prizes times rounds).
pub const MAX_SLOTS: usize = 1024;

pub const MODE_OPEN: u8 = 0;
pub const MODE_LIST: u8 = 1;

/// Draw statuses.
pub const STATUS_CREATED: u8 = 0;
/// Prizes escrowed. Open raffle: entries open until `close_slot`. List: waiting for CommitList.
pub const STATUS_FUNDED: u8 = 1;
/// Target slot of the current round fixed, waiting for its hash.
pub const STATUS_AWAIT_DRAW: u8 = 2;
/// Seed of the current round fixed: resolving slots, then the claim window.
pub const STATUS_RESOLVING: u8 = 3;
/// Finished: unclaimed and void prizes are refundable to the organizer.
pub const STATUS_COMPLETE: u8 = 4;

/// Winner slot statuses.
pub const SLOT_PENDING: u8 = 0;
pub const SLOT_WON: u8 = 1;
pub const SLOT_CLAIMED: u8 = 2;
pub const SLOT_FORFEITED: u8 = 3;
pub const SLOT_VOID: u8 = 4;

pub const ROUND_INFO_LEN: usize = 8 * 4 + 32 + 32;
pub const HEADER_LEN: usize = 408 + MAX_ROUNDS * ROUND_INFO_LEN;
pub const SLOT_LEN: usize = 8 + 8 + 8 + 32 + 4;
pub const WON_LEN: usize = 16;
pub const ENTRANT_LEN: usize = 8 + 32 + 32 + 8 + 1;
/// Largest allocation one instruction can make for a PDA (CPI limit).
pub const MAX_ALLOC_STEP: usize = 10_240;

/// Size of a draw account.
pub fn draw_len(mode: u8, capacity: usize) -> usize {
    HEADER_LEN + if mode == MODE_OPEN { FRONTIER_LEN } else { 0 } + capacity * (SLOT_LEN + WON_LEN)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Tier {
    pub count: u32,
    pub amount: u64,
}

/// Randomness of one round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RoundInfo {
    /// Initial target slot `T_0` of the round (fixed when the round's entries were fixed).
    pub first_target: u64,
    /// Target slot actually used (`T_0 + attempt * 512`).
    pub target_slot: u64,
    pub used_slot: u64,
    pub attempt: u64,
    pub slot_hash: [u8; 32],
    pub seed: [u8; 32],
}

/// Draw header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Draw {
    pub organizer: [u8; 32],
    pub draw_id: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub mode: u8,
    pub weighted: bool,
    pub status: u8,
    pub round: u8,
    pub redraw_rounds: u8,
    pub tier_count: u8,
    pub depth: u8,
    /// Entries of the sorted won-interval table (resolved, not void slots).
    pub won_count: u16,
    pub prize_mint: [u8; 32],
    pub entry_mint: [u8; 32],
    pub fee_dest: [u8; 32],
    pub entry_price: u64,
    pub wallet_cap: u64,
    pub close_slot: u64,
    pub claim_window_slots: u64,
    pub tiers: [Tier; MAX_TIERS],
    pub total_prize: u64,
    pub funded: u64,
    pub paid: u64,
    pub returned: u64,
    pub refundable: u64,
    pub root: [u8; 32],
    pub total_weight: u64,
    pub leaf_count: u64,
    pub commit_slot: u64,
    pub won_weight: u64,
    pub capacity: u16,
    pub slot_count: u16,
    pub next_slot: u16,
    pub round_first_slot: u16,
    pub window_end: u64,
    pub rounds: [RoundInfo; MAX_ROUNDS],
}

/// One winner slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Slot {
    /// Start of the won interval (the drawn leaf's prefix sum).
    pub start: u64,
    pub weight: u64,
    pub leaf_index: u64,
    /// Winner wallet; zero until known (unweighted slots learn it at Claim).
    pub wallet: [u8; 32],
    pub tier: u8,
    pub status: u8,
    pub round: u8,
}

struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}
impl<'a> Rd<'a> {
    fn arr<const N: usize>(&mut self) -> [u8; N] {
        let mut a = [0u8; N];
        a.copy_from_slice(&self.b[self.o..self.o + N]);
        self.o += N;
        a
    }
    fn u8(&mut self) -> u8 {
        self.arr::<1>()[0]
    }
    fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.arr())
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.arr())
    }
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.arr())
    }
}

struct Wr<'a> {
    b: &'a mut [u8],
    o: usize,
}
impl<'a> Wr<'a> {
    fn put(&mut self, v: &[u8]) {
        self.b[self.o..self.o + v.len()].copy_from_slice(v);
        self.o += v.len();
    }
    fn u8(&mut self, v: u8) {
        self.put(&[v]);
    }
    fn u16(&mut self, v: u16) {
        self.put(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.put(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.put(&v.to_le_bytes());
    }
}

impl Draw {
    /// Byte offset of the frontier (open raffle) or the slot table (list).
    pub fn frontier_offset(&self) -> usize {
        HEADER_LEN
    }

    pub fn slots_offset(&self) -> usize {
        HEADER_LEN + if self.mode == MODE_OPEN { FRONTIER_LEN } else { 0 }
    }

    pub fn sorted_offset(&self) -> usize {
        self.slots_offset() + self.capacity as usize * SLOT_LEN
    }

    pub fn len(&self) -> usize {
        draw_len(self.mode, self.capacity as usize)
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// Prize slots of round 0 (the sum of the tier counts).
    pub fn prize_count(&self) -> u64 {
        self.tiers[..self.tier_count as usize].iter().map(|t| t.count as u64).sum()
    }

    /// Prizes not yet paid or returned.
    pub fn outstanding(&self) -> Option<u64> {
        self.funded.checked_sub(self.paid)?.checked_sub(self.returned)
    }

    pub fn is_sol_prize(&self) -> bool {
        self.prize_mint == [0u8; 32]
    }

    pub fn is_sol_entry(&self) -> bool {
        self.entry_mint == [0u8; 32]
    }

    pub fn unpack(d: &[u8]) -> Option<Self> {
        if d.len() < HEADER_LEN || d[..8] != DRAW_DISC {
            return None;
        }
        let mut r = Rd { b: d, o: 8 };
        let organizer = r.arr();
        let draw_id = r.u64();
        let bump = r.u8();
        let vault_bump = r.u8();
        let mode = r.u8();
        let weighted = r.u8() != 0;
        let status = r.u8();
        let round = r.u8();
        let redraw_rounds = r.u8();
        let tier_count = r.u8();
        let depth = r.u8();
        let won_count = r.u16();
        r.o += 5;
        let prize_mint = r.arr();
        let entry_mint = r.arr();
        let fee_dest = r.arr();
        let entry_price = r.u64();
        let wallet_cap = r.u64();
        let close_slot = r.u64();
        let claim_window_slots = r.u64();
        let mut tiers = [Tier::default(); MAX_TIERS];
        for t in tiers.iter_mut() {
            t.count = r.u32();
            t.amount = r.u64();
        }
        let mut dr = Draw {
            organizer,
            draw_id,
            bump,
            vault_bump,
            mode,
            weighted,
            status,
            round,
            redraw_rounds,
            tier_count,
            depth,
            won_count,
            prize_mint,
            entry_mint,
            fee_dest,
            entry_price,
            wallet_cap,
            close_slot,
            claim_window_slots,
            tiers,
            total_prize: r.u64(),
            funded: r.u64(),
            paid: r.u64(),
            returned: r.u64(),
            refundable: r.u64(),
            root: r.arr(),
            total_weight: r.u64(),
            leaf_count: r.u64(),
            commit_slot: r.u64(),
            won_weight: r.u64(),
            capacity: r.u16(),
            slot_count: r.u16(),
            next_slot: r.u16(),
            round_first_slot: r.u16(),
            window_end: r.u64(),
            rounds: [RoundInfo::default(); MAX_ROUNDS],
        };
        debug_assert_eq!(r.o, 408);
        for ri in dr.rounds.iter_mut() {
            ri.first_target = r.u64();
            ri.target_slot = r.u64();
            ri.used_slot = r.u64();
            ri.attempt = r.u64();
            ri.slot_hash = r.arr();
            ri.seed = r.arr();
        }
        // A draw larger than one 10 KiB allocation is created short and grown
        // with Extend while it is still unfunded (status Created).
        let full = d.len() == dr.len();
        let growing = dr.status == STATUS_CREATED && d.len() < dr.len() && d.len() >= HEADER_LEN;
        if !(full || growing) || dr.mode > MODE_LIST || dr.capacity as usize > MAX_SLOTS {
            return None;
        }
        Some(dr)
    }

    /// Write the header (frontier and slot table are left as they are).
    pub fn pack(&self, d: &mut [u8]) {
        let mut w = Wr { b: &mut d[..HEADER_LEN], o: 0 };
        w.put(&DRAW_DISC);
        w.put(&self.organizer);
        w.u64(self.draw_id);
        w.u8(self.bump);
        w.u8(self.vault_bump);
        w.u8(self.mode);
        w.u8(self.weighted as u8);
        w.u8(self.status);
        w.u8(self.round);
        w.u8(self.redraw_rounds);
        w.u8(self.tier_count);
        w.u8(self.depth);
        w.u16(self.won_count);
        w.put(&[0u8; 5]);
        w.put(&self.prize_mint);
        w.put(&self.entry_mint);
        w.put(&self.fee_dest);
        w.u64(self.entry_price);
        w.u64(self.wallet_cap);
        w.u64(self.close_slot);
        w.u64(self.claim_window_slots);
        for t in &self.tiers {
            w.u32(t.count);
            w.u64(t.amount);
        }
        w.u64(self.total_prize);
        w.u64(self.funded);
        w.u64(self.paid);
        w.u64(self.returned);
        w.u64(self.refundable);
        w.put(&self.root);
        w.u64(self.total_weight);
        w.u64(self.leaf_count);
        w.u64(self.commit_slot);
        w.u64(self.won_weight);
        w.u16(self.capacity);
        w.u16(self.slot_count);
        w.u16(self.next_slot);
        w.u16(self.round_first_slot);
        w.u64(self.window_end);
        debug_assert_eq!(w.o, 408);
        for ri in &self.rounds {
            w.u64(ri.first_target);
            w.u64(ri.target_slot);
            w.u64(ri.used_slot);
            w.u64(ri.attempt);
            w.put(&ri.slot_hash);
            w.put(&ri.seed);
        }
        debug_assert_eq!(w.o, HEADER_LEN);
    }

    pub fn read_slot(&self, d: &[u8], i: usize) -> Slot {
        let o = self.slots_offset() + i * SLOT_LEN;
        Slot::unpack(&d[o..o + SLOT_LEN])
    }

    pub fn write_slot(&self, d: &mut [u8], i: usize, s: &Slot) {
        let o = self.slots_offset() + i * SLOT_LEN;
        s.pack(&mut d[o..o + SLOT_LEN]);
    }

    /// Won interval at sorted position `k` (`k < won_count`).
    pub fn won_at(&self, d: &[u8], k: usize) -> (u64, u64) {
        let o = self.sorted_offset() + WON_LEN * k;
        let mut a = [0u8; 8];
        a.copy_from_slice(&d[o..o + 8]);
        let mut b = [0u8; 8];
        b.copy_from_slice(&d[o + 8..o + 16]);
        (u64::from_le_bytes(a), u64::from_le_bytes(b))
    }

    /// Insert the won interval `(start, weight)` keeping ascending order of
    /// start (intervals of distinct leaves are disjoint, so starts differ).
    pub fn won_insert(&mut self, d: &mut [u8], start: u64, weight: u64) {
        let n = self.won_count as usize;
        let (mut lo, mut hi) = (0usize, n);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.won_at(d, mid).0 <= start {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let o = self.sorted_offset();
        d.copy_within(o + WON_LEN * lo..o + WON_LEN * n, o + WON_LEN * (lo + 1));
        let e = o + WON_LEN * lo;
        d[e..e + 8].copy_from_slice(&start.to_le_bytes());
        d[e + 8..e + 16].copy_from_slice(&weight.to_le_bytes());
        self.won_count += 1;
    }
}

impl Slot {
    pub fn unpack(b: &[u8]) -> Slot {
        let mut r = Rd { b, o: 0 };
        Slot {
            start: r.u64(),
            weight: r.u64(),
            leaf_index: r.u64(),
            wallet: r.arr(),
            tier: r.u8(),
            status: r.u8(),
            round: r.u8(),
        }
    }

    pub fn pack(&self, b: &mut [u8]) {
        let mut w = Wr { b, o: 0 };
        w.u64(self.start);
        w.u64(self.weight);
        w.u64(self.leaf_index);
        w.put(&self.wallet);
        w.u8(self.tier);
        w.u8(self.status);
        w.u8(self.round);
        w.u8(0);
    }
}

/// Per-wallet entry counter (open raffle with a cap).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entrant {
    pub draw: [u8; 32],
    pub owner: [u8; 32],
    pub count: u64,
    pub bump: u8,
}

impl Entrant {
    pub fn unpack(d: &[u8]) -> Option<Self> {
        if d.len() != ENTRANT_LEN || d[..8] != ENTRANT_DISC {
            return None;
        }
        let mut r = Rd { b: d, o: 8 };
        Some(Entrant { draw: r.arr(), owner: r.arr(), count: r.u64(), bump: r.u8() })
    }

    pub fn pack(&self, d: &mut [u8]) {
        let mut w = Wr { b: d, o: 0 };
        w.put(&ENTRANT_DISC);
        w.put(&self.draw);
        w.put(&self.owner);
        w.u64(self.count);
        w.u8(self.bump);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draw_round_trip() {
        let mut tiers = [Tier::default(); MAX_TIERS];
        tiers[0] = Tier { count: 1, amount: 5 };
        tiers[1] = Tier { count: 5, amount: 2 };
        let mut rounds = [RoundInfo::default(); MAX_ROUNDS];
        rounds[2] = RoundInfo { first_target: 1, target_slot: 2, used_slot: 3, attempt: 4, slot_hash: [5; 32], seed: [6; 32] };
        let d = Draw {
            organizer: [1; 32],
            draw_id: 2,
            bump: 3,
            vault_bump: 4,
            mode: MODE_OPEN,
            weighted: true,
            status: STATUS_RESOLVING,
            round: 2,
            redraw_rounds: 3,
            tier_count: 2,
            depth: 20,
            won_count: 0,
            prize_mint: [7; 32],
            entry_mint: [8; 32],
            fee_dest: [9; 32],
            entry_price: 10,
            wallet_cap: 11,
            close_slot: 12,
            claim_window_slots: 13,
            tiers,
            total_prize: 15,
            funded: 15,
            paid: 16,
            returned: 17,
            refundable: 18,
            root: [19; 32],
            total_weight: 20,
            leaf_count: 21,
            commit_slot: 22,
            won_weight: 23,
            capacity: 24,
            slot_count: 25,
            next_slot: 26,
            round_first_slot: 27,
            window_end: 28,
            rounds,
        };
        let mut b = vec![0u8; d.len()];
        d.pack(&mut b);
        assert_eq!(Draw::unpack(&b), Some(d));
        let s = Slot { start: 1, weight: 2, leaf_index: 3, wallet: [4; 32], tier: 5, status: SLOT_CLAIMED, round: 1 };
        d.write_slot(&mut b, 23, &s);
        assert_eq!(d.read_slot(&b, 23), s);
        // Sorted insert keeps ascending starts.
        let mut d2 = d;
        for (st, w) in [(50u64, 5u64), (10, 1), (30, 2), (70, 9), (20, 3)] {
            d2.won_insert(&mut b, st, w);
        }
        let order: Vec<(u64, u64)> = (0..5).map(|k| d2.won_at(&b, k)).collect();
        assert_eq!(order, vec![(10, 1), (20, 3), (30, 2), (50, 5), (70, 9)]);
        // Wrong size is rejected; a short account only while Created.
        b.push(0);
        assert_eq!(Draw::unpack(&b), None);
        b.truncate(HEADER_LEN + 100);
        assert_eq!(Draw::unpack(&b), None);
        let mut c = d;
        c.status = STATUS_CREATED;
        c.pack(&mut b);
        assert_eq!(Draw::unpack(&b), Some(c));
        let e = Entrant { draw: [1; 32], owner: [2; 32], count: 3, bump: 4 };
        let mut b = vec![0u8; ENTRANT_LEN];
        e.pack(&mut b);
        assert_eq!(Entrant::unpack(&b), Some(e));
    }
}
