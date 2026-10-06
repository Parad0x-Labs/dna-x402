// End-to-end tests of null_fair_draw through solana-program-test.
//
// By default the native processor runs. Run against the SBF binary with
// `SBF_OUT_DIR=<dir with null_fair_draw.so> cargo test`; the compute-unit test
// then reports metered CU.
#![cfg(not(target_os = "windows"))]

use null_fair_draw::{
    error::DrawError,
    instruction::{self as ix, CreateParams, LeafProof},
    state::{
        Draw, Entrant, Slot, Tier, MODE_LIST, MODE_OPEN, SLOT_CLAIMED, SLOT_FORFEITED, SLOT_VOID, SLOT_WON,
        STATUS_AWAIT_DRAW, STATUS_COMPLETE, STATUS_FUNDED, STATUS_RESOLVING,
    },
    stream,
    sumtree::{self, Pair, OPEN_DEPTH},
    token::{self, TOKEN_PROGRAM_ID},
};
use null_draw_common::slot_hashes::{encode_slot_hashes, DRAW_DELAY_SLOTS, FALLBACK_STEP_SLOTS};
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

fn ce(e: DrawError) -> InstructionError {
    InstructionError::Custom(e.code())
}

fn filler(slot: u64) -> [u8; 32] {
    hashv(&[b"filler", &slot.to_le_bytes()]).to_bytes()
}

fn tiers(v: &[(u32, u64)]) -> Vec<Tier> {
    v.iter().map(|&(count, amount)| Tier { count, amount }).collect()
}

fn open_params(close_slot: u64, weighted: bool, tiers: Vec<Tier>, redraw: u8) -> CreateParams {
    CreateParams {
        mode: MODE_OPEN,
        weighted,
        redraw_rounds: redraw,
        tiers,
        entry_price: 0,
        wallet_cap: 0,
        close_slot,
        claim_window_slots: 150,
        prize_mint: [0; 32],
        entry_mint: [0; 32],
        fee_dest: [0; 32],
    }
}

fn list_params(weighted: bool, tiers: Vec<Tier>, redraw: u8, prize_mint: Option<Pubkey>) -> CreateParams {
    CreateParams {
        mode: MODE_LIST,
        weighted,
        redraw_rounds: redraw,
        tiers,
        entry_price: 0,
        wallet_cap: 0,
        close_slot: 0,
        claim_window_slots: 150,
        prize_mint: prize_mint.map(|m| m.to_bytes()).unwrap_or([0; 32]),
        entry_mint: [0; 32],
        fee_dest: [0; 32],
    }
}

/// An off-chain entry list: (wallet, weight) in leaf order.
#[derive(Clone)]
struct List {
    draw: Pubkey,
    entries: Vec<(Pubkey, u64)>,
    depth: usize,
}

impl List {
    fn pairs(&self) -> Vec<Pair> {
        self.entries.iter().map(|(w, x)| (sumtree::leaf(&self.draw.to_bytes(), &w.to_bytes(), *x), *x)).collect()
    }
    fn root(&self) -> Pair {
        sumtree::root_of(&self.pairs(), self.depth)
    }
    fn proof(&self, i: usize) -> LeafProof {
        let (w, x) = self.entries[i];
        LeafProof {
            leaf_index: i as u64,
            wallet: w.to_bytes(),
            weight: x,
            path: sumtree::proof_of(&self.pairs(), self.depth, i),
        }
    }
    fn weights(&self) -> Vec<u64> {
        self.entries.iter().map(|e| e.1).collect()
    }
    /// Leaf index containing point p.
    fn leaf_at(&self, p: u64) -> usize {
        let mut acc = 0;
        for (i, (_, w)) in self.entries.iter().enumerate() {
            if *w > 0 && p < acc + w {
                return i;
            }
            acc += w;
        }
        panic!("point beyond total")
    }
}

struct T {
    ctx: ProgramTestContext,
    pid: Pubkey,
    n: u32,
    slot: u64,
    rent: Rent,
}

impl T {
    async fn new(funded: &[&Keypair], extra: Vec<(Pubkey, Account)>) -> Self {
        let pid = null_fair_draw::id();
        let mut pt = ProgramTest::new("null_fair_draw", pid, processor!(null_fair_draw::process_instruction));
        for k in funded {
            pt.add_account(k.pubkey(), Account::new(10_000 * SOL, 0, &system_program::id()));
        }
        for (k, a) in extra {
            pt.add_account(k, a);
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
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000 - self.n)];
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
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend(ixs);
        let payer = self.ctx.payer.insecure_clone();
        let mut s: Vec<&Keypair> = vec![&payer];
        s.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&all, Some(&payer.pubkey()), &s, self.ctx.last_blockhash);
        let r = self.ctx.banks_client.simulate_transaction(tx).await.unwrap();
        r.result.unwrap().unwrap();
        // Subtract the compute budget instruction (150 CU).
        r.simulation_details.unwrap().units_consumed - 150
    }

    async fn account(&mut self, k: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*k).await.unwrap()
    }

    async fn lamports(&mut self, k: &Pubkey) -> u64 {
        self.account(k).await.map(|a| a.lamports).unwrap_or(0)
    }

    async fn draw_state(&mut self, k: &Pubkey) -> (Draw, Vec<u8>) {
        let a = self.account(k).await.expect("draw account");
        (Draw::unpack(&a.data).expect("draw layout"), a.data)
    }

    async fn slots(&mut self, k: &Pubkey) -> Vec<Slot> {
        let (d, data) = self.draw_state(k).await;
        (0..d.slot_count as usize).map(|i| d.read_slot(&data, i)).collect()
    }

    async fn token_amount(&mut self, k: &Pubkey) -> u64 {
        let a = self.account(k).await.unwrap();
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    /// Prize solvency as the program defines it; `exact` also forbids surplus.
    async fn solvent(&mut self, draw: &Pubkey, exact: bool) {
        let (d, data) = self.draw_state(draw).await;
        let lam = self.lamports(draw).await;
        let rent = self.rent.minimum_balance(data.len());
        let out = d.outstanding().unwrap();
        if d.is_sol_prize() {
            assert!(lam >= rent + out, "insolvent: {lam} < {rent} + {out}");
            if exact {
                assert_eq!(lam, rent + out, "unexpected surplus");
            }
        } else {
            let v = ix::vault_address(&self.pid, draw).0;
            let amt = self.token_amount(&v).await;
            assert!(amt >= out, "vault {amt} < {out}");
            if exact {
                assert_eq!(amt, out);
            }
        }
        assert!(d.refundable <= out, "refundable above outstanding");
        assert!(d.paid + d.returned <= d.funded);
    }

    async fn create(&mut self, org: &Keypair, id: u64, p: CreateParams) -> Result<Pubkey, InstructionError> {
        let pid = self.pid;
        self.send(ix::create_draw_with_extends(&pid, &org.pubkey(), id, p), &[org]).await?;
        Ok(ix::draw_address(&pid, &org.pubkey(), id).0)
    }

    async fn fund(&mut self, funder: &Keypair, draw: &Pubkey, token: Option<&Pubkey>) -> Result<(), InstructionError> {
        let pid = self.pid;
        self.send(vec![ix::fund_prizes(&pid, &funder.pubkey(), draw, token)], &[funder]).await
    }

    async fn enter(&mut self, who: &Keypair, draw: &Pubkey, count: u32) -> Result<(), InstructionError> {
        let pid = self.pid;
        let (d, _) = self.draw_state(draw).await;
        let fee = Pubkey::new_from_array(d.fee_dest);
        self.send(vec![ix::enter(&pid, &who.pubkey(), draw, &who.pubkey(), count, &fee, None)], &[who]).await
    }

    /// Set SlotHashes so the round's initial target holds `h`, warp past it and crank Draw.
    async fn draw_with(&mut self, draw: &Pubkey, h: [u8; 32]) -> Result<(), InstructionError> {
        let (d, _) = self.draw_state(draw).await;
        let t0 = d.rounds[d.round as usize].first_target;
        let t0 = if t0 == 0 { d.close_slot + DRAW_DELAY_SLOTS } else { t0 };
        let entries: Vec<_> = (t0 - 20..=t0 + 3).map(|s| (s, if s == t0 { h } else { filler(s) })).collect();
        self.hashes(&entries);
        let s = self.slot.max(t0 + 3);
        self.warp(s).await;
        let pid = self.pid;
        self.send(vec![ix::draw(&pid, draw)], &[]).await
    }

    async fn resolve(&mut self, draw: &Pubkey, max: u8, proofs: Vec<LeafProof>) -> Result<(), InstructionError> {
        let pid = self.pid;
        self.send(vec![ix::resolve(&pid, draw, max, proofs)], &[]).await
    }

    /// Resolve every pending slot of the current round from the list.
    async fn resolve_all(&mut self, draw: &Pubkey, list: &List) {
        loop {
            let (d, data) = self.draw_state(draw).await;
            if d.next_slot >= d.slot_count {
                break;
            }
            if d.weighted {
                let j = d.next_slot as usize;
                let rem = d.total_weight - d.won_weight;
                if rem == 0 {
                    self.resolve(draw, 1, vec![]).await.unwrap();
                    continue;
                }
                let u = stream::point(&d.rounds[d.round as usize].seed, j as u64, rem);
                let p = stream::remap(u, (0..d.won_count as usize).map(|k| d.won_at(&data, k))).unwrap();
                let leaf = list.leaf_at(p);
                self.resolve(draw, 1, vec![list.proof(leaf)]).await.unwrap();
            } else {
                self.resolve(draw, 0, vec![]).await.unwrap();
            }
        }
    }

    async fn claim(&mut self, w: &Keypair, draw: &Pubkey, slot: u16, proof: Option<LeafProof>, token: Option<&Pubkey>) -> Result<(), InstructionError> {
        let pid = self.pid;
        self.send(vec![ix::claim(&pid, &w.pubkey(), draw, slot, proof, token)], &[w]).await
    }

    async fn advance_after_window(&mut self, draw: &Pubkey) -> Result<(), InstructionError> {
        let (d, _) = self.draw_state(draw).await;
        let s = self.slot.max(d.window_end + 1);
        self.warp(s).await;
        let pid = self.pid;
        self.send(vec![ix::advance(&pid, draw)], &[]).await
    }
}

/// Grind a slot hash so that the draw's round seed satisfies `pick` on the
/// resolved winners (reference draw over `weights`).
fn grind(draw: &Pubkey, d: &Draw, t0: u64, weights: &[u64], already: &[usize], slots: usize, pick: &dyn Fn(&[Option<usize>]) -> bool) -> [u8; 32] {
    for i in 0u64..200_000 {
        let h = hashv(&[b"test-slot-hash", &i.to_le_bytes()]).to_bytes();
        let seed = stream::seed(&draw.to_bytes(), d.round, t0, t0, &h, &d.root, d.total_weight, d.leaf_count);
        let w = stream::reference_draw(weights, already, &seed, d.slot_count as u64 - slots as u64, slots);
        if pick(&w) {
            return h;
        }
    }
    panic!("no slot hash satisfies the predicate");
}

fn kp(n: usize) -> Vec<Keypair> {
    (0..n).map(|_| Keypair::new()).collect()
}

// ── open raffle, unweighted, SOL ────────────────────────────────────────────

#[tokio::test]
async fn open_raffle_full_flow_with_redraw_and_reclaim() {
    let org = Keypair::new();
    let users = kp(6);
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    let mut t = T::new(&funded, vec![]).await;
    let pid = t.pid;
    // 1 x 1 SOL, 2 x 0.1 SOL; one re-draw round.
    let p = open_params(1_200, false, tiers(&[(1, SOL), (2, SOL / 10)]), 1);
    let draw = t.create(&org, 7, p).await.unwrap();
    // Entries are refused until the prizes are escrowed.
    assert_eq!(t.enter(&users[0], &draw, 1).await.unwrap_err(), ce(DrawError::WrongStatus));
    t.fund(&org, &draw, None).await.unwrap();
    t.solvent(&draw, true).await;
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.total_prize, d.funded, d.capacity, d.slot_count), (STATUS_FUNDED, 1_200_000_000, 1_200_000_000, 6, 3));
    // Six entrants; user 0 enters twice (two leaves).
    let mut list = List { draw, entries: vec![], depth: OPEN_DEPTH };
    for (i, u) in users.iter().enumerate() {
        t.enter(u, &draw, 1).await.unwrap();
        list.entries.push((u.pubkey(), 1));
        if i == 0 {
            t.enter(u, &draw, 1).await.unwrap();
            list.entries.push((u.pubkey(), 1));
        }
    }
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.leaf_count, d.total_weight), (7, 7));
    assert_eq!((d.root, d.total_weight), list.root());
    // Draw refused before the close slot.
    assert_eq!(t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::EntriesOpen));
    t.warp(1_200).await;
    assert_eq!(t.enter(&users[1], &draw, 1).await.unwrap_err(), ce(DrawError::EntriesClosed));
    // Pick a hash whose three round-0 winners are three distinct leaves (always).
    let (d, _) = t.draw_state(&draw).await;
    let t0 = 1_200 + DRAW_DELAY_SLOTS;
    let h = grind(&draw, &d, t0, &list.weights(), &[], 3, &|w| w.iter().all(|x| x.is_some()));
    t.draw_with(&draw, h).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!(d.status, STATUS_RESOLVING);
    let seed = d.rounds[0].seed;
    let expect = stream::reference_draw(&list.weights(), &[], &seed, 0, 3);
    // One crank resolves all three (no proofs needed when unweighted).
    t.resolve(&draw, 0, vec![]).await.unwrap();
    assert_eq!(t.resolve(&draw, 0, vec![]).await.unwrap_err(), ce(DrawError::NothingToResolve));
    let slots = t.slots(&draw).await;
    let won: Vec<usize> = slots.iter().map(|s| s.leaf_index as usize).collect();
    assert_eq!(won, expect.iter().map(|x| x.unwrap()).collect::<Vec<_>>(), "on-chain winners = reference");
    assert!(slots.iter().all(|s| s.status == SLOT_WON && s.wallet == [0; 32]));
    // Winners of slots 0 and 1 claim with their proof; slot 2 does not claim.
    for j in 0..2u16 {
        let leaf = won[j as usize];
        let who = users.iter().find(|u| u.pubkey() == list.entries[leaf].0).unwrap();
        let before = t.lamports(&who.pubkey()).await;
        t.claim(who, &draw, j, Some(list.proof(leaf)), None).await.unwrap();
        let amount = if j == 0 { SOL } else { SOL / 10 };
        assert_eq!(t.lamports(&who.pubkey()).await, before + amount);
        t.solvent(&draw, true).await;
    }
    // Advance refused during the window, then re-draw round 1 for slot 2.
    assert_eq!(t.send(vec![ix::advance(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::ClaimWindowOpen));
    let (d, _) = t.draw_state(&draw).await;
    let window_end = d.window_end;
    t.advance_after_window(&draw).await.unwrap();
    let (d, data) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.round, d.slot_count, d.round_first_slot), (STATUS_AWAIT_DRAW, 1, 4, 3));
    assert_eq!(d.rounds[1].first_target, window_end + DRAW_DELAY_SLOTS);
    assert_eq!(d.read_slot(&data, 2).status, SLOT_FORFEITED);
    assert_eq!(d.read_slot(&data, 3).tier, 1);
    // The forfeited winner cannot claim any more.
    let leaf2 = won[2];
    let who2 = users.iter().find(|u| u.pubkey() == list.entries[leaf2].0).unwrap();
    assert_eq!(t.claim(who2, &draw, 2, Some(list.proof(leaf2)), None).await.unwrap_err(), ce(DrawError::WrongStatus));
    // Round 1 draws among the four leaves that have not won.
    let h1 = hashv(&[b"round-1"]).to_bytes();
    t.draw_with(&draw, h1).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    let e1 = stream::reference_draw(&list.weights(), &won, &d.rounds[1].seed, 3, 1)[0].unwrap();
    assert!(!won.contains(&e1));
    t.resolve(&draw, 0, vec![]).await.unwrap();
    let s3 = t.slots(&draw).await[3];
    assert_eq!(s3.leaf_index as usize, e1);
    // Nobody claims: the last round ends and the prize is refundable.
    t.advance_after_window(&draw).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.refundable, d.paid), (STATUS_COMPLETE, SOL / 10, SOL + SOL / 10));
    t.solvent(&draw, true).await;
    // Reclaim: organizer only.
    assert_eq!(
        t.send(vec![ix::reclaim(&pid, &users[0].pubkey(), &draw, None)], &[&users[0]]).await.unwrap_err(),
        ce(DrawError::NotOrganizer)
    );
    let ob = t.lamports(&org.pubkey()).await;
    t.send(vec![ix::reclaim(&pid, &org.pubkey(), &draw, None)], &[&org]).await.unwrap();
    assert_eq!(t.lamports(&org.pubkey()).await, ob + SOL / 10);
    let (d, _) = t.draw_state(&draw).await;
    // Prize conservation: every lamport escrowed was paid or returned.
    assert_eq!(d.paid + d.returned, d.funded);
    t.solvent(&draw, true).await;
    // Close returns the rent.
    let rent = t.lamports(&draw).await;
    let ob = t.lamports(&org.pubkey()).await;
    t.send(vec![ix::close(&pid, &org.pubkey(), &draw, None)], &[&org]).await.unwrap();
    assert_eq!(t.lamports(&org.pubkey()).await, ob + rent);
    assert!(t.account(&draw).await.is_none());
}

// ── committed list, weighted, SPL ───────────────────────────────────────────

#[tokio::test]
async fn committed_list_weighted_spl_with_proof_edges() {
    let org = Keypair::new();
    let cranker = Keypair::new();
    let users = kp(5);
    let mint = Pubkey::new_unique();
    let org_token = Pubkey::new_unique();
    let mut extra = vec![
        (mint, Account { lamports: SOL, data: token::pack_mint(1_000_000, 6), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
        (org_token, Account { lamports: SOL, data: token::pack_account(&mint, &org.pubkey(), 1_000_000), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
    ];
    let user_tokens: Vec<Pubkey> = users.iter().map(|_| Pubkey::new_unique()).collect();
    for (u, k) in users.iter().zip(&user_tokens) {
        extra.push((*k, Account { lamports: SOL, data: token::pack_account(&mint, &u.pubkey(), 0), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }));
    }
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    funded.push(&cranker);
    let mut t = T::new(&funded, extra).await;
    let pid = t.pid;
    // 3 prizes: 500, 100, 100 tokens. No re-draw.
    let draw = t.create(&org, 1, list_params(true, tiers(&[(1, 500), (2, 100)]), 0, Some(mint))).await.unwrap();
    let vault = ix::vault_address(&pid, &draw).0;
    assert_eq!(t.account(&vault).await.unwrap().owner, TOKEN_PROGRAM_ID);
    // Commit refused before funding.
    assert_eq!(
        t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, [1; 32], 10, 5, 3)], &[&org]).await.unwrap_err(),
        ce(DrawError::WrongStatus)
    );
    t.fund(&org, &draw, Some(&org_token)).await.unwrap();
    assert_eq!(t.token_amount(&vault).await, 700);
    t.solvent(&draw, true).await;
    // List: weights 3, 4, 1, 7, 5 (total 20), depth 3.
    let list = List { draw, entries: users.iter().zip([3u64, 4, 1, 7, 5]).map(|(u, w)| (u.pubkey(), w)).collect(), depth: 3 };
    let (root, total) = list.root();
    // Bad parameters: unweighted count mismatch is checked for unweighted only; depth 0, count above 2^depth.
    for (c, dep) in [(5u64, 0u8), (9, 3), (0, 3)] {
        assert_eq!(
            t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, c, dep)], &[&org]).await.unwrap_err(),
            ce(DrawError::InvalidParams)
        );
    }
    assert_eq!(
        t.send(vec![ix::commit_list(&pid, &users[0].pubkey(), &draw, root, total, 5, 3)], &[&users[0]]).await.unwrap_err(),
        ce(DrawError::NotOrganizer)
    );
    t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, 5, 3)], &[&org]).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.depth, d.leaf_count, d.total_weight), (STATUS_AWAIT_DRAW, 3, 5, 20));
    // Cancel is refused once the target is fixed.
    assert_eq!(
        t.send(vec![ix::cancel(&pid, &org.pubkey(), &draw, Some(&org_token))], &[&org]).await.unwrap_err(),
        ce(DrawError::WrongStatus)
    );
    // Grind: slot 0 lands on point 0 (leaf 0, its lowest point), slot 1 on
    // the last leaf, slot 2 anywhere.
    let t0 = d.rounds[0].first_target;
    let weights = list.weights();
    let h = grind(&draw, &d, t0, &weights, &[], 3, &|w| w[0] == Some(0) && w[1] == Some(4));
    t.draw_with(&draw, h).await.unwrap();
    let (d, data) = t.draw_state(&draw).await;
    let seed = d.rounds[0].seed;
    let u0 = stream::point(&seed, 0, 20);
    assert!(u0 < 3, "point in leaf 0's interval [0, 3)");
    // A weighted Resolve needs a proof.
    assert_eq!(t.resolve(&draw, 1, vec![]).await.unwrap_err(), ce(DrawError::MissingProof));
    // The neighbour leaf's proof does not contain the point.
    assert_eq!(t.resolve(&draw, 1, vec![list.proof(1)]).await.unwrap_err(), ce(DrawError::PointNotInLeaf));
    // A tampered proof fails.
    let mut bad = list.proof(0);
    bad.path[0] ^= 1;
    assert_eq!(t.resolve(&draw, 1, vec![bad]).await.unwrap_err(), ce(DrawError::InvalidProof));
    let mut bad = list.proof(0);
    bad.weight = 4;
    assert_eq!(t.resolve(&draw, 1, vec![bad]).await.unwrap_err(), ce(DrawError::InvalidProof));
    // Extra unused proofs are refused.
    assert_eq!(
        t.resolve(&draw, 1, vec![list.proof(0), list.proof(0)]).await.unwrap_err(),
        ce(DrawError::InvalidInstruction)
    );
    let _ = data;
    // Anyone (the cranker) resolves with the public list.
    t.resolve_all(&draw, &list).await;
    let slots = t.slots(&draw).await;
    let expect = stream::reference_draw(&weights, &[], &seed, 0, 3);
    let got: Vec<Option<usize>> = slots.iter().map(|s| Some(s.leaf_index as usize)).collect();
    assert_eq!(got, expect);
    assert_eq!((slots[0].start, slots[0].weight), (0, 3));
    assert_eq!((slots[1].start, slots[1].weight), (15, 5));
    let (d, data) = t.draw_state(&draw).await;
    assert_eq!(d.won_weight, 3 + 5 + slots[2].weight);
    let ordered: Vec<(u64, u64)> = (0..3).map(|k| d.won_at(&data, k)).collect();
    assert!(ordered.windows(2).all(|w| w[0].0 < w[1].0));
    // Claims: wrong owner, wrong token account owner, then the winners.
    let w0 = &users[0];
    assert_eq!(t.claim(&users[1], &draw, 0, None, Some(&user_tokens[1])).await.unwrap_err(), ce(DrawError::NotWinner));
    assert_eq!(t.claim(w0, &draw, 0, None, Some(&user_tokens[1])).await.unwrap_err(), ce(DrawError::InvalidTokenAccount));
    t.claim(w0, &draw, 0, None, Some(&user_tokens[0])).await.unwrap();
    assert_eq!(t.token_amount(&user_tokens[0]).await, 500);
    assert_eq!(t.claim(w0, &draw, 0, None, Some(&user_tokens[0])).await.unwrap_err(), ce(DrawError::AlreadyClaimed));
    t.claim(&users[4], &draw, 1, None, Some(&user_tokens[4])).await.unwrap();
    assert_eq!(t.token_amount(&user_tokens[4]).await, 100);
    t.solvent(&draw, true).await;
    // Slot 2's winner does not claim: no re-draw round, the prize is returned.
    t.advance_after_window(&draw).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.refundable), (STATUS_COMPLETE, 100));
    let w2 = slots[2].leaf_index as usize;
    assert_eq!(
        t.claim(&users[w2], &draw, 2, None, Some(&user_tokens[w2])).await.unwrap_err(),
        ce(DrawError::WrongStatus)
    );
    t.send(vec![ix::reclaim(&pid, &org.pubkey(), &draw, Some(&org_token))], &[&org]).await.unwrap();
    assert_eq!(t.token_amount(&org_token).await, 1_000_000 - 600);
    // Close sweeps the vault and closes both accounts.
    t.send(vec![ix::close(&pid, &org.pubkey(), &draw, Some(&org_token))], &[&org]).await.unwrap();
    assert!(t.account(&draw).await.is_none());
    assert!(t.account(&vault).await.is_none());
}

// ── duplicate winners, zero weight, void slots ──────────────────────────────

#[tokio::test]
async fn heavy_leaf_wins_once_and_zero_weight_is_rejected() {
    let org = Keypair::new();
    let users = kp(4);
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    let mut t = T::new(&funded, vec![]).await;
    let pid = t.pid;
    // Four prizes over: whale weight 1000, two small leaves, one zero-weight leaf.
    let draw = t.create(&org, 2, list_params(true, tiers(&[(4, 1_000_000)]), 0, None)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    let list = List { draw, entries: vec![(users[0].pubkey(), 1_000), (users[1].pubkey(), 1), (users[2].pubkey(), 0), (users[3].pubkey(), 2)], depth: 2 };
    let (root, total) = list.root();
    t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, 4, 2)], &[&org]).await.unwrap();
    // The zero-weight leaf cannot even be shown as a receipt.
    assert_eq!(t.send(vec![ix::prove_entry(&pid, &draw, list.proof(2))], &[]).await.unwrap_err(), ce(DrawError::ZeroWeight));
    t.send(vec![ix::prove_entry(&pid, &draw, list.proof(3))], &[]).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    let t0 = d.rounds[0].first_target;
    let h = grind(&draw, &d, t0, &list.weights(), &[], 4, &|w| w[0] == Some(0));
    t.draw_with(&draw, h).await.unwrap();
    t.resolve(&draw, 1, vec![list.proof(0)]).await.unwrap();
    // The whale won slot 0; its proof never fits slot 1's point.
    assert_eq!(t.resolve(&draw, 1, vec![list.proof(0)]).await.unwrap_err(), ce(DrawError::PointNotInLeaf));
    // Zero-weight proof refused.
    assert_eq!(t.resolve(&draw, 1, vec![list.proof(2)]).await.unwrap_err(), ce(DrawError::ZeroWeight));
    t.resolve_all(&draw, &list).await;
    let slots = t.slots(&draw).await;
    let winners: Vec<u64> = slots.iter().filter(|s| s.status == SLOT_WON).map(|s| s.leaf_index).collect();
    let mut sorted = winners.clone();
    sorted.sort();
    assert_eq!(sorted, vec![0, 1, 3], "each non-zero leaf wins once");
    // The fourth slot is void (no weight left): refundable right away.
    assert_eq!(slots[3].status, SLOT_VOID);
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.refundable, d.won_weight, d.window_end > 0), (1_000_000, 1_003, true));
    t.solvent(&draw, true).await;
}

#[tokio::test]
async fn unweighted_claim_rejections_and_window() {
    let org = Keypair::new();
    let users = kp(3);
    let mallory = Keypair::new();
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    funded.push(&mallory);
    let mut t = T::new(&funded, vec![]).await;
    let pid = t.pid;
    let draw = t.create(&org, 3, list_params(false, tiers(&[(1, SOL)]), 0, None)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    let list = List { draw, entries: users.iter().map(|u| (u.pubkey(), 1)).collect(), depth: 2 };
    let (root, total) = list.root();
    // Unweighted lists must have total == count.
    assert_eq!(
        t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, 4, 3, 2)], &[&org]).await.unwrap_err(),
        ce(DrawError::InvalidParams)
    );
    t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, 3, 2)], &[&org]).await.unwrap();
    t.draw_with(&draw, [5; 32]).await.unwrap();
    t.resolve(&draw, 0, vec![]).await.unwrap();
    let s = t.slots(&draw).await[0];
    let wi = s.leaf_index as usize;
    let winner = &users[wi];
    let loser = &users[(wi + 1) % 3];
    // No proof, someone else's proof, a loser's own proof, a tampered proof.
    assert_eq!(t.claim(winner, &draw, 0, None, None).await.unwrap_err(), ce(DrawError::MissingProof));
    assert_eq!(t.claim(&mallory, &draw, 0, Some(list.proof(wi)), None).await.unwrap_err(), ce(DrawError::NotWinner));
    let li = (wi + 1) % 3;
    assert_eq!(t.claim(loser, &draw, 0, Some(list.proof(li)), None).await.unwrap_err(), ce(DrawError::NotWinner));
    let mut bad = list.proof(wi);
    bad.path[5] ^= 1;
    assert_eq!(t.claim(winner, &draw, 0, Some(bad), None).await.unwrap_err(), ce(DrawError::InvalidProof));
    // Unresolved slot index.
    assert_eq!(t.claim(winner, &draw, 1, Some(list.proof(wi)), None).await.unwrap_err(), ce(DrawError::WrongStatus));
    // After the window: refused.
    let (d, _) = t.draw_state(&draw).await;
    t.warp(d.window_end + 1).await;
    assert_eq!(t.claim(winner, &draw, 0, Some(list.proof(wi)), None).await.unwrap_err(), ce(DrawError::ClaimWindowClosed));
    t.warp(d.window_end).await;
    t.claim(winner, &draw, 0, Some(list.proof(wi)), None).await.unwrap();
    assert_eq!(t.slots(&draw).await[0].status, SLOT_CLAIMED);
    assert_eq!(t.slots(&draw).await[0].wallet, winner.pubkey().to_bytes());
    assert_eq!(t.claim(winner, &draw, 0, Some(list.proof(wi)), None).await.unwrap_err(), ce(DrawError::AlreadyClaimed));
    t.solvent(&draw, true).await;
}

// ── re-draw rounds ──────────────────────────────────────────────────────────

#[tokio::test]
async fn redraw_rounds_exclude_previous_winners_then_return() {
    let org = Keypair::new();
    let users = kp(8);
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    let mut t = T::new(&funded, vec![]).await;
    let pid = t.pid;
    // 2 prizes, 3 re-draw rounds, 8 unweighted entries; nobody ever claims.
    let draw = t.create(&org, 4, list_params(false, tiers(&[(2, 5_000_000)]), 3, None)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    let list = List { draw, entries: users.iter().map(|u| (u.pubkey(), 1)).collect(), depth: 3 };
    let (root, total) = list.root();
    t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, 8, 3)], &[&org]).await.unwrap();
    let mut won: Vec<usize> = Vec::new();
    for round in 0..4u8 {
        t.draw_with(&draw, hashv(&[b"r", &[round]]).to_bytes()).await.unwrap();
        let (d, _) = t.draw_state(&draw).await;
        assert_eq!(d.round, round);
        let base = d.round_first_slot as u64;
        let expect = stream::reference_draw(&list.weights(), &won, &d.rounds[round as usize].seed, base, 2);
        t.resolve(&draw, 0, vec![]).await.unwrap();
        let slots = t.slots(&draw).await;
        for (k, e) in expect.iter().enumerate() {
            let s = slots[base as usize + k];
            assert_eq!(Some(s.leaf_index as usize), *e);
            assert!(!won.contains(&(s.leaf_index as usize)), "previous winners are excluded");
            assert_eq!(s.round, round);
            won.push(s.leaf_index as usize);
        }
        t.advance_after_window(&draw).await.unwrap();
    }
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.round, d.slot_count, d.refundable), (STATUS_COMPLETE, 3, 8, 10_000_000));
    let slots = t.slots(&draw).await;
    assert!(slots.iter().all(|s| s.status == SLOT_FORFEITED));
    let mut all = won.clone();
    all.sort();
    all.dedup();
    assert_eq!(all.len(), 8, "eight distinct winners over four rounds");
    t.solvent(&draw, true).await;
    // Advance after completion is refused.
    assert_eq!(t.send(vec![ix::advance(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::WrongStatus));
}

#[tokio::test]
async fn fewer_entries_than_prizes_and_empty_raffle() {
    let org = Keypair::new();
    let users = kp(2);
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    let mut t = T::new(&funded, vec![]).await;
    let pid = t.pid;
    // Empty raffle: Draw completes it and every prize is refundable.
    let empty = t.create(&org, 5, open_params(1_100, false, tiers(&[(3, 1_000)]), 2)).await.unwrap();
    t.fund(&org, &empty, None).await.unwrap();
    t.warp(1_100).await;
    t.send(vec![ix::draw(&pid, &empty)], &[]).await.unwrap();
    let (d, _) = t.draw_state(&empty).await;
    assert_eq!((d.status, d.refundable), (STATUS_COMPLETE, 3_000));
    t.send(vec![ix::reclaim(&pid, &org.pubkey(), &empty, None)], &[&org]).await.unwrap();
    t.solvent(&empty, true).await;
    // Two entrants, five prizes: three slots void.
    let draw = t.create(&org, 6, open_params(t.slot + 200, false, tiers(&[(5, 1_000)]), 1)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    for u in &users {
        t.enter(u, &draw, 1).await.unwrap();
    }
    t.warp(t.slot + 200).await;
    t.draw_with(&draw, [3; 32]).await.unwrap();
    t.resolve(&draw, 0, vec![]).await.unwrap();
    let slots = t.slots(&draw).await;
    let st: Vec<u8> = slots.iter().map(|s| s.status).collect();
    assert_eq!(st, vec![SLOT_WON, SLOT_WON, SLOT_VOID, SLOT_VOID, SLOT_VOID]);
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!(d.refundable, 3_000);
    // Nobody claims; no weight left, so no re-draw round despite redraw_rounds = 1.
    t.advance_after_window(&draw).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.status, d.refundable), (STATUS_COMPLETE, 5_000));
    t.solvent(&draw, true).await;
}

// ── entries: fees, caps, unfunded, receipts ─────────────────────────────────

#[tokio::test]
async fn entry_fees_caps_and_weighted_entries() {
    let org = Keypair::new();
    let fee = Keypair::new();
    let users = kp(2);
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    let mut t = T::new(&funded, vec![]).await;
    let pid = t.pid;
    let mut p = open_params(2_000, true, tiers(&[(1, SOL)]), 0);
    p.entry_price = 1_000_000;
    p.wallet_cap = 5;
    p.fee_dest = fee.pubkey().to_bytes();
    let draw = t.create(&org, 8, p).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    // Zero entries refused.
    assert_eq!(t.enter(&users[0], &draw, 0).await.unwrap_err(), ce(DrawError::ZeroWeight));
    // Weighted: one leaf of weight 3, fee 3 * price to the fee destination.
    t.enter(&users[0], &draw, 3).await.unwrap();
    assert_eq!(t.lamports(&fee.pubkey()).await, 3_000_000);
    let er = ix::entrant_address(&pid, &draw, &users[0].pubkey()).0;
    let rec = Entrant::unpack(&t.account(&er).await.unwrap().data).unwrap();
    assert_eq!(rec.count, 3);
    // Cap 5: 3 + 3 refused, 3 + 2 accepted.
    assert_eq!(t.enter(&users[0], &draw, 3).await.unwrap_err(), ce(DrawError::WalletCapExceeded));
    t.enter(&users[0], &draw, 2).await.unwrap();
    t.enter(&users[1], &draw, 5).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.leaf_count, d.total_weight), (3, 10));
    // Wrong fee destination.
    let wrong = ix::enter(&pid, &users[1].pubkey(), &draw, &users[1].pubkey(), 1, &org.pubkey(), None);
    assert_eq!(t.send(vec![wrong], &[&users[1]]).await.unwrap_err(), ce(DrawError::InvalidAccount));
    // Entrant records close only after entries close.
    let close_rec = ix::close_entrant(&pid, &users[0].pubkey(), &draw);
    assert_eq!(t.send(vec![close_rec.clone()], &[&users[0]]).await.unwrap_err(), ce(DrawError::EntrantInUse));
    t.warp(2_000).await;
    let before = t.lamports(&users[0].pubkey()).await;
    t.send(vec![close_rec], &[&users[0]]).await.unwrap();
    assert!(t.lamports(&users[0].pubkey()).await > before);
    assert!(t.account(&er).await.is_none());
    // Participation receipt of an open-raffle leaf.
    let list = List { draw, entries: vec![(users[0].pubkey(), 3), (users[0].pubkey(), 2), (users[1].pubkey(), 5)], depth: OPEN_DEPTH };
    assert_eq!(list.root(), (d.root, d.total_weight));
    t.send(vec![ix::prove_entry(&pid, &draw, list.proof(2))], &[]).await.unwrap();
    let mut bad = list.proof(2);
    bad.wallet = users[0].pubkey().to_bytes();
    assert_eq!(t.send(vec![ix::prove_entry(&pid, &draw, bad)], &[]).await.unwrap_err(), ce(DrawError::InvalidProof));
}

#[tokio::test]
async fn spl_entry_fee() {
    let org = Keypair::new();
    let user = Keypair::new();
    let emint = Pubkey::new_unique();
    let user_tok = Pubkey::new_unique();
    let fee_tok = Pubkey::new_unique();
    let extra = vec![
        (emint, Account { lamports: SOL, data: token::pack_mint(1_000, 0), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
        (user_tok, Account { lamports: SOL, data: token::pack_account(&emint, &user.pubkey(), 1_000), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
        (fee_tok, Account { lamports: SOL, data: token::pack_account(&emint, &org.pubkey(), 0), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
    ];
    let mut t = T::new(&[&org, &user], extra).await;
    let pid = t.pid;
    let mut p = open_params(2_000, false, tiers(&[(1, SOL)]), 0);
    p.entry_price = 7;
    p.entry_mint = emint.to_bytes();
    p.fee_dest = fee_tok.to_bytes();
    let draw = t.create(&org, 9, p).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    // Unweighted: four leaves of weight 1 in one instruction, 28 tokens.
    let i = ix::enter(&pid, &user.pubkey(), &draw, &user.pubkey(), 4, &fee_tok, Some(&user_tok));
    t.send(vec![i], &[&user]).await.unwrap();
    assert_eq!(t.token_amount(&fee_tok).await, 28);
    assert_eq!(t.token_amount(&user_tok).await, 972);
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!((d.leaf_count, d.total_weight), (4, 4));
    // More than eight leaves per instruction is refused.
    let i = ix::enter(&pid, &user.pubkey(), &draw, &user.pubkey(), 9, &fee_tok, Some(&user_tok));
    assert_eq!(t.send(vec![i], &[&user]).await.unwrap_err(), ce(DrawError::InvalidParams));
}

#[tokio::test]
async fn unfunded_prizes_block_the_draw_and_cancel_rules() {
    let org = Keypair::new();
    let user = Keypair::new();
    let mut t = T::new(&[&org, &user], vec![]).await;
    let pid = t.pid;
    let draw = t.create(&org, 10, open_params(1_050, false, tiers(&[(1, SOL)]), 0)).await.unwrap();
    t.warp(1_100).await;
    // Not funded: Draw is refused even after the close slot.
    assert_eq!(t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::WrongStatus));
    assert_eq!(t.resolve(&draw, 0, vec![]).await.unwrap_err(), ce(DrawError::WrongStatus));
    // Cancel an unfunded draw: rent back.
    t.send(vec![ix::cancel(&pid, &org.pubkey(), &draw, None)], &[&org]).await.unwrap();
    assert!(t.account(&draw).await.is_none());
    // A funded open raffle cannot be cancelled.
    let draw = t.create(&org, 11, open_params(2_000, false, tiers(&[(1, SOL)]), 0)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    assert_eq!(
        t.send(vec![ix::cancel(&pid, &org.pubkey(), &draw, None)], &[&org]).await.unwrap_err(),
        ce(DrawError::WrongStatus)
    );
    // Funding twice is refused.
    assert_eq!(t.fund(&org, &draw, None).await.unwrap_err(), ce(DrawError::WrongStatus));
    // A funded, uncommitted list can be cancelled; the prize comes back.
    let draw = t.create(&org, 12, list_params(false, tiers(&[(2, SOL)]), 0, None)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    let ob = t.lamports(&org.pubkey()).await;
    let held = t.lamports(&draw).await;
    assert_eq!(
        t.send(vec![ix::cancel(&pid, &user.pubkey(), &draw, None)], &[&user]).await.unwrap_err(),
        ce(DrawError::NotOrganizer)
    );
    t.send(vec![ix::cancel(&pid, &org.pubkey(), &draw, None)], &[&org]).await.unwrap();
    assert_eq!(t.lamports(&org.pubkey()).await, ob + held);
    assert!(held >= 2 * SOL);
}

// ── draw: sysvar checks, fallback ───────────────────────────────────────────

#[tokio::test]
async fn draw_rejections_and_fallback_slot() {
    let org = Keypair::new();
    let user = Keypair::new();
    let mut t = T::new(&[&org, &user], vec![]).await;
    let pid = t.pid;
    let draw = t.create(&org, 13, list_params(false, tiers(&[(1, SOL)]), 0, None)).await.unwrap();
    t.fund(&org, &draw, None).await.unwrap();
    let list = List { draw, entries: vec![(user.pubkey(), 1), (org.pubkey(), 1)], depth: 1 };
    let (root, total) = list.root();
    // Draw before commit.
    assert_eq!(t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::WrongStatus));
    t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, 2, 1)], &[&org]).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    let t0 = d.rounds[0].first_target;
    assert_eq!(t0, t.slot + DRAW_DELAY_SLOTS);
    // Target has no hash yet.
    let early: Vec<_> = (t0 - 100..t0).map(|s| (s, filler(s))).collect();
    t.hashes(&early);
    assert_eq!(t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::DrawTooEarly));
    // Forged SlotHashes account and another sysvar.
    let fake = Pubkey::new_unique();
    let mut acct = Account::new(SOL, 20_488, &solana_sdk::sysvar::id());
    let data = encode_slot_hashes(&[(t0, [9u8; 32])]);
    acct.data[..data.len()].copy_from_slice(&data);
    t.ctx.set_account(&fake, &acct.into());
    assert_eq!(t.send(vec![ix::draw_with_sysvar(&pid, &draw, &fake)], &[]).await.unwrap_err(), ce(DrawError::InvalidSysvar));
    let clock_id = solana_sdk::sysvar::clock::id();
    assert_eq!(t.send(vec![ix::draw_with_sysvar(&pid, &draw, &clock_id)], &[]).await.unwrap_err(), ce(DrawError::InvalidSysvar));
    // T_0 aged out: the fixed fallback T_1 = T_0 + 512 is used.
    let t1 = t0 + FALLBACK_STEP_SLOTS;
    let window: Vec<_> = (t0 + 100..=t0 + 611).map(|s| (s, filler(s))).collect();
    t.hashes(&window);
    t.warp(t0 + 611).await;
    t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    let r = d.rounds[0];
    assert_eq!((r.attempt, r.target_slot, r.used_slot, r.slot_hash), (1, t1, t1, filler(t1)));
    let seed = stream::seed(&draw.to_bytes(), 0, t1, t1, &filler(t1), &root, total, 2);
    assert_eq!(r.seed, seed);
    // Drawing twice is refused.
    assert_eq!(t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap_err(), ce(DrawError::WrongStatus));
}

// ── pre-funded PDA addresses ────────────────────────────────────────────────

#[tokio::test]
async fn prefunded_draw_vault_and_entrant_addresses_do_not_block() {
    let org = Keypair::new();
    let griefer = Keypair::new();
    let user = Keypair::new();
    let mint = Pubkey::new_unique();
    let org_token = Pubkey::new_unique();
    let extra = vec![
        (mint, Account { lamports: SOL, data: token::pack_mint(1_000, 0), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
        (org_token, Account { lamports: SOL, data: token::pack_account(&mint, &org.pubkey(), 1_000), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
    ];
    let mut t = T::new(&[&org, &griefer, &user], extra).await;
    let pid = t.pid;
    let draw = ix::draw_address(&pid, &org.pubkey(), 14).0;
    let vault = ix::vault_address(&pid, &draw).0;
    let entrant = ix::entrant_address(&pid, &draw, &user.pubkey()).0;
    for k in [draw, vault, entrant] {
        t.send(vec![system_instruction::transfer(&griefer.pubkey(), &k, 1_000_000)], &[&griefer]).await.unwrap();
    }
    let mut p = open_params(2_000, false, tiers(&[(1, 10)]), 0);
    p.prize_mint = mint.to_bytes();
    p.wallet_cap = 2;
    t.create(&org, 14, p).await.unwrap();
    assert_eq!(t.account(&vault).await.unwrap().owner, TOKEN_PROGRAM_ID);
    t.fund(&org, &draw, Some(&org_token)).await.unwrap();
    t.enter(&user, &draw, 1).await.unwrap();
    assert_eq!(t.account(&entrant).await.unwrap().owner, pid);
    t.solvent(&draw, false).await;
    // Creating the same draw again is refused.
    let mut p = open_params(2_000, false, tiers(&[(1, 10)]), 0);
    p.prize_mint = mint.to_bytes();
    assert_eq!(t.create(&org, 14, p).await.unwrap_err(), ce(DrawError::AccountInUse));
}

#[tokio::test]
async fn largest_draw_grows_with_extend() {
    let org = Keypair::new();
    let mut t = T::new(&[&org], vec![]).await;
    let pid = t.pid;
    // 1024 slots: 792 + 800 + 1024 * 76 = 79,416 bytes, created in one
    // transaction with seven Extend instructions.
    let p = open_params(5_000, false, tiers(&[(256, 1_000)]), 3);
    let ixs = ix::create_draw_with_extends(&pid, &org.pubkey(), 1, p);
    assert_eq!(ixs.len(), 8);
    t.send(ixs, &[&org]).await.unwrap();
    let draw = ix::draw_address(&pid, &org.pubkey(), 1).0;
    let a = t.account(&draw).await.unwrap();
    assert_eq!(a.data.len(), 79_416);
    assert_eq!(a.lamports, t.rent.minimum_balance(79_416));
    // Extend on a full account is refused.
    assert_eq!(
        t.send(vec![ix::extend(&pid, &org.pubkey(), &draw)], &[&org]).await.unwrap_err(),
        ce(DrawError::WrongStatus)
    );
    t.fund(&org, &draw, None).await.unwrap();
    let slots = t.slots(&draw).await;
    assert_eq!(slots.len(), 256);
    t.solvent(&draw, true).await;
}

// ── solvency fuzz ───────────────────────────────────────────────────────────

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
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

#[tokio::test]
async fn solvency_and_conservation_fuzz() {
    let cases: u64 = std::env::var("NFD_FUZZ_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(12);
    let mut claims = 0u64;
    let mut redraws = 0u64;
    for case in 0..cases {
        let mut rng = Rng(0xA076_1D64_78BD_642F ^ (case + 1));
        let org = Keypair::new();
        let users = kp(6);
        let mut funded: Vec<&Keypair> = users.iter().collect();
        funded.push(&org);
        let mut t = T::new(&funded, vec![]).await;
        let pid = t.pid;
        let weighted = rng.below(2) == 0;
        let open = rng.below(2) == 0;
        let n_tiers = rng.range(1, 3) as usize;
        let tv: Vec<(u32, u64)> = (0..n_tiers).map(|_| (rng.range(1, 3) as u32, rng.range(1, 50_000_000))).collect();
        let redraw = rng.range(0, 3) as u8;
        let close = t.slot + 300;
        let p = if open { open_params(close, weighted, tiers(&tv), redraw) } else { list_params(weighted, tiers(&tv), redraw, None) };
        let draw = t.create(&org, case, p).await.unwrap();
        t.fund(&org, &draw, None).await.unwrap();
        t.solvent(&draw, true).await;
        // Entries.
        let mut list = List { draw, entries: vec![], depth: OPEN_DEPTH };
        let n_entries = rng.range(0, 7) as usize;
        if open {
            for _ in 0..n_entries {
                let u = rng.below(6) as usize;
                let c = if weighted { rng.range(1, 9) as u32 } else { 1 };
                t.enter(&users[u], &draw, c).await.unwrap();
                list.entries.push((users[u].pubkey(), c as u64));
            }
            t.warp(close).await;
        } else {
            let n = n_entries.max(1);
            list.entries = (0..n).map(|_| (users[rng.below(6) as usize].pubkey(), if weighted { rng.range(0, 9) } else { 1 })).collect();
            if list.weights().iter().sum::<u64>() == 0 {
                list.entries[0].1 = 1;
            }
            list.depth = sumtree::depth_for(n as u64);
            let (root, total) = list.root();
            t.send(vec![ix::commit_list(&pid, &org.pubkey(), &draw, root, total, n as u64, list.depth as u8)], &[&org]).await.unwrap();
        }
        // Rounds.
        loop {
            let (d, _) = t.draw_state(&draw).await;
            if d.status == STATUS_COMPLETE {
                break;
            }
            let seed_h = hashv(&[&rng.next().to_le_bytes()]).to_bytes();
            if d.status == STATUS_FUNDED && open && d.leaf_count == 0 {
                t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap();
                continue;
            }
            t.draw_with(&draw, seed_h).await.unwrap();
            if d.round > 0 {
                redraws += 1;
            }
            t.resolve_all(&draw, &list).await;
            t.solvent(&draw, true).await;
            // Each winner claims with probability 1/2; some wrong claims.
            let (d, _) = t.draw_state(&draw).await;
            let slots = t.slots(&draw).await;
            for j in d.round_first_slot as usize..d.slot_count as usize {
                let s = slots[j];
                if s.status != SLOT_WON || rng.below(2) == 0 {
                    continue;
                }
                let leaf = s.leaf_index as usize;
                let owner = list.entries[leaf].0;
                let who = users.iter().find(|u| u.pubkey() == owner).unwrap();
                let proof = if s.wallet == [0; 32] { Some(list.proof(leaf)) } else { None };
                if let Some(other) = users.iter().find(|u| u.pubkey() != owner) {
                    let r = t.claim(other, &draw, j as u16, proof.clone(), None).await;
                    assert!(r.is_err());
                }
                let before = t.lamports(&who.pubkey()).await;
                t.claim(who, &draw, j as u16, proof, None).await.unwrap();
                assert_eq!(t.lamports(&who.pubkey()).await, before + d.tiers[s.tier as usize].amount);
                claims += 1;
                t.solvent(&draw, true).await;
            }
            t.advance_after_window(&draw).await.unwrap();
            t.solvent(&draw, true).await;
        }
        // Wind down: reclaim and check conservation.
        let (d, data) = t.draw_state(&draw).await;
        if d.refundable > 0 {
            t.send(vec![ix::reclaim(&pid, &org.pubkey(), &draw, None)], &[&org]).await.unwrap();
        }
        let (d2, _) = t.draw_state(&draw).await;
        assert_eq!(d2.paid + d2.returned, d2.funded, "prize conservation");
        assert_eq!(d2.outstanding(), Some(0));
        // Every round-0 prize lineage ends claimed, void or returned.
        let claimed: u64 = (0..d.slot_count as usize)
            .map(|i| d.read_slot(&data, i))
            .filter(|s| s.status == SLOT_CLAIMED)
            .map(|s| d.tiers[s.tier as usize].amount)
            .sum();
        assert_eq!(claimed, d2.paid);
        // No leaf won twice.
        let mut leaves: Vec<u64> = (0..d.slot_count as usize)
            .map(|i| d.read_slot(&data, i))
            .filter(|s| s.status != SLOT_VOID && s.status != 0)
            .map(|s| s.leaf_index)
            .collect();
        let n = leaves.len();
        leaves.sort();
        leaves.dedup();
        assert_eq!(leaves.len(), n, "a leaf won twice");
        t.solvent(&draw, true).await;
    }
    println!("fuzz: cases={cases} claims={claims} redraw_rounds={redraws}");
    assert!(claims > 0 && redraws > 0);
}

// ── compute units ───────────────────────────────────────────────────────────

#[tokio::test]
async fn compute_units() {
    let org = Keypair::new();
    let users = kp(4);
    let mint = Pubkey::new_unique();
    let org_token = Pubkey::new_unique();
    let mut extra = vec![
        (mint, Account { lamports: SOL, data: token::pack_mint(1_000_000, 0), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
        (org_token, Account { lamports: SOL, data: token::pack_account(&mint, &org.pubkey(), 1_000_000), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }),
    ];
    let user_tokens: Vec<Pubkey> = users.iter().map(|_| Pubkey::new_unique()).collect();
    for (u, k) in users.iter().zip(&user_tokens) {
        extra.push((*k, Account { lamports: SOL, data: token::pack_account(&mint, &u.pubkey(), 0), owner: TOKEN_PROGRAM_ID, executable: false, rent_epoch: 0 }));
    }
    let mut funded: Vec<&Keypair> = users.iter().collect();
    funded.push(&org);
    let mut t = T::new(&funded, extra).await;
    let pid = t.pid;
    let mut rows: Vec<(String, u64)> = Vec::new();

    // Open raffle, unweighted, SOL, 56 prizes (1 + 5 + 50), 2 re-draw rounds.
    let p = open_params(5_000, false, tiers(&[(1, SOL), (5, SOL / 10), (50, SOL / 100)]), 2);
    let i = ix::create_draw(&pid, &org.pubkey(), 1, p.clone());
    rows.push(("CreateDraw (open, 56 prizes, 2 re-draws, SOL)".into(), t.cu(vec![i.clone()], &[&org]).await));
    t.send(vec![i], &[&org]).await.unwrap();
    let d1 = ix::draw_address(&pid, &org.pubkey(), 1).0;
    // 14,424 bytes: FundPrizes refuses until Extend grew the account.
    assert_eq!(t.fund(&org, &d1, None).await.unwrap_err(), ce(DrawError::AccountNotExtended));
    rows.push(("Extend (+4,120 bytes)".into(), t.cu(vec![ix::extend(&pid, &org.pubkey(), &d1)], &[&org]).await));
    let i = ix::cancel(&pid, &org.pubkey(), &d1, None);
    t.send(vec![i], &[&org]).await.unwrap();
    let draw = t.create(&org, 1, p).await.unwrap();
    assert_eq!(t.account(&draw).await.unwrap().data.len(), 14_360);
    let i = ix::fund_prizes(&pid, &org.pubkey(), &draw, None);
    rows.push(("FundPrizes (SOL, writes 56 slot tiers)".into(), t.cu(vec![i], &[&org]).await));
    t.fund(&org, &draw, None).await.unwrap();
    let mut entry_cu = Vec::new();
    for r in 0..40u32 {
        let u = &users[(r % 4) as usize];
        let i = ix::enter(&pid, &u.pubkey(), &draw, &u.pubkey(), 1, &Pubkey::default(), None);
        entry_cu.push(t.cu(vec![i.clone()], &[u]).await);
        t.send(vec![i], &[u]).await.unwrap();
    }
    rows.push(("Enter (1 leaf, free)".into(), *entry_cu.iter().max().unwrap()));
    let i = ix::enter(&pid, &users[0].pubkey(), &draw, &users[0].pubkey(), 8, &Pubkey::default(), None);
    rows.push(("Enter (8 leaves, free)".into(), t.cu(vec![i.clone()], &[&users[0]]).await));
    t.send(vec![i], &[&users[0]]).await.unwrap();
    for _ in 0..3 {
        for u in &users {
            let i = ix::enter(&pid, &u.pubkey(), &draw, &u.pubkey(), 8, &Pubkey::default(), None);
            t.send(vec![i], &[u]).await.unwrap();
        }
    }
    // 40 + 8 + 96 = 144 entries.
    t.warp(5_000).await;
    let t0 = 5_000 + DRAW_DELAY_SLOTS;
    let entries: Vec<_> = (t0 - 400..t0 + 100).map(|s| (s, filler(s))).collect();
    t.hashes(&entries);
    t.warp(t0 + 100).await;
    rows.push(("Draw (500-entry SlotHashes)".into(), t.cu(vec![ix::draw(&pid, &draw)], &[]).await));
    t.send(vec![ix::draw(&pid, &draw)], &[]).await.unwrap();
    rows.push(("Resolve unweighted, 24 slots (batch 1)".into(), t.cu(vec![ix::resolve(&pid, &draw, 24, vec![])], &[]).await));
    t.resolve(&draw, 24, vec![]).await.unwrap();
    t.resolve(&draw, 24, vec![]).await.unwrap();
    rows.push(("Resolve unweighted, 8 slots (48 already won)".into(), t.cu(vec![ix::resolve(&pid, &draw, 8, vec![])], &[]).await));
    t.resolve(&draw, 8, vec![]).await.unwrap();
    let (d, _) = t.draw_state(&draw).await;
    assert_eq!(d.next_slot, 56);
    // Claim of an unweighted slot (with its proof).
    let mut list = List { draw, entries: vec![], depth: OPEN_DEPTH };
    for r in 0..40usize {
        list.entries.push((users[r % 4].pubkey(), 1));
    }
    for _ in 0..8 {
        list.entries.push((users[0].pubkey(), 1));
    }
    for _ in 0..3 {
        for u in &users {
            for _ in 0..8 {
                list.entries.push((u.pubkey(), 1));
            }
        }
    }
    assert_eq!(list.root(), (d.root, d.total_weight));
    let s0 = t.slots(&draw).await[0];
    let w = users.iter().find(|u| u.pubkey() == list.entries[s0.leaf_index as usize].0).unwrap();
    let i = ix::claim(&pid, &w.pubkey(), &draw, 0, Some(list.proof(s0.leaf_index as usize)), None);
    rows.push(("Claim unweighted (proof, SOL)".into(), t.cu(vec![i], &[w]).await));
    let (d, _) = t.draw_state(&draw).await;
    t.warp(d.window_end + 1).await;
    rows.push(("Advance (56 slots, re-draw)".into(), t.cu(vec![ix::advance(&pid, &draw)], &[]).await));
    let i = ix::prove_entry(&pid, &draw, list.proof(3));
    rows.push(("ProveEntry (depth 20)".into(), t.cu(vec![i], &[]).await));

    // Committed list, weighted, SPL, depth 20.
    let p = list_params(true, tiers(&[(1, 500), (2, 100)]), 1, Some(mint));
    let i = ix::create_draw(&pid, &org.pubkey(), 2, p.clone());
    rows.push(("CreateDraw (list, SPL vault)".into(), t.cu(vec![i], &[&org]).await));
    let draw2 = t.create(&org, 2, p).await.unwrap();
    let i = ix::fund_prizes(&pid, &org.pubkey(), &draw2, Some(&org_token));
    rows.push(("FundPrizes (SPL)".into(), t.cu(vec![i], &[&org]).await));
    t.fund(&org, &draw2, Some(&org_token)).await.unwrap();
    let list2 = List { draw: draw2, entries: (0..1_000u64).map(|i| (users[(i % 4) as usize].pubkey(), 1 + i % 7)).collect(), depth: 20 };
    let (root, total) = list2.root();
    let i = ix::commit_list(&pid, &org.pubkey(), &draw2, root, total, 1_000, 20);
    rows.push(("CommitList".into(), t.cu(vec![i.clone()], &[&org]).await));
    t.send(vec![i], &[&org]).await.unwrap();
    t.draw_with(&draw2, [1; 32]).await.unwrap();
    let (d, data) = t.draw_state(&draw2).await;
    let u = stream::point(&d.rounds[0].seed, 0, d.total_weight);
    let p0 = stream::remap(u, (0..d.won_count as usize).map(|k| d.won_at(&data, k))).unwrap();
    let i = ix::resolve(&pid, &draw2, 1, vec![list2.proof(list2.leaf_at(p0))]);
    rows.push(("Resolve weighted (1 proof, depth 20)".into(), t.cu(vec![i.clone()], &[]).await));
    // Transaction size of a depth-20 weighted Resolve.
    let tx = Transaction::new_with_payer(&[i], Some(&org.pubkey()));
    let size = bincode_len(&tx);
    t.resolve_all(&draw2, &list2).await;
    let s0 = t.slots(&draw2).await[0];
    let wi = users.iter().position(|u| u.pubkey().to_bytes() == s0.wallet).unwrap();
    let i = ix::claim(&pid, &users[wi].pubkey(), &draw2, 0, None, Some(&user_tokens[wi]));
    rows.push(("Claim weighted (SPL)".into(), t.cu(vec![i], &[&users[wi]]).await));

    let mode = if T::sbf() { "sbf" } else { "native" };
    println!("CU[{mode}] weighted-resolve tx bytes = {size}");
    for (name, cu) in &rows {
        println!("CU[{mode}] {name:<48} {cu:>8}");
    }
    assert!(size <= 1_232, "transaction too large: {size}");
    if T::sbf() {
        for (name, cu) in &rows {
            assert!(*cu < 1_400_000, "{name}: {cu}");
        }
    }
}

fn bincode_len(tx: &Transaction) -> usize {
    // A legacy transaction: compact signature count, signatures, message.
    let m = tx.message.serialize();
    1 + 64 * tx.message.header.num_required_signatures as usize + m.len()
}

#[test]
fn slot_status_constants_are_distinct() {
    let v = [0u8, SLOT_WON, SLOT_CLAIMED, SLOT_FORFEITED, SLOT_VOID];
    let mut s = v.to_vec();
    s.dedup();
    assert_eq!(s.len(), 5);
}
