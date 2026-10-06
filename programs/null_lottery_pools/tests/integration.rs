// End-to-end tests of null_lottery_pools through solana-program-test.
//
// By default the native processor runs. Run against the SBF binary with
// `SBF_OUT_DIR=<dir with null_lottery_pools.so> cargo test`; the compute-unit
// test then reports metered CU.
#![cfg(not(target_os = "windows"))]

use null_lottery_pools::{
    draw::{self, Selection, DRAW_DELAY_SLOTS, FALLBACK_STEP_SLOTS},
    econ::{self, PoolParams},
    error::PoolError,
    instruction as ix,
    state::{ClaimRecord, Pool, Round, CLAIM_LEN, POOL_LEN, ROUND_DRAWN, ROUND_SETTLED, TIER_JACKPOT, TIER_SECOND},
    tree,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    hash::{hashv, Hash},
    instruction::{Instruction, InstructionError},
    pubkey::Pubkey,
    rent::Rent,
    signature::{Keypair, Signer},
    slot_hashes::SlotHashes,
    system_instruction, system_program,
    transaction::{Transaction, TransactionError},
};

const SOL: u64 = 1_000_000_000;

fn ce(e: PoolError) -> InstructionError {
    InstructionError::Custom(e.code())
}

fn nums(v: &[u8]) -> [u8; 8] {
    let mut a = [0u8; 8];
    a[..v.len()].copy_from_slice(v);
    a
}

fn params(k: u8, n: u8, price: u64, seed: u64) -> PoolParams {
    PoolParams {
        seed,
        ticket_price: price,
        fee_max_bps: 2_500,
        fee_min_bps: 200,
        reserve_bps: 500,
        cap_bps: econ::DEFAULT_CAP_BPS,
        pick_k: k,
        range_n: n,
        round_slots: 150,
        claim_window_slots: 150,
        tier2_bps: 0,
    }
}

fn filler(slot: u64) -> [u8; 32] {
    hashv(&[b"filler", &slot.to_le_bytes()]).to_bytes()
}

#[derive(Clone, Copy, Debug)]
struct Tk {
    owner: Pubkey,
    numbers: [u8; 8],
    index: u64,
    leaf: [u8; 32],
}

struct T {
    ctx: ProgramTestContext,
    pid: Pubkey,
    n: u32,
    slot: u64,
    rent: Rent,
}

impl T {
    async fn new(funded: &[&Keypair]) -> Self {
        let pid = null_lottery_pools::id();
        let mut pt = ProgramTest::new(
            "null_lottery_pools",
            pid,
            processor!(null_lottery_pools::process_instruction),
        );
        for k in funded {
            pt.add_account(k.pubkey(), Account::new(10_000 * SOL, 0, &system_program::id()));
        }
        let mut ctx = pt.start_with_context().await;
        let rent = ctx.banks_client.get_rent().await.unwrap();
        let mut t = T { ctx, pid, n: 0, slot: 0, rent };
        t.warp(1_000).await;
        t
    }

    fn sbf() -> bool {
        std::env::var("SBF_OUT_DIR").is_ok() || std::env::var("BPF_OUT_DIR").is_ok()
    }

    async fn warp(&mut self, slot: u64) {
        let mut c: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        c.slot = slot;
        self.ctx.set_sysvar(&c);
        self.slot = slot;
    }

    fn hashes(&mut self, entries: &[(u64, [u8; 32])]) {
        let v: Vec<(u64, Hash)> = entries.iter().map(|(s, h)| (*s, Hash::new_from_array(*h))).collect();
        self.ctx.set_sysvar(&SlotHashes::new(&v));
    }

    async fn send(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Result<(), InstructionError> {
        self.n += 1;
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_000_000 + self.n)];
        all.extend(ixs);
        let payer = self.ctx.payer.insecure_clone();
        let mut s: Vec<&Keypair> = vec![&payer];
        s.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&all, Some(&payer.pubkey()), &s, self.ctx.last_blockhash);
        match self.ctx.banks_client.process_transaction(tx).await {
            Ok(()) => Ok(()),
            Err(BanksClientError::TransactionError(TransactionError::InstructionError(_, e))) => Err(e),
            Err(BanksClientError::SimulationError { err: TransactionError::InstructionError(_, e), .. }) => Err(e),
            Err(e) => panic!("unexpected error: {e:?}"),
        }
    }

    /// Simulated compute units of a transaction holding only `ixs`.
    async fn cu(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> u64 {
        let payer = self.ctx.payer.insecure_clone();
        let mut s: Vec<&Keypair> = vec![&payer];
        s.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &s, self.ctx.last_blockhash);
        let r = self.ctx.banks_client.simulate_transaction(tx).await.unwrap();
        r.result.unwrap().unwrap();
        r.simulation_details.unwrap().units_consumed
    }

    async fn account(&mut self, k: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*k).await.unwrap()
    }

    async fn lamports(&mut self, k: &Pubkey) -> u64 {
        self.account(k).await.map(|a| a.lamports).unwrap_or(0)
    }

    async fn pool(&mut self, k: &Pubkey) -> Pool {
        Pool::unpack(&self.account(k).await.expect("pool").data).expect("pool layout")
    }

    async fn round(&mut self, pool: &Pubkey, id: u64) -> Option<Round> {
        let k = ix::round_address(&self.pid, pool, id).0;
        self.account(&k).await.and_then(|a| Round::unpack(&a.data))
    }

    /// Vault invariant; `exact` also requires no surplus lamports.
    async fn solvent(&mut self, pool: &Pubkey, exact: bool) {
        let lam = self.lamports(pool).await;
        let p = self.pool(pool).await;
        let need = p.liabilities().unwrap() + self.rent.minimum_balance(POOL_LEN);
        assert!(lam >= need, "insolvent: {lam} < {need}");
        if exact {
            assert_eq!(lam, need, "unexpected surplus");
        }
    }

    async fn create(&mut self, creator: &Keypair, nonce: u64, p: PoolParams) -> Result<Pubkey, InstructionError> {
        let pid = self.pid;
        self.send(vec![ix::create_pool(&pid, &creator.pubkey(), nonce, p)], &[creator]).await?;
        Ok(ix::pool_address(&pid, &creator.pubkey(), nonce).0)
    }

    async fn buy(&mut self, pool: &Pubkey, payer: &Keypair, owner: &Pubkey, numbers: [u8; 8]) -> Result<Tk, InstructionError> {
        let p = self.pool(pool).await;
        let pid = self.pid;
        self.send(vec![ix::buy_ticket(&pid, &payer.pubkey(), pool, p.round_id, owner, numbers)], &[payer])
            .await?;
        let leaf = tree::ticket_leaf(&pool.to_bytes(), p.round_id, &owner.to_bytes(), &numbers, p.ticket_count);
        Ok(Tk { owner: *owner, numbers, index: p.ticket_count, leaf })
    }

    /// Draw the open round. The test controls SlotHashes, so it picks a hash
    /// for the target slot whose drawn numbers satisfy `pick`.
    async fn draw_pick(
        &mut self,
        pool: &Pubkey,
        cranker: &Keypair,
        pick: &dyn Fn(&[u8; 8]) -> bool,
    ) -> Result<[u8; 8], InstructionError> {
        let p = self.pool(pool).await;
        let t0 = p.round_close_slot + DRAW_DELAY_SLOTS;
        let (h, numbers) = grind(pool, &p, 0, t0, t0, pick);
        let entries: Vec<_> = (t0 - 20..=t0 + 3).map(|s| (s, if s == t0 { h } else { filler(s) })).collect();
        self.hashes(&entries);
        let slot = self.slot.max(t0 + 3);
        self.warp(slot).await;
        let pid = self.pid;
        self.send(vec![ix::draw(&pid, &cranker.pubkey(), pool, p.round_id)], &[cranker]).await?;
        if p.ticket_count > 0 {
            let r = self.round(pool, p.round_id).await.unwrap();
            assert_eq!(r.numbers, numbers);
            assert_eq!((r.attempt, r.target_slot, r.used_slot), (0, t0, t0));
        }
        Ok(numbers)
    }

    async fn claim(&mut self, pool: &Pubkey, round_id: u64, signer: &Keypair, tk: &Tk, leaves: &[[u8; 32]]) -> Result<(), InstructionError> {
        let proof = tree::proof_of(leaves, tk.index as usize);
        let pid = self.pid;
        let i = ix::claim(&pid, &signer.pubkey(), pool, round_id, tk.index, tk.numbers, proof);
        self.send(vec![i], &[signer]).await
    }

    async fn settle_after_window(&mut self, pool: &Pubkey, round_id: u64) -> Result<(), InstructionError> {
        let r = self.round(pool, round_id).await.unwrap();
        let slot = self.slot.max(r.window_end + 1);
        self.warp(slot).await;
        let pid = self.pid;
        self.send(vec![ix::settle(&pid, pool, round_id)], &[]).await
    }

    /// Amount the next Payout of this claim record pays (by its tier).
    async fn payout_amount(&mut self, pool: &Pubkey, round_id: u64, index: u64) -> u64 {
        let k = ix::claim_address(&self.pid, pool, round_id, index).0;
        let rec = ClaimRecord::unpack(&self.account(&k).await.unwrap().data).unwrap();
        let r = self.round(pool, round_id).await.unwrap();
        if rec.tier == TIER_SECOND { r.tier2_share } else { r.share }
    }

    async fn payout(&mut self, pool: &Pubkey, round_id: u64, index: u64, owner: &Pubkey) -> Result<(), InstructionError> {
        let pid = self.pid;
        self.send(vec![ix::payout(&pid, pool, round_id, index, owner)], &[]).await
    }
}

fn grind(pool: &Pubkey, p: &Pool, attempt: u64, target: u64, used: u64, pick: &dyn Fn(&[u8; 8]) -> bool) -> ([u8; 32], [u8; 8]) {
    for i in 0u64..2_000_000 {
        let h = hashv(&[b"test-slot-hash", &i.to_le_bytes()]).to_bytes();
        let sel = Selection { attempt, target_slot: target, used_slot: used, hash: h };
        let e = draw::entropy(&pool.to_bytes(), p.round_id, &sel, &p.root, p.ticket_count);
        let n = draw::draw_numbers(&e, p.params.pick_k, p.params.range_n);
        if pick(&n) {
            return (h, n);
        }
    }
    panic!("no slot hash satisfies the predicate");
}

fn leaves(t: &[Tk]) -> Vec<[u8; 32]> {
    t.iter().map(|x| x.leaf).collect()
}

// ── economics on chain ──────────────────────────────────────────────────────

#[tokio::test]
async fn split_conservation_and_recoup_crossing_on_chain() {
    let creator = Keypair::new();
    let buyer = Keypair::new();
    let mut t = T::new(&[&creator, &buyer]).await;
    // S = 0.005 SOL, p = 0.003 SOL, f_max 25% -> Vr = 0.02 SOL. Ticket 7 spans
    // [0.018, 0.021): it crosses the recoup boundary.
    let mut p = params(5, 36, 3_000_000, 5_000_000);
    p.fee_min_bps = 200;
    let pool = t.create(&creator, 1, p).await.unwrap();
    t.solvent(&pool, true).await;
    let st = t.pool(&pool).await;
    assert_eq!(st.recoup_volume, 20_000_000);
    assert_eq!(st.jackpot, 5_000_000);

    let mut fees = Vec::new();
    for i in 0..9u8 {
        let before = t.pool(&pool).await;
        let lam_before = t.lamports(&pool).await;
        t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[1, 2, 3, 4, 5 + i])).await.unwrap();
        let after = t.pool(&pool).await;
        let lam_after = t.lamports(&pool).await;
        assert_eq!(lam_after - lam_before, 3_000_000, "vault receives the price");
        let dc = after.creator_owed - before.creator_owed;
        let dj = after.jackpot - before.jackpot;
        let dr = after.reserve - before.reserve;
        assert_eq!(dc + dj + dr, 3_000_000, "split conserves the price to the lamport");
        assert_eq!(dr, 150_000);
        fees.push(dc);
        t.solvent(&pool, true).await;
    }
    // Tickets 1..7 at 25% (ticket 7 crosses Vr; f(Vr) = f_max, so 750_000).
    assert_eq!(&fees[..7], &[750_000; 7]);
    // Ticket 8 starts at V = 0.021 SOL: floor(2500 * 20 / 21) = 2380 bps.
    assert_eq!(fees[7], 3_000_000 * 2_380 / 10_000);
    // Ticket 9 starts at V = 0.024 SOL: floor(2500 * 20 / 24) = 2083 bps.
    assert_eq!(fees[8], 3_000_000 * 2_083 / 10_000);
    let st = t.pool(&pool).await;
    assert_eq!(st.total_sales, 27_000_000);
    assert!(st.creator_owed >= 5_000_000, "seed recouped");
}

#[tokio::test]
async fn jackpot_cap_overflow_goes_to_reserve() {
    let creator = Keypair::new();
    let buyer = Keypair::new();
    let mut t = T::new(&[&creator, &buyer]).await;
    // k=1, n=4: C=4, cap = 0.7 * 0.01 * 4 SOL = 28_000_000.
    let pool = t.create(&creator, 7, params(1, 4, 10_000_000, 20_000_000)).await.unwrap();
    assert_eq!(t.pool(&pool).await.cap, 28_000_000);
    t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[1])).await.unwrap();
    let s = t.pool(&pool).await;
    assert_eq!((s.jackpot, s.reserve, s.creator_owed), (27_000_000, 500_000, 2_500_000));
    t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[2])).await.unwrap();
    let s = t.pool(&pool).await;
    // 7_000_000 jackpot share: 1_000_000 fits, 6_000_000 overflows to reserve.
    assert_eq!((s.jackpot, s.reserve, s.creator_owed), (28_000_000, 7_000_000, 5_000_000));
    t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[3])).await.unwrap();
    let s = t.pool(&pool).await;
    assert_eq!((s.jackpot, s.reserve), (28_000_000, 14_500_000));
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn create_pool_rejects_out_of_bound_params() {
    let creator = Keypair::new();
    let mut t = T::new(&[&creator]).await;
    let mut p = params(5, 36, SOL / 100, SOL);
    p.fee_max_bps = 3_001;
    assert_eq!(t.create(&creator, 1, p).await.unwrap_err(), ce(PoolError::InvalidParams));
    let mut p = params(5, 36, SOL / 100, SOL);
    p.cap_bps = 8_000; // 8_000 + 2_500 > 10_000
    assert_eq!(t.create(&creator, 1, p).await.unwrap_err(), ce(PoolError::InvalidParams));
    // Seed above the cap (k=1, n=4: cap 0.028 SOL).
    assert_eq!(
        t.create(&creator, 1, params(1, 4, SOL / 100, SOL)).await.unwrap_err(),
        ce(PoolError::InvalidParams)
    );
    // A valid pool, then the same nonce again.
    t.create(&creator, 1, params(5, 36, SOL / 100, SOL)).await.unwrap();
    assert_eq!(
        t.create(&creator, 1, params(5, 36, SOL / 100, SOL)).await.unwrap_err(),
        ce(PoolError::AccountInUse)
    );
}

#[tokio::test]
async fn buy_rejections() {
    let creator = Keypair::new();
    let buyer = Keypair::new();
    let mut t = T::new(&[&creator, &buyer]).await;
    let pool = t.create(&creator, 1, params(5, 36, SOL / 100, SOL)).await.unwrap();
    let pid = t.pid;
    let bad_round = ix::buy_ticket(&pid, &buyer.pubkey(), &pool, 1, &buyer.pubkey(), nums(&[1, 2, 3, 4, 5]));
    assert_eq!(t.send(vec![bad_round], &[&buyer]).await.unwrap_err(), ce(PoolError::WrongRound));
    for bad in [nums(&[1, 2, 3, 4, 37]), nums(&[2, 1, 3, 4, 5]), nums(&[1, 2, 3, 4]), nums(&[1, 2, 3, 4, 5, 6])] {
        assert_eq!(
            t.buy(&pool, &buyer, &buyer.pubkey(), bad).await.unwrap_err(),
            ce(PoolError::InvalidNumbers)
        );
    }
    let close = t.pool(&pool).await.round_close_slot;
    t.warp(close).await;
    assert_eq!(
        t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[1, 2, 3, 4, 5])).await.unwrap_err(),
        ce(PoolError::SalesClosed)
    );
    t.solvent(&pool, true).await;
}

// ── draw ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn draw_rejections_and_fallback_slot() {
    let creator = Keypair::new();
    let buyer = Keypair::new();
    let cranker = Keypair::new();
    let mut t = T::new(&[&creator, &buyer, &cranker]).await;
    let pool = t.create(&creator, 1, params(5, 36, SOL / 100, SOL)).await.unwrap();
    t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[1, 2, 3, 4, 5])).await.unwrap();
    t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[6, 7, 8, 9, 10])).await.unwrap();
    let p = t.pool(&pool).await;
    let t0 = p.round_close_slot + DRAW_DELAY_SLOTS;
    let pid = t.pid;
    let draw_ix = |c: &Keypair| ix::draw(&pid, &c.pubkey(), &pool, 0);

    // Before the close slot.
    t.hashes(&[(t0, filler(t0))]);
    assert_eq!(t.send(vec![draw_ix(&cranker)], &[&cranker]).await.unwrap_err(), ce(PoolError::SalesOpen));

    // Sales closed but the target slot has no hash yet.
    t.warp(p.round_close_slot + 10).await;
    let early: Vec<_> = (t0 - 100..t0).map(|s| (s, filler(s))).collect();
    t.hashes(&early);
    assert_eq!(t.send(vec![draw_ix(&cranker)], &[&cranker]).await.unwrap_err(), ce(PoolError::DrawTooEarly));

    // A forged SlotHashes account (right layout, wrong address).
    let fake = Pubkey::new_unique();
    let mut fake_acct = Account::new(SOL, 20_488, &solana_sdk::sysvar::id());
    let data = draw::encode_slot_hashes(&[(t0, [9u8; 32])]);
    fake_acct.data[..data.len()].copy_from_slice(&data);
    t.ctx.set_account(&fake, &fake_acct.into());
    let forged = ix::draw_with_sysvar(&pid, &cranker.pubkey(), &pool, 0, &fake);
    assert_eq!(t.send(vec![forged], &[&cranker]).await.unwrap_err(), ce(PoolError::InvalidSysvar));
    // Another sysvar in its place.
    let clock_in_place = ix::draw_with_sysvar(&pid, &cranker.pubkey(), &pool, 0, &solana_sdk::sysvar::clock::id());
    assert_eq!(t.send(vec![clock_in_place], &[&cranker]).await.unwrap_err(), ce(PoolError::InvalidSysvar));

    // T_0 aged out of the window (oldest entry > T_0): fallback T_1 = T_0 + 512.
    let t1 = t0 + FALLBACK_STEP_SLOTS;
    let (h1, expect) = grind(&pool, &p, 1, t1, t1, &|_| true);
    let window: Vec<_> = (t0 + 100..=t0 + 611).map(|s| (s, if s == t1 { h1 } else { filler(s) })).collect();
    assert_eq!(window.len(), 512);
    t.hashes(&window);
    t.warp(t0 + 611).await;
    t.send(vec![draw_ix(&cranker)], &[&cranker]).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.attempt, r.target_slot, r.used_slot, r.slot_hash), (1, t1, t1, h1));
    assert_eq!(r.numbers, expect);
    assert_eq!(r.status, ROUND_DRAWN);
    // The round account rent was paid by the cranker.
    assert_eq!(r.rent_payer, cranker.pubkey().to_bytes());
    // Drawing again is refused: the drawn round is unsettled.
    assert_eq!(
        t.send(vec![ix::draw(&pid, &cranker.pubkey(), &pool, 1)], &[&cranker]).await.unwrap_err(),
        ce(PoolError::PreviousRoundUnsettled)
    );
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn draw_uses_first_target_while_covered_and_next_slot_when_skipped() {
    let creator = Keypair::new();
    let buyer = Keypair::new();
    let mut t = T::new(&[&creator, &buyer]).await;
    let pool = t.create(&creator, 1, params(5, 36, SOL / 100, SOL)).await.unwrap();
    t.buy(&pool, &buyer, &buyer.pubkey(), nums(&[1, 2, 3, 4, 5])).await.unwrap();
    let p = t.pool(&pool).await;
    let t0 = p.round_close_slot + DRAW_DELAY_SLOTS;
    // T_0 skipped by its leader; T_1 is in the window too (sparse window).
    // T_0 is still covered (oldest = T_0 - 2), so the first produced slot
    // after it (T_0 + 2) is used, not T_1.
    let entries: Vec<_> = (0..=310u64).map(|i| t0 - 2 + 2 * i).filter(|s| *s != t0).map(|s| (s, filler(s))).collect();
    assert!(entries.iter().any(|e| e.0 == t0 + FALLBACK_STEP_SLOTS));
    t.hashes(&entries);
    t.warp(t0 + 700).await;
    let pid = t.pid;
    t.send(vec![ix::draw(&pid, &buyer.pubkey(), &pool, 0)], &[&buyer]).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.attempt, r.target_slot, r.used_slot, r.slot_hash), (0, t0, t0 + 2, filler(t0 + 2)));
    let sel = Selection { attempt: 0, target_slot: t0, used_slot: t0 + 2, hash: filler(t0 + 2) };
    let e = draw::entropy(&pool.to_bytes(), 0, &sel, &p.root, 1);
    assert_eq!(r.numbers, draw::draw_numbers(&e, 5, 36));
}

#[tokio::test]
async fn empty_round_rolls_without_round_account() {
    let creator = Keypair::new();
    let mut t = T::new(&[&creator]).await;
    let pool = t.create(&creator, 1, params(5, 36, SOL / 100, SOL)).await.unwrap();
    let p = t.pool(&pool).await;
    t.warp(p.round_close_slot).await;
    let pid = t.pid;
    t.send(vec![ix::draw(&pid, &creator.pubkey(), &pool, 0)], &[&creator]).await.unwrap();
    assert!(t.round(&pool, 0).await.is_none());
    let q = t.pool(&pool).await;
    assert_eq!((q.round_id, q.jackpot, q.has_pending), (1, SOL, false));
    assert_eq!(q.round_close_slot, p.round_close_slot + 150);
    t.solvent(&pool, true).await;
}

// ── rounds, claims, payouts ─────────────────────────────────────────────────

#[tokio::test]
async fn no_winner_rolls_over() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let cranker = Keypair::new();
    let mut t = T::new(&[&creator, &alice, &cranker]).await;
    // k=2, n=6: C=15, cap = 0.105 SOL.
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    let a = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    let b = t.buy(&pool, &alice, &alice.pubkey(), nums(&[3, 4])).await.unwrap();
    let jackpot = t.pool(&pool).await.jackpot;
    assert_eq!(jackpot, 50_000_000 + 2 * 7_000_000);
    let drawn = t.draw_pick(&pool, &cranker, &|n| *n != nums(&[1, 2]) && *n != nums(&[3, 4])).await.unwrap();
    let st = t.pool(&pool).await;
    assert_eq!((st.jackpot, st.locked_prize, st.has_pending), (0, jackpot, true));
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!(r.prize, jackpot);
    // Losing tickets cannot claim.
    let lv = leaves(&[a, b]);
    assert_eq!(t.claim(&pool, 0, &alice, &a, &lv).await.unwrap_err(), ce(PoolError::TicketNotWinning));
    let fake = Tk { numbers: drawn, ..a };
    assert_eq!(t.claim(&pool, 0, &alice, &fake, &lv).await.unwrap_err(), ce(PoolError::InvalidProof));
    // Settle is refused during the window.
    let pid = t.pid;
    assert_eq!(t.send(vec![ix::settle(&pid, &pool, 0)], &[]).await.unwrap_err(), ce(PoolError::ClaimWindowOpen));
    t.settle_after_window(&pool, 0).await.unwrap();
    let st = t.pool(&pool).await;
    assert_eq!((st.jackpot, st.locked_prize, st.has_pending, st.last_settle_won), (jackpot, 0, false, false));
    t.solvent(&pool, true).await;
    // Round rent goes back to the cranker, only to the cranker.
    let cr_before = t.lamports(&cranker.pubkey()).await;
    let rk = ix::round_address(&pid, &pool, 0).0;
    let round_rent = t.lamports(&rk).await;
    assert_eq!(
        t.send(vec![ix::close_round(&pid, &pool, 0, &alice.pubkey())], &[]).await.unwrap_err(),
        ce(PoolError::WrongRentPayer)
    );
    t.send(vec![ix::close_round(&pid, &pool, 0, &cranker.pubkey())], &[]).await.unwrap();
    assert_eq!(t.lamports(&cranker.pubkey()).await, cr_before + round_rent);
    assert!(t.account(&rk).await.is_none());
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn single_winner_paid_and_reserve_seeds_next_round() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let dave = Keypair::new();
    let mut t = T::new(&[&creator, &alice, &bob, &dave]).await;
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    let a = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    let b = t.buy(&pool, &bob, &bob.pubkey(), nums(&[3, 4])).await.unwrap();
    let c = t.buy(&pool, &bob, &bob.pubkey(), nums(&[5, 6])).await.unwrap();
    let before = t.pool(&pool).await;
    t.draw_pick(&pool, &bob, &|n| *n == nums(&[1, 2])).await.unwrap();
    let prize = before.jackpot;
    // Round 1 sells during round 0's window.
    t.buy(&pool, &dave, &dave.pubkey(), nums(&[1, 3])).await.unwrap();
    let lv = leaves(&[a, b, c]);
    t.claim(&pool, 0, &alice, &a, &lv).await.unwrap();
    let mid = t.pool(&pool).await;
    t.settle_after_window(&pool, 0).await.unwrap();
    let st = t.pool(&pool).await;
    // Reserve seeds the next jackpot: dave's jackpot share + the whole reserve.
    assert_eq!(st.jackpot, mid.jackpot + mid.reserve);
    assert_eq!(st.reserve, 0);
    assert_eq!(st.owed_prizes, prize);
    assert!(st.last_settle_won);
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.status, r.winners, r.share), (ROUND_SETTLED, 1, prize));
    // Close refused until the winner is paid.
    let pid = t.pid;
    assert_eq!(
        t.send(vec![ix::close_round(&pid, &pool, 0, &bob.pubkey())], &[]).await.unwrap_err(),
        ce(PoolError::RoundNotFinished)
    );
    // Anyone cranks the payout; it pays the ticket owner.
    let alice_before = t.lamports(&alice.pubkey()).await;
    let record_rent = t.rent.minimum_balance(CLAIM_LEN);
    t.payout(&pool, 0, 0, &alice.pubkey()).await.unwrap();
    assert_eq!(t.lamports(&alice.pubkey()).await, alice_before + prize + record_rent);
    assert!(t.account(&ix::claim_address(&pid, &pool, 0, 0).0).await.is_none());
    // A second payout of the same claim fails (record closed).
    assert_eq!(t.payout(&pool, 0, 0, &alice.pubkey()).await.unwrap_err(), ce(PoolError::ClaimMismatch));
    let st = t.pool(&pool).await;
    assert_eq!(st.owed_prizes, 0);
    t.send(vec![ix::close_round(&pid, &pool, 0, &bob.pubkey())], &[]).await.unwrap();
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn multi_winner_split_with_dust() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let mut t = T::new(&[&creator, &alice, &bob]).await;
    // Prize 50_000_002 + 4 * 7_000_000 = 78_000_002; three winners -> share
    // 26_000_000, dust 2 rolls over.
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_002)).await.unwrap();
    let a0 = t.buy(&pool, &alice, &alice.pubkey(), nums(&[2, 5])).await.unwrap();
    let b0 = t.buy(&pool, &bob, &bob.pubkey(), nums(&[2, 5])).await.unwrap();
    let a1 = t.buy(&pool, &alice, &alice.pubkey(), nums(&[2, 5])).await.unwrap();
    let l0 = t.buy(&pool, &bob, &bob.pubkey(), nums(&[1, 6])).await.unwrap();
    let prize = t.pool(&pool).await.jackpot;
    assert_eq!(prize, 78_000_002);
    t.draw_pick(&pool, &bob, &|n| *n == nums(&[2, 5])).await.unwrap();
    let lv = leaves(&[a0, b0, a1, l0]);
    t.claim(&pool, 0, &alice, &a0, &lv).await.unwrap();
    t.claim(&pool, 0, &bob, &b0, &lv).await.unwrap();
    t.claim(&pool, 0, &alice, &a1, &lv).await.unwrap();
    let mid = t.pool(&pool).await;
    t.settle_after_window(&pool, 0).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.winners, r.share), (3, 26_000_000));
    let st = t.pool(&pool).await;
    assert_eq!(st.owed_prizes, 78_000_000);
    assert_eq!(st.jackpot, mid.jackpot + 2 + mid.reserve);
    let (ab, bb) = (t.lamports(&alice.pubkey()).await, t.lamports(&bob.pubkey()).await);
    let rr = t.rent.minimum_balance(CLAIM_LEN);
    t.payout(&pool, 0, 0, &alice.pubkey()).await.unwrap();
    // Payout to the wrong owner is refused.
    assert_eq!(t.payout(&pool, 0, 1, &alice.pubkey()).await.unwrap_err(), ce(PoolError::ClaimMismatch));
    t.payout(&pool, 0, 1, &bob.pubkey()).await.unwrap();
    t.payout(&pool, 0, 2, &alice.pubkey()).await.unwrap();
    assert_eq!(t.lamports(&alice.pubkey()).await, ab + 2 * (26_000_000 + rr));
    assert_eq!(t.lamports(&bob.pubkey()).await, bb + 26_000_000 + rr);
    assert_eq!(t.pool(&pool).await.owed_prizes, 0);
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn claim_rejections() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let mallory = Keypair::new();
    let mut t = T::new(&[&creator, &alice, &mallory]).await;
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    let a = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    // Mallory pays for a ticket owned by alice: still alice's ticket.
    let b = t.buy(&pool, &mallory, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    let c = t.buy(&pool, &mallory, &mallory.pubkey(), nums(&[3, 4])).await.unwrap();
    t.draw_pick(&pool, &mallory, &|n| *n == nums(&[1, 2])).await.unwrap();
    let lv = leaves(&[a, b, c]);

    // Wrong owner: mallory presents alice's winning ticket with a valid proof.
    assert_eq!(t.claim(&pool, 0, &mallory, &a, &lv).await.unwrap_err(), ce(PoolError::InvalidProof));
    assert_eq!(t.claim(&pool, 0, &mallory, &b, &lv).await.unwrap_err(), ce(PoolError::InvalidProof));
    // Bad proof: one sibling flipped.
    let mut proof = tree::proof_of(&lv, 0);
    proof[0][0] ^= 1;
    let pid = t.pid;
    let bad = ix::claim(&pid, &alice.pubkey(), &pool, 0, 0, a.numbers, proof);
    assert_eq!(t.send(vec![bad], &[&alice]).await.unwrap_err(), ce(PoolError::InvalidProof));
    // Proof of index 0 presented as index 1.
    let wrong_index = ix::claim(&pid, &alice.pubkey(), &pool, 0, 1, a.numbers, tree::proof_of(&lv, 0));
    assert_eq!(t.send(vec![wrong_index], &[&alice]).await.unwrap_err(), ce(PoolError::InvalidProof));
    // Index beyond the round.
    let beyond = ix::claim(&pid, &alice.pubkey(), &pool, 0, 3, a.numbers, tree::proof_of(&lv, 0));
    assert_eq!(t.send(vec![beyond], &[&alice]).await.unwrap_err(), ce(PoolError::InvalidProof));
    // Losing ticket.
    assert_eq!(t.claim(&pool, 0, &mallory, &c, &lv).await.unwrap_err(), ce(PoolError::TicketNotWinning));
    // Valid claim, then the same ticket again.
    t.claim(&pool, 0, &alice, &a, &lv).await.unwrap();
    assert_eq!(t.claim(&pool, 0, &alice, &a, &lv).await.unwrap_err(), ce(PoolError::AlreadyClaimed));
    // After the window: refused, even for the second winning ticket.
    let r = t.round(&pool, 0).await.unwrap();
    t.warp(r.window_end + 1).await;
    assert_eq!(t.claim(&pool, 0, &alice, &b, &lv).await.unwrap_err(), ce(PoolError::ClaimWindowClosed));
    t.send(vec![ix::settle(&pid, &pool, 0)], &[]).await.unwrap();
    // The prize went to the one registered ticket; the unclaimed one got nothing.
    assert_eq!(t.round(&pool, 0).await.unwrap().share, r.prize);
    assert_eq!(t.claim(&pool, 0, &alice, &b, &lv).await.unwrap_err(), ce(PoolError::WrongStatus));
    // Settle twice is refused.
    assert_eq!(t.send(vec![ix::settle(&pid, &pool, 0)], &[]).await.unwrap_err(), ce(PoolError::WrongStatus));
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn unclaimed_winning_ticket_rolls_over() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let mut t = T::new(&[&creator, &alice]).await;
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    let prize = t.pool(&pool).await.jackpot;
    t.draw_pick(&pool, &alice, &|n| *n == nums(&[1, 2])).await.unwrap();
    // Round 1 sells during the window.
    t.buy(&pool, &alice, &alice.pubkey(), nums(&[3, 4])).await.unwrap();
    let mid = t.pool(&pool).await;
    t.settle_after_window(&pool, 0).await.unwrap();
    let st = t.pool(&pool).await;
    assert_eq!(st.jackpot, mid.jackpot + prize);
    assert_eq!((st.owed_prizes, st.locked_prize, st.last_settle_won), (0, 0, false));
    t.solvent(&pool, true).await;
}

// ── creator rules ───────────────────────────────────────────────────────────

#[tokio::test]
async fn creator_withdraws_only_accrued_fees() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let mut t = T::new(&[&creator, &alice]).await;
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    for _ in 0..4 {
        t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    }
    let pid = t.pid;
    let st = t.pool(&pool).await;
    assert_eq!(st.creator_owed, 4 * 2_500_000);
    // Not the creator.
    let i = ix::withdraw_creator_fees(&pid, &alice.pubkey(), &pool, 1);
    assert_eq!(t.send(vec![i], &[&alice]).await.unwrap_err(), ce(PoolError::NotCreator));
    // Zero and more than accrued.
    for amt in [0, st.creator_owed + 1, st.creator_owed + st.jackpot] {
        let i = ix::withdraw_creator_fees(&pid, &creator.pubkey(), &pool, amt);
        assert_eq!(t.send(vec![i], &[&creator]).await.unwrap_err(), ce(PoolError::InsufficientFees));
    }
    // Lock the jackpot in a drawn round: the creator still gets only fees.
    t.draw_pick(&pool, &alice, &|_| true).await.unwrap();
    let c0 = t.lamports(&creator.pubkey()).await;
    let i = ix::withdraw_creator_fees(&pid, &creator.pubkey(), &pool, 4_000_000);
    t.send(vec![i], &[&creator]).await.unwrap();
    let i = ix::withdraw_creator_fees(&pid, &creator.pubkey(), &pool, 6_000_000);
    t.send(vec![i], &[&creator]).await.unwrap();
    assert_eq!(t.lamports(&creator.pubkey()).await, c0 + 10_000_000);
    let i = ix::withdraw_creator_fees(&pid, &creator.pubkey(), &pool, 1);
    assert_eq!(t.send(vec![i], &[&creator]).await.unwrap_err(), ce(PoolError::InsufficientFees));
    let st2 = t.pool(&pool).await;
    assert_eq!((st2.creator_owed, st2.creator_withdrawn), (0, 10_000_000));
    assert_eq!(st2.locked_prize, st.jackpot);
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn retire_rules() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let mut t = T::new(&[&creator, &alice]).await;
    let pool = t.create(&creator, 1, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    let pid = t.pid;
    let a = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    // Reserve > 0 and no win yet.
    assert_eq!(
        t.send(vec![ix::retire(&pid, &creator.pubkey(), &pool)], &[&creator]).await.unwrap_err(),
        ce(PoolError::RetireNotAllowed)
    );
    assert_eq!(
        t.send(vec![ix::retire(&pid, &alice.pubkey(), &pool)], &[&alice]).await.unwrap_err(),
        ce(PoolError::NotCreator)
    );
    t.draw_pick(&pool, &alice, &|n| *n == nums(&[1, 2])).await.unwrap();
    // Round in its window.
    assert_eq!(
        t.send(vec![ix::retire(&pid, &creator.pubkey(), &pool)], &[&creator]).await.unwrap_err(),
        ce(PoolError::RetireNotAllowed)
    );
    t.claim(&pool, 0, &alice, &a, &[a.leaf]).await.unwrap();
    t.settle_after_window(&pool, 0).await.unwrap();
    // Winner settled but not paid yet.
    assert_eq!(
        t.send(vec![ix::retire(&pid, &creator.pubkey(), &pool)], &[&creator]).await.unwrap_err(),
        ce(PoolError::RetireNotAllowed)
    );
    t.payout(&pool, 0, 0, &alice.pubkey()).await.unwrap();
    let before = t.pool(&pool).await;
    t.send(vec![ix::retire(&pid, &creator.pubkey(), &pool)], &[&creator]).await.unwrap();
    let st = t.pool(&pool).await;
    assert!(st.retired);
    assert_eq!(st.jackpot + st.reserve, before.jackpot + before.reserve);
    assert_eq!(
        t.send(vec![ix::retire(&pid, &creator.pubkey(), &pool)], &[&creator]).await.unwrap_err(),
        ce(PoolError::AlreadyRetired)
    );
    // A retired pool keeps selling with no creator fee; the jackpot pays out
    // on the next win.
    // Round 1 closed during the window; roll it (no ticket) to open round 2.
    t.draw_pick(&pool, &alice, &|_| true).await.unwrap();
    let owed = t.pool(&pool).await.creator_owed;
    let s0 = t.pool(&pool).await;
    t.buy(&pool, &alice, &alice.pubkey(), nums(&[3, 4])).await.unwrap();
    let s1 = t.pool(&pool).await;
    assert_eq!(s1.creator_owed, owed);
    assert_eq!((s1.jackpot - s0.jackpot) + (s1.reserve - s0.reserve), SOL / 100);
    t.solvent(&pool, true).await;
}

// ── pre-funded addresses ────────────────────────────────────────────────────

#[tokio::test]
async fn prefunded_claim_pool_and_round_addresses_do_not_block() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let griefer = Keypair::new();
    let mut t = T::new(&[&creator, &alice, &griefer]).await;
    let pid = t.pid;
    // Pre-fund the pool address before creation.
    let pool = ix::pool_address(&pid, &creator.pubkey(), 9).0;
    t.send(vec![system_instruction::transfer(&griefer.pubkey(), &pool, 2_000_000)], &[&griefer]).await.unwrap();
    t.create(&creator, 9, params(2, 6, SOL / 100, 50_000_000)).await.unwrap();
    // The extra lamports are surplus; the invariant holds.
    t.solvent(&pool, false).await;
    let a = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    let b = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    // Pre-fund the round address before the draw.
    let rk = ix::round_address(&pid, &pool, 0).0;
    t.send(vec![system_instruction::transfer(&griefer.pubkey(), &rk, 1_000_000)], &[&griefer]).await.unwrap();
    t.draw_pick(&pool, &griefer, &|n| *n == nums(&[1, 2])).await.unwrap();
    // Pre-fund both claim addresses: one below and one above rent exemption.
    let c0 = ix::claim_address(&pid, &pool, 0, 0).0;
    let c1 = ix::claim_address(&pid, &pool, 0, 1).0;
    let rr = t.rent.minimum_balance(CLAIM_LEN);
    t.send(vec![system_instruction::transfer(&griefer.pubkey(), &c0, 1_000_000)], &[&griefer]).await.unwrap();
    t.send(vec![system_instruction::transfer(&griefer.pubkey(), &c1, rr + 5_000_000)], &[&griefer]).await.unwrap();
    let lv = leaves(&[a, b]);
    t.claim(&pool, 0, &alice, &a, &lv).await.unwrap();
    t.claim(&pool, 0, &alice, &b, &lv).await.unwrap();
    for c in [c0, c1] {
        let acct = t.account(&c).await.unwrap();
        assert_eq!(acct.owner, pid);
        assert!(ClaimRecord::unpack(&acct.data).is_some());
    }
    let prize = t.round(&pool, 0).await.unwrap().prize;
    t.settle_after_window(&pool, 0).await.unwrap();
    let share = t.round(&pool, 0).await.unwrap().share;
    assert_eq!(share, prize / 2);
    let before = t.lamports(&alice.pubkey()).await;
    t.payout(&pool, 0, 0, &alice.pubkey()).await.unwrap();
    t.payout(&pool, 0, 1, &alice.pubkey()).await.unwrap();
    // Alice gets both shares plus both records' lamports (rent she topped up
    // plus the griefer's transfers).
    assert_eq!(t.lamports(&alice.pubkey()).await, before + 2 * share + rr + rr + 5_000_000);
    t.solvent(&pool, false).await;
}

// ── second prize tier ───────────────────────────────────────────────────────

fn tier2_params(seed: u64) -> PoolParams {
    // k=2, n=6: C = 15. cap 6000 + fee 2500 + tier2 1000 <= 10000.
    let mut p = params(2, 6, SOL / 100, seed);
    p.cap_bps = 6_000;
    p.tier2_bps = 1_000;
    p
}

#[tokio::test]
async fn tier2_split_claim_payout_and_rollover() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let carol = Keypair::new();
    let mut t = T::new(&[&creator, &alice, &bob, &carol]).await;
    let pool = t.create(&creator, 1, tier2_params(50_000_000)).await.unwrap();
    let st = t.pool(&pool).await;
    assert_eq!((st.cap, st.tier2_cap, st.params.tier2_bps), (90_000_000, 15_000_000, 1_000));
    let a = t.buy(&pool, &alice, &alice.pubkey(), nums(&[1, 2])).await.unwrap();
    let b = t.buy(&pool, &bob, &bob.pubkey(), nums(&[1, 3])).await.unwrap();
    let c = t.buy(&pool, &bob, &bob.pubkey(), nums(&[2, 4])).await.unwrap();
    let d = t.buy(&pool, &carol, &carol.pubkey(), nums(&[5, 6])).await.unwrap();
    let st = t.pool(&pool).await;
    // Each 0.01 SOL ticket: 25% creator, 5% reserve, 10% tier 2, 60% jackpot.
    assert_eq!((st.creator_owed, st.reserve, st.tier2_pool), (10_000_000, 2_000_000, 4_000_000));
    assert_eq!(st.jackpot, 50_000_000 + 4 * 6_000_000);
    t.solvent(&pool, true).await;

    t.draw_pick(&pool, &carol, &|n| *n == nums(&[1, 2])).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.prize, r.tier2_prize), (74_000_000, 4_000_000));
    let st = t.pool(&pool).await;
    assert_eq!((st.tier2_pool, st.locked_prize), (0, 78_000_000));
    let lv = leaves(&[a, b, c, d]);
    // Carol matches nothing.
    assert_eq!(t.claim(&pool, 0, &carol, &d, &lv).await.unwrap_err(), ce(PoolError::TicketNotWinning));
    t.claim(&pool, 0, &alice, &a, &lv).await.unwrap();
    t.claim(&pool, 0, &bob, &b, &lv).await.unwrap();
    t.claim(&pool, 0, &bob, &c, &lv).await.unwrap();
    assert_eq!(t.claim(&pool, 0, &bob, &b, &lv).await.unwrap_err(), ce(PoolError::AlreadyClaimed));
    let pid = t.pid;
    for (idx, tier) in [(0u64, TIER_JACKPOT), (1, TIER_SECOND), (2, TIER_SECOND)] {
        let rec = ClaimRecord::unpack(&t.account(&ix::claim_address(&pid, &pool, 0, idx).0).await.unwrap().data).unwrap();
        assert_eq!(rec.tier, tier);
    }
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.winners, r.tier2_winners), (1, 2));
    t.settle_after_window(&pool, 0).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.share, r.tier2_share), (74_000_000, 2_000_000));
    let st = t.pool(&pool).await;
    assert_eq!((st.owed_prizes, st.locked_prize, st.tier2_pool), (78_000_000, 0, 0));
    // The jackpot paid out, so the reserve seeded the next jackpot.
    assert_eq!((st.jackpot, st.reserve), (2_000_000, 0));
    t.solvent(&pool, true).await;
    let rr = t.rent.minimum_balance(CLAIM_LEN);
    let (ab, bb) = (t.lamports(&alice.pubkey()).await, t.lamports(&bob.pubkey()).await);
    // Close refused while a tier-2 share is unpaid.
    t.payout(&pool, 0, 0, &alice.pubkey()).await.unwrap();
    t.payout(&pool, 0, 1, &bob.pubkey()).await.unwrap();
    assert_eq!(
        t.send(vec![ix::close_round(&pid, &pool, 0, &carol.pubkey())], &[]).await.unwrap_err(),
        ce(PoolError::RoundNotFinished)
    );
    t.payout(&pool, 0, 2, &bob.pubkey()).await.unwrap();
    assert_eq!(t.lamports(&alice.pubkey()).await, ab + 74_000_000 + rr);
    assert_eq!(t.lamports(&bob.pubkey()).await, bb + 2 * (2_000_000 + rr));
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.paid, r.tier2_paid), (1, 2));
    t.send(vec![ix::close_round(&pid, &pool, 0, &carol.pubkey())], &[]).await.unwrap();
    t.solvent(&pool, true).await;

    // Round 1 closed during the window: roll it, then round 2 has one ticket
    // with no tier-2 match. Its tier-2 pool rolls over to round 3.
    t.draw_pick(&pool, &carol, &|_| true).await.unwrap();
    let e = t.buy(&pool, &carol, &carol.pubkey(), nums(&[5, 6])).await.unwrap();
    let rid = t.pool(&pool).await.round_id;
    t.draw_pick(&pool, &carol, &|n| *n == nums(&[1, 2])).await.unwrap();
    assert_eq!(t.claim(&pool, rid, &carol, &e, &[e.leaf]).await.unwrap_err(), ce(PoolError::TicketNotWinning));
    let before = t.pool(&pool).await;
    let r = t.round(&pool, rid).await.unwrap();
    assert_eq!(r.tier2_prize, 1_000_000);
    t.settle_after_window(&pool, rid).await.unwrap();
    let st = t.pool(&pool).await;
    assert_eq!(st.tier2_pool, before.tier2_pool + 1_000_000);
    assert_eq!(t.round(&pool, rid).await.unwrap().tier2_share, 0);
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn tier2_split_with_dust_and_cap_overflow() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let mut t = T::new(&[&creator, &alice]).await;
    // Price 0.010000007 SOL: tier2 floor(10_000_007 * 0.1) = 1_000_000.
    let mut p = tier2_params(50_000_000);
    p.ticket_price = 10_000_007;
    let pool = t.create(&creator, 1, p).await.unwrap();
    let cap2 = t.pool(&pool).await.tier2_cap;
    assert_eq!(cap2, 15_000_010); // floor(1000 * 10_000_007 * 15 / 10_000)
    let mut tk = Vec::new();
    for i in 0..16u8 {
        let numbers = if i < 3 { nums(&[1, 3 + i]) } else { nums(&[5, 6]) };
        tk.push(t.buy(&pool, &alice, &alice.pubkey(), numbers).await.unwrap());
    }
    let st = t.pool(&pool).await;
    // 16 * 1_000_000 = 16_000_000 > cap: 999_990 overflowed to the reserve.
    assert_eq!(st.tier2_pool, cap2);
    let reserve_share = 10_000_007u64 * 500 / 10_000;
    let jackpot_overflow = st.reserve - 16 * reserve_share - (16_000_000 - cap2);
    assert!(jackpot_overflow > 0, "jackpot also reached its cap");
    t.solvent(&pool, true).await;
    // Three tier-2 winners split 15_000_010: share 5_000_003, dust 1 rolls over.
    t.draw_pick(&pool, &alice, &|n| *n == nums(&[1, 2])).await.unwrap();
    let lv = leaves(&tk);
    for x in &tk[..3] {
        t.claim(&pool, 0, &alice, x, &lv).await.unwrap();
    }
    t.settle_after_window(&pool, 0).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    assert_eq!((r.winners, r.tier2_winners, r.tier2_share), (0, 3, 5_000_003));
    let st = t.pool(&pool).await;
    assert_eq!(st.tier2_pool, 1);
    assert_eq!(st.owed_prizes, 15_000_009);
    for i in 0..3 {
        t.payout(&pool, 0, i, &alice.pubkey()).await.unwrap();
    }
    assert_eq!(t.pool(&pool).await.owed_prizes, 0);
    t.solvent(&pool, true).await;
}

#[tokio::test]
async fn tier2_parameter_bounds_and_v1_encoding() {
    let creator = Keypair::new();
    let mut t = T::new(&[&creator]).await;
    let pid = t.pid;
    // cap 7000 + fee 2500 + tier2 1000 > 10000.
    let mut p = tier2_params(50_000_000);
    p.cap_bps = 7_000;
    assert_eq!(t.create(&creator, 1, p).await.unwrap_err(), ce(PoolError::InvalidParams));
    // Tier 2 needs k >= 2.
    let mut p = params(1, 4, SOL / 100, 20_000_000);
    p.cap_bps = 6_000;
    p.tier2_bps = 1_000;
    assert_eq!(t.create(&creator, 1, p).await.unwrap_err(), ce(PoolError::InvalidParams));
    let mut p = tier2_params(10_000_000);
    p.tier2_bps = econ::MAX_TIER2_BPS + 1;
    p.cap_bps = 1_000;
    assert_eq!(t.create(&creator, 1, p).await.unwrap_err(), ce(PoolError::InvalidParams));
    // The v1 CreatePool encoding (no tier-2 field) creates a pool with tier 2 off.
    let i = ix::create_pool(&pid, &creator.pubkey(), 2, params(2, 6, SOL / 100, 50_000_000));
    assert_eq!(i.data.len(), ix::CREATE_POOL_LEN);
    t.send(vec![i], &[&creator]).await.unwrap();
    let pool = ix::pool_address(&pid, &creator.pubkey(), 2).0;
    let st = t.pool(&pool).await;
    assert_eq!((st.params.tier2_bps, st.tier2_cap, st.tier2_pool), (0, 0, 0));
    // The extended encoding carries tier2_bps.
    let i = ix::create_pool(&pid, &creator.pubkey(), 3, tier2_params(50_000_000));
    assert_eq!(i.data.len(), ix::CREATE_POOL_TIER2_LEN);
    t.send(vec![i], &[&creator]).await.unwrap();
    let pool = ix::pool_address(&pid, &creator.pubkey(), 3).0;
    assert_eq!(t.pool(&pool).await.params.tier2_bps, 1_000);
    // Wrong lengths are refused.
    let mut bad = ix::create_pool(&pid, &creator.pubkey(), 4, tier2_params(50_000_000));
    bad.data.push(0);
    assert_eq!(t.send(vec![bad], &[&creator]).await.unwrap_err(), ce(PoolError::InvalidInstruction));
}

// ── solvency fuzz ───────────────────────────────────────────────────────────

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }
}

fn random_numbers(rng: &mut Rng, k: u8, n: u8) -> [u8; 8] {
    let mut pool: Vec<u8> = (1..=n).collect();
    let mut out = Vec::new();
    for _ in 0..k {
        let i = rng.below(pool.len() as u64) as usize;
        out.push(pool.remove(i));
    }
    out.sort_unstable();
    nums(&out)
}

#[tokio::test]
async fn solvency_invariant_fuzz() {
    let cases: u64 = std::env::var("NLP_FUZZ_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(16);
    let steps: u64 = std::env::var("NLP_FUZZ_STEPS").ok().and_then(|v| v.parse().ok()).unwrap_or(120);
    let mut counts = [0u64; 10];
    let mut wins = 0u64;
    let mut tier2_wins = 0u64;
    for case in 0..cases {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15 ^ (case + 1));
        let creator = Keypair::new();
        let users: Vec<Keypair> = (0..4).map(|_| Keypair::new()).collect();
        let mut funded: Vec<&Keypair> = users.iter().collect();
        funded.push(&creator);
        let mut t = T::new(&funded).await;
        let pid = t.pid;

        // Random parameters within bounds; small C so that rounds have winners.
        // Half of the pools with k >= 2 run the second tier.
        let k = rng.range(1, 3) as u8;
        let n = rng.range(k as u64 + 1, k as u64 + 3) as u8;
        let fee_max = rng.range(0, 3_000) as u16;
        let fee_min = rng.range(0, fee_max as u64) as u16;
        let price = rng.range(10_000, 50_000_000);
        let combos = econ::binom(n, k).unwrap();
        let tier2 = if k >= 2 && rng.below(2) == 0 {
            rng.range(1, (9_000 - fee_max as u64).min(econ::MAX_TIER2_BPS as u64)) as u16
        } else {
            0
        };
        let max_cap = 10_000 - fee_max as u64 - tier2 as u64;
        let cap_bps = rng.range(1_000, max_cap) as u16;
        let cap = econ::jackpot_cap(cap_bps, price, combos).unwrap();
        let cap_bps = if cap < price { max_cap as u16 } else { cap_bps };
        let cap = econ::jackpot_cap(cap_bps, price, combos).unwrap();
        if cap < price {
            continue;
        }
        let p = PoolParams {
            seed: rng.range(price, cap),
            ticket_price: price,
            fee_max_bps: fee_max,
            fee_min_bps: fee_min,
            reserve_bps: rng.range(0, 2_000) as u16,
            cap_bps,
            pick_k: k,
            range_n: n,
            round_slots: 150,
            claim_window_slots: 150,
            tier2_bps: tier2,
        };
        let pool = t.create(&creator, case, p).await.unwrap();
        t.solvent(&pool, true).await;

        let mut paid_total = 0u64;
        let mut open: Vec<Tk> = Vec::new();
        // Drawn round in its window: (round_id, tickets, numbers, claimed indexes).
        let mut pending: Option<(u64, Vec<Tk>, [u8; 8], Vec<u64>)> = None;
        // Registered claims of settled rounds not yet paid: (round_id, index, owner).
        let mut unpaid: Vec<(u64, u64, Pubkey)> = Vec::new();
        // Settled rounds whose account is not closed yet.
        let mut closable: Vec<u64> = Vec::new();

        for _ in 0..steps {
            let action = rng.below(10);
            counts[action as usize] += 1;
            let st = t.pool(&pool).await;
            match action {
                0..=3 => {
                    let u = rng.below(4) as usize;
                    let numbers = random_numbers(&mut rng, k, n);
                    let r = t.buy(&pool, &users[u], &users[u].pubkey(), numbers).await;
                    if t.slot < st.round_close_slot {
                        open.push(r.unwrap());
                    } else {
                        assert_eq!(r.unwrap_err(), ce(PoolError::SalesClosed));
                    }
                }
                4 => {
                    if pending.is_some() {
                        let r = t.send(vec![ix::draw(&pid, &users[0].pubkey(), &pool, st.round_id)], &[&users[0]]).await;
                        assert_eq!(r.unwrap_err(), ce(PoolError::PreviousRoundUnsettled));
                        continue;
                    }
                    let t0 = st.round_close_slot + DRAW_DELAY_SLOTS;
                    // Sometimes the first target has aged out.
                    let aged = rng.below(4) == 0;
                    let seed = rng.next();
                    let (entries, slot): (Vec<_>, u64) = if aged {
                        let t1 = t0 + FALLBACK_STEP_SLOTS;
                        ((t0 + 50..t1 + 20).map(|s| (s, hashv(&[&seed.to_le_bytes(), &s.to_le_bytes()]).to_bytes())).collect(), t1 + 20)
                    } else {
                        ((t0 - 30..t0 + 5).map(|s| (s, hashv(&[&seed.to_le_bytes(), &s.to_le_bytes()]).to_bytes())).collect(), t0 + 5)
                    };
                    t.hashes(&entries);
                    let s = t.slot.max(slot);
                    t.warp(s).await;
                    t.send(vec![ix::draw(&pid, &users[1].pubkey(), &pool, st.round_id)], &[&users[1]]).await.unwrap();
                    if !open.is_empty() {
                        let r = t.round(&pool, st.round_id).await.unwrap();
                        assert_eq!(r.attempt, aged as u64);
                        pending = Some((st.round_id, std::mem::take(&mut open), r.numbers, Vec::new()));
                    }
                }
                5 => {
                    let Some((rid, tickets, drawn, claimed)) = pending.as_mut() else { continue };
                    // Half of the time aim at a winning ticket when one exists.
                    let winners: Vec<usize> = (0..tickets.len())
                        .filter(|&j| econ::prize_tier(&tickets[j].numbers, drawn, k, tier2 > 0) > 0)
                        .collect();
                    let i = if !winners.is_empty() && rng.below(2) == 0 {
                        winners[rng.below(winners.len() as u64) as usize]
                    } else {
                        rng.below(tickets.len() as u64) as usize
                    };
                    let tk = tickets[i];
                    let wrong_signer = rng.below(5) == 0;
                    let signer = if wrong_signer {
                        users.iter().find(|u| u.pubkey() != tk.owner).unwrap()
                    } else {
                        users.iter().find(|u| u.pubkey() == tk.owner).unwrap()
                    };
                    let lv = leaves(tickets);
                    let window_end = t.round(&pool, *rid).await.unwrap().window_end;
                    let res = t.claim(&pool, *rid, signer, &tk, &lv).await;
                    let expected = if t.slot > window_end {
                        Err(ce(PoolError::ClaimWindowClosed))
                    } else if econ::prize_tier(&tk.numbers, drawn, k, tier2 > 0) == 0 {
                        Err(ce(PoolError::TicketNotWinning))
                    } else if wrong_signer {
                        Err(ce(PoolError::InvalidProof))
                    } else if claimed.contains(&tk.index) {
                        Err(ce(PoolError::AlreadyClaimed))
                    } else {
                        Ok(())
                    };
                    assert_eq!(res, expected);
                    if res.is_ok() {
                        claimed.push(tk.index);
                    }
                }
                6 => {
                    let Some((rid, tickets, _, claimed)) = pending.take() else { continue };
                    t.settle_after_window(&pool, rid).await.unwrap();
                    for idx in &claimed {
                        unpaid.push((rid, *idx, tickets[*idx as usize].owner));
                    }
                    if !claimed.is_empty() {
                        wins += 1;
                    }
                    let r = t.round(&pool, rid).await.unwrap();
                    if r.tier2_winners > 0 {
                        tier2_wins += 1;
                    }
                    closable.push(rid);
                }
                7 => {
                    if unpaid.is_empty() {
                        continue;
                    }
                    let i = rng.below(unpaid.len() as u64) as usize;
                    let (rid, idx, owner) = unpaid.swap_remove(i);
                    let before = t.lamports(&owner).await;
                    let share = t.payout_amount(&pool, rid, idx).await;
                    t.payout(&pool, rid, idx, &owner).await.unwrap();
                    assert!(t.lamports(&owner).await >= before + share);
                    paid_total += share;
                }
                8 => {
                    let amt = rng.range(0, st.creator_owed + st.creator_owed / 5 + 1);
                    let r = t.send(vec![ix::withdraw_creator_fees(&pid, &creator.pubkey(), &pool, amt)], &[&creator]).await;
                    if amt > 0 && amt <= st.creator_owed {
                        r.unwrap();
                    } else {
                        assert_eq!(r.unwrap_err(), ce(PoolError::InsufficientFees));
                    }
                }
                _ => {
                    // Attacks and housekeeping.
                    match rng.below(4) {
                        0 => {
                            let amt = st.jackpot.max(1);
                            let r = t.send(vec![ix::withdraw_creator_fees(&pid, &users[2].pubkey(), &pool, amt)], &[&users[2]]).await;
                            assert_eq!(r.unwrap_err(), ce(PoolError::NotCreator));
                        }
                        1 => {
                            let r = t.send(vec![ix::retire(&pid, &creator.pubkey(), &pool)], &[&creator]).await;
                            let allowed = !st.retired
                                && !st.has_pending
                                && st.owed_prizes == 0
                                && (st.last_settle_won || st.reserve == 0);
                            if allowed {
                                r.unwrap();
                            } else if st.retired {
                                assert_eq!(r.unwrap_err(), ce(PoolError::AlreadyRetired));
                            } else {
                                assert_eq!(r.unwrap_err(), ce(PoolError::RetireNotAllowed));
                            }
                        }
                        _ => {
                            if let Some(pos) = closable.iter().position(|_| true) {
                                let rid = closable[pos];
                                let r = t.round(&pool, rid).await.unwrap();
                                let res = t.send(vec![ix::close_round(&pid, &pool, rid, &Pubkey::new_from_array(r.rent_payer))], &[]).await;
                                if r.paid == r.winners && r.tier2_paid == r.tier2_winners {
                                    res.unwrap();
                                    closable.remove(pos);
                                } else {
                                    assert_eq!(res.unwrap_err(), ce(PoolError::RoundNotFinished));
                                }
                            }
                        }
                    }
                }
            }
            t.solvent(&pool, true).await;
        }

        // Wind down: settle, pay everyone, withdraw all fees.
        if let Some((rid, tickets, _, claimed)) = pending.take() {
            t.settle_after_window(&pool, rid).await.unwrap();
            for idx in claimed {
                unpaid.push((rid, idx, tickets[idx as usize].owner));
            }
        }
        for (rid, idx, owner) in unpaid.drain(..) {
            paid_total += t.payout_amount(&pool, rid, idx).await;
            t.payout(&pool, rid, idx, &owner).await.unwrap();
        }
        let st = t.pool(&pool).await;
        if st.creator_owed > 0 {
            t.send(vec![ix::withdraw_creator_fees(&pid, &creator.pubkey(), &pool, st.creator_owed)], &[&creator]).await.unwrap();
        }
        let st = t.pool(&pool).await;
        assert_eq!((st.owed_prizes, st.locked_prize, st.creator_owed), (0, 0, 0));
        assert_eq!(
            t.lamports(&pool).await,
            t.rent.minimum_balance(POOL_LEN) + st.jackpot + st.reserve + st.tier2_pool
        );
        // Lifetime conservation: seed + sales = jackpot + reserve + tier-2 pool
        // + creator withdrawals + prizes paid.
        assert_eq!(
            st.jackpot + st.reserve + st.tier2_pool + st.creator_withdrawn + paid_total,
            st.params.seed + st.total_sales
        );
    }
    println!(
        "fuzz: cases={cases} steps={steps} action_counts={counts:?} winning_rounds={wins} tier2_rounds={tier2_wins}"
    );
    assert!(wins > 0, "the fuzz never exercised a win");
    assert!(tier2_wins > 0, "the fuzz never exercised a tier-2 win");
}

// ── compute units ───────────────────────────────────────────────────────────

#[tokio::test]
async fn compute_units_buy_and_claim() {
    let creator = Keypair::new();
    let alice = Keypair::new();
    let mut t = T::new(&[&creator, &alice]).await;
    let pid = t.pid;
    // k=2, n=10 (C=45): the per-ticket cost does not depend on the odds.
    let pool = t.create(&creator, 1, params(2, 10, SOL / 100, SOL / 10)).await.unwrap();
    let mut tickets = Vec::new();
    let mut buy_cu = Vec::new();
    for i in 0..8u8 {
        let p = t.pool(&pool).await;
        let numbers = nums(&[1, 2 + i]);
        let i1 = ix::buy_ticket(&pid, &alice.pubkey(), &pool, p.round_id, &alice.pubkey(), numbers);
        buy_cu.push(t.cu(vec![i1], &[&alice]).await);
        tickets.push(t.buy(&pool, &alice, &alice.pubkey(), numbers).await.unwrap());
    }
    let target = tickets[5].numbers;
    let p = t.pool(&pool).await;
    let t0 = p.round_close_slot + DRAW_DELAY_SLOTS;
    let (h, _) = grind(&pool, &p, 0, t0, t0, &|n| *n == target);
    let entries: Vec<_> = (t0 - 400..t0 + 100).map(|s| (s, if s == t0 { h } else { filler(s) })).collect();
    t.hashes(&entries);
    t.warp(t0 + 100).await;
    let draw_cu = t.cu(vec![ix::draw(&pid, &creator.pubkey(), &pool, 0)], &[&creator]).await;
    t.send(vec![ix::draw(&pid, &creator.pubkey(), &pool, 0)], &[&creator]).await.unwrap();
    let lv = leaves(&tickets);
    let claim_ix = ix::claim(&pid, &alice.pubkey(), &pool, 0, 5, target, tree::proof_of(&lv, 5));
    let claim_cu = t.cu(vec![claim_ix.clone()], &[&alice]).await;
    t.send(vec![claim_ix], &[&alice]).await.unwrap();
    let r = t.round(&pool, 0).await.unwrap();
    t.warp(r.window_end + 1).await;
    let settle_cu = t.cu(vec![ix::settle(&pid, &pool, 0)], &[]).await;
    t.send(vec![ix::settle(&pid, &pool, 0)], &[]).await.unwrap();
    let payout_cu = t.cu(vec![ix::payout(&pid, &pool, 0, 5, &alice.pubkey())], &[]).await;
    let mode = if T::sbf() { "sbf" } else { "native" };
    println!(
        "CU[{mode}] buy={:?} draw={draw_cu} claim={claim_cu} settle={settle_cu} payout={payout_cu}",
        buy_cu
    );
    let max_buy = *buy_cu.iter().max().unwrap();
    assert!(max_buy < 200_000 && claim_cu < 200_000 && draw_cu < 200_000);
    if T::sbf() {
        assert!(max_buy < 60_000, "buy CU {max_buy}");
        assert!(claim_cu < 60_000, "claim CU {claim_cu}");
    }
    assert_eq!(r.status, ROUND_DRAWN);
}
