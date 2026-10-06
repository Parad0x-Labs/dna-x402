//! Account layouts (little-endian, fixed size).
//!
//! | Account | PDA seeds | Size |
//! |---|---|---|
//! | Pool (also the vault) | `["pool", creator, nonce_le]` | [`POOL_LEN`] |
//! | Round (one per drawn round with tickets) | `["round", pool, round_id_le]` | [`ROUND_LEN`] |
//! | Claim record | `["claim", pool, round_id_le, ticket_index_le]` | [`CLAIM_LEN`] |
//!
//! Each account stores the canonical bump that `find_program_address` returned
//! on chain when the program created it; later instructions re-check the
//! address with `create_program_address` and that stored bump.

use crate::econ::PoolParams;
use crate::tree::FRONTIER_LEN;

pub const POOL_SEED: &[u8] = b"pool";
pub const ROUND_SEED: &[u8] = b"round";
pub const CLAIM_SEED: &[u8] = b"claim";

pub const POOL_DISC: [u8; 8] = *b"NLPPOOL1";
pub const ROUND_DISC: [u8; 8] = *b"NLPROND1";
pub const CLAIM_DISC: [u8; 8] = *b"NLPCLAM1";

/// Pool header length; the round's tree frontier follows at [`FRONTIER_OFFSET`].
pub const POOL_HEADER_LEN: usize = 280;
pub const FRONTIER_OFFSET: usize = POOL_HEADER_LEN;
pub const POOL_LEN: usize = POOL_HEADER_LEN + FRONTIER_LEN;
pub const ROUND_LEN: usize = 248;
pub const CLAIM_LEN: usize = 89;

pub const ROUND_DRAWN: u8 = 1;
pub const ROUND_SETTLED: u8 = 2;

struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}
impl<'a> Rd<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, o: 0 }
    }
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
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.arr())
    }
}

struct Wr<'a> {
    b: &'a mut [u8],
    o: usize,
}
impl<'a> Wr<'a> {
    fn new(b: &'a mut [u8]) -> Self {
        Self { b, o: 0 }
    }
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
    fn u64(&mut self, v: u64) {
        self.put(&v.to_le_bytes());
    }
}

/// Pool state (header). Lamports held by the pool account back every
/// liability field below plus its own rent-exempt minimum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pool {
    pub creator: [u8; 32],
    pub nonce: u64,
    pub params: PoolParams,
    pub retired: bool,
    pub last_settle_won: bool,
    pub has_pending: bool,
    /// Canonical bump of the pool PDA.
    pub bump: u8,
    pub combos: u64,
    pub cap: u64,
    pub recoup_volume: u64,
    /// Jackpot of the open round.
    pub jackpot: u64,
    /// Reserve that seeds the jackpot after a win.
    pub reserve: u64,
    /// Accrued creator fees not yet withdrawn.
    pub creator_owed: u64,
    pub creator_withdrawn: u64,
    /// Prize of the drawn round in its claim window (not yet settled).
    pub locked_prize: u64,
    /// Settled winner shares not yet paid out.
    pub owed_prizes: u64,
    /// Cumulative ticket sales `V`.
    pub total_sales: u64,
    pub pending_round_id: u64,
    /// Open round.
    pub round_id: u64,
    pub round_open_slot: u64,
    pub round_close_slot: u64,
    pub ticket_count: u64,
    pub root: [u8; 32],
}

impl Pool {
    /// Sum of all liabilities (excludes rent).
    pub fn liabilities(&self) -> Option<u64> {
        self.jackpot
            .checked_add(self.reserve)?
            .checked_add(self.creator_owed)?
            .checked_add(self.locked_prize)?
            .checked_add(self.owed_prizes)
    }

    pub fn unpack(d: &[u8]) -> Option<Self> {
        if d.len() != POOL_LEN || d[..8] != POOL_DISC {
            return None;
        }
        let mut r = Rd::new(&d[8..]);
        let creator = r.arr();
        let nonce = r.u64();
        let seed = r.u64();
        let ticket_price = r.u64();
        let fee_max_bps = r.u16();
        let fee_min_bps = r.u16();
        let reserve_bps = r.u16();
        let cap_bps = r.u16();
        let pick_k = r.u8();
        let range_n = r.u8();
        let retired = r.u8() != 0;
        let last_settle_won = r.u8() != 0;
        let has_pending = r.u8() != 0;
        let bump = r.u8();
        let round_slots = r.u64();
        let claim_window_slots = r.u64();
        Some(Pool {
            creator,
            nonce,
            params: PoolParams {
                seed,
                ticket_price,
                fee_max_bps,
                fee_min_bps,
                reserve_bps,
                cap_bps,
                pick_k,
                range_n,
                round_slots,
                claim_window_slots,
            },
            retired,
            last_settle_won,
            has_pending,
            bump,
            combos: r.u64(),
            cap: r.u64(),
            recoup_volume: r.u64(),
            jackpot: r.u64(),
            reserve: r.u64(),
            creator_owed: r.u64(),
            creator_withdrawn: r.u64(),
            locked_prize: r.u64(),
            owed_prizes: r.u64(),
            total_sales: r.u64(),
            pending_round_id: r.u64(),
            round_id: r.u64(),
            round_open_slot: r.u64(),
            round_close_slot: r.u64(),
            ticket_count: r.u64(),
            root: r.arr(),
        })
    }

    /// Write the header (the frontier bytes after it are left as they are).
    pub fn pack(&self, d: &mut [u8]) {
        let mut w = Wr::new(&mut d[..POOL_HEADER_LEN]);
        w.put(&POOL_DISC);
        w.put(&self.creator);
        w.u64(self.nonce);
        let p = &self.params;
        w.u64(p.seed);
        w.u64(p.ticket_price);
        w.u16(p.fee_max_bps);
        w.u16(p.fee_min_bps);
        w.u16(p.reserve_bps);
        w.u16(p.cap_bps);
        w.u8(p.pick_k);
        w.u8(p.range_n);
        w.u8(self.retired as u8);
        w.u8(self.last_settle_won as u8);
        w.u8(self.has_pending as u8);
        w.u8(self.bump);
        w.u64(p.round_slots);
        w.u64(p.claim_window_slots);
        w.u64(self.combos);
        w.u64(self.cap);
        w.u64(self.recoup_volume);
        w.u64(self.jackpot);
        w.u64(self.reserve);
        w.u64(self.creator_owed);
        w.u64(self.creator_withdrawn);
        w.u64(self.locked_prize);
        w.u64(self.owed_prizes);
        w.u64(self.total_sales);
        w.u64(self.pending_round_id);
        w.u64(self.round_id);
        w.u64(self.round_open_slot);
        w.u64(self.round_close_slot);
        w.u64(self.ticket_count);
        w.put(&self.root);
        debug_assert!(w.o <= POOL_HEADER_LEN);
    }
}

/// A drawn round (created by Draw when the round sold at least one ticket).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Round {
    pub pool: [u8; 32],
    pub round_id: u64,
    pub status: u8,
    /// Canonical bump of the round PDA.
    pub bump: u8,
    pub attempt: u64,
    pub target_slot: u64,
    pub used_slot: u64,
    pub slot_hash: [u8; 32],
    pub root: [u8; 32],
    pub ticket_count: u64,
    pub numbers: [u8; 8],
    pub prize: u64,
    pub window_end: u64,
    pub winners: u64,
    pub share: u64,
    pub paid: u64,
    pub rent_payer: [u8; 32],
    pub draw_slot: u64,
}

impl Round {
    pub fn unpack(d: &[u8]) -> Option<Self> {
        if d.len() != ROUND_LEN || d[..8] != ROUND_DISC {
            return None;
        }
        let mut r = Rd::new(&d[8..]);
        Some(Round {
            pool: r.arr(),
            round_id: r.u64(),
            status: r.u8(),
            bump: r.u8(),
            attempt: r.u64(),
            target_slot: r.u64(),
            used_slot: r.u64(),
            slot_hash: r.arr(),
            root: r.arr(),
            ticket_count: r.u64(),
            numbers: r.arr(),
            prize: r.u64(),
            window_end: r.u64(),
            winners: r.u64(),
            share: r.u64(),
            paid: r.u64(),
            rent_payer: r.arr(),
            draw_slot: r.u64(),
        })
    }

    pub fn pack(&self, d: &mut [u8]) {
        let mut w = Wr::new(d);
        w.put(&ROUND_DISC);
        w.put(&self.pool);
        w.u64(self.round_id);
        w.u8(self.status);
        w.u8(self.bump);
        w.u64(self.attempt);
        w.u64(self.target_slot);
        w.u64(self.used_slot);
        w.put(&self.slot_hash);
        w.put(&self.root);
        w.u64(self.ticket_count);
        w.put(&self.numbers);
        w.u64(self.prize);
        w.u64(self.window_end);
        w.u64(self.winners);
        w.u64(self.share);
        w.u64(self.paid);
        w.put(&self.rent_payer);
        w.u64(self.draw_slot);
        debug_assert!(w.o <= ROUND_LEN);
    }
}

/// A registered winning ticket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimRecord {
    pub pool: [u8; 32],
    pub round_id: u64,
    pub ticket_index: u64,
    pub owner: [u8; 32],
    /// Canonical bump of the claim PDA.
    pub bump: u8,
}

impl ClaimRecord {
    pub fn unpack(d: &[u8]) -> Option<Self> {
        if d.len() != CLAIM_LEN || d[..8] != CLAIM_DISC {
            return None;
        }
        let mut r = Rd::new(&d[8..]);
        Some(ClaimRecord { pool: r.arr(), round_id: r.u64(), ticket_index: r.u64(), owner: r.arr(), bump: r.u8() })
    }

    pub fn pack(&self, d: &mut [u8]) {
        let mut w = Wr::new(d);
        w.put(&CLAIM_DISC);
        w.put(&self.pool);
        w.u64(self.round_id);
        w.u64(self.ticket_index);
        w.put(&self.owner);
        w.u8(self.bump);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_round_trip() {
        let p = Pool {
            creator: [1; 32],
            nonce: 2,
            params: PoolParams {
                seed: 3,
                ticket_price: 4,
                fee_max_bps: 5,
                fee_min_bps: 6,
                reserve_bps: 7,
                cap_bps: 8,
                pick_k: 9,
                range_n: 10,
                round_slots: 11,
                claim_window_slots: 12,
            },
            retired: true,
            last_settle_won: true,
            has_pending: true,
            bump: 251,
            combos: 13,
            cap: 14,
            recoup_volume: 15,
            jackpot: 16,
            reserve: 17,
            creator_owed: 18,
            creator_withdrawn: 19,
            locked_prize: 20,
            owed_prizes: 21,
            total_sales: 22,
            pending_round_id: 23,
            round_id: 24,
            round_open_slot: 25,
            round_close_slot: 26,
            ticket_count: 27,
            root: [28; 32],
        };
        let mut d = vec![0u8; POOL_LEN];
        p.pack(&mut d);
        assert_eq!(Pool::unpack(&d), Some(p));
    }

    #[test]
    fn round_and_claim_round_trip() {
        let r = Round {
            pool: [1; 32],
            round_id: 2,
            status: ROUND_SETTLED,
            bump: 250,
            attempt: 3,
            target_slot: 4,
            used_slot: 5,
            slot_hash: [6; 32],
            root: [7; 32],
            ticket_count: 8,
            numbers: [1, 2, 3, 0, 0, 0, 0, 0],
            prize: 9,
            window_end: 10,
            winners: 11,
            share: 12,
            paid: 13,
            rent_payer: [14; 32],
            draw_slot: 15,
        };
        let mut d = vec![0u8; ROUND_LEN];
        r.pack(&mut d);
        assert_eq!(Round::unpack(&d), Some(r));
        let c = ClaimRecord { pool: [1; 32], round_id: 2, ticket_index: 3, owner: [4; 32], bump: 249 };
        let mut d = vec![0u8; CLAIM_LEN];
        c.pack(&mut d);
        assert_eq!(ClaimRecord::unpack(&d), Some(c));
    }
}
