// A FallbackDraw winner must be a real anchored ticket, selected by a seed that
// was committed before the pool was fixed, and claimed by its owner with the
// ticket.rs leaf + Merkle proof (2026-10-06 finding: FallbackDraw stored a
// synthetic nullifier SHA-256(seed || "fallback" || index) that no ticket had,
// did not check the seed and ignored fallback_tickets_root, so anyone who read
// the stored nullifier could claim the round).
//
// Run against the SBF binary instead of the native processor with
// `SBF_OUT_DIR=<dir with dark_null_lottery.so> cargo test`.
#![cfg(not(target_os = "windows"))]

use dark_null_lottery::{
    processor::draw_numbers,
    state::{RoundState, RoundStatus, ROUND_STATE_DISC, ROUND_STATE_SIZE},
    ticket::{fallback_winner_index, sorted_numbers, ticket_leaf, tickets_proof, tickets_root},
};
use solana_program::{hash::hashv, pubkey::Pubkey, system_instruction, system_program};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

const INVALID_SEED: u32 = 0x6004;
const ALREADY_CLAIMED: u32 = 0x6005;
const INVALID_WINNER: u32 = 0x6006;
const WRONG_STATUS: u32 = 0x6007;
const NOT_ADMIN: u32 = 0x6008;
const FALLBACK_NOT_READY: u32 = 0x6009;
const INVALID_TICKET_PROOF: u32 = 0x600B;
const FALLBACK_POOL_MISMATCH: u32 = 0x600C;
const NOT_FALLBACK_WINNER: u32 = 0x600D;
const FALLBACK_ROUNDS_NOT_CONSECUTIVE: u32 = 0x600E;

const ST_ANCHORED: u8 = 2;
const ST_DRAWN: u8 = 3;
const ST_WON: u8 = 4;
const ST_NO_WINNER: u8 = 5;
const ST_FALLBACK_DRAWN: u8 = 6;

fn program_test(program_id: Pubkey) -> ProgramTest {
    ProgramTest::new(
        "dark_null_lottery",
        program_id,
        processor!(dark_null_lottery::process_instruction),
    )
}

fn cfg_pda(p: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"lottery-config"], p).0
}
fn round_pda(p: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"round", &id.to_le_bytes()], p).0
}
fn claim_pda(p: &Pubkey, nullifier: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"claim", nullifier], p).0
}

fn init_ix(p: Pubkey, admin: Pubkey, fallback_after: u8) -> Instruction {
    let mut data = vec![0x01u8];
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&[5, 30, fallback_after]);
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(cfg_pda(&p), false),
            AccountMeta::new(admin, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

fn commit_ix(p: Pubkey, admin: Pubkey, id: u64, commitment: [u8; 32]) -> Instruction {
    let mut data = vec![0x02u8];
    data.extend_from_slice(&commitment);
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(cfg_pda(&p), false),
            AccountMeta::new(round_pda(&p, id), false),
            AccountMeta::new(admin, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

fn anchor_ix(p: Pubkey, admin: Pubkey, id: u64, root: [u8; 32], count: u64) -> Instruction {
    let mut data = vec![0x03u8];
    data.extend_from_slice(&root);
    data.extend_from_slice(&count.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(round_pda(&p, id), false),
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new_readonly(cfg_pda(&p), false),
        ],
        data,
    }
}

fn reveal_ix(p: Pubkey, admin: Pubkey, id: u64, seed: [u8; 32]) -> Instruction {
    let mut data = vec![0x04u8];
    data.extend_from_slice(&seed);
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(round_pda(&p, id), false),
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new_readonly(cfg_pda(&p), false),
        ],
        data,
    }
}

/// FallbackDraw over the three round accounts `rounds`.
fn fallback_ix(p: Pubkey, admin: Pubkey, rounds: [Pubkey; 3], seed: [u8; 32], root: [u8; 32], size: u64) -> Instruction {
    let mut data = vec![0x05u8];
    data.extend_from_slice(&seed);
    data.extend_from_slice(&root);
    data.extend_from_slice(&size.to_le_bytes());
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new_readonly(cfg_pda(&p), false),
            AccountMeta::new(rounds[0], false),
            AccountMeta::new(rounds[1], false),
            AccountMeta::new(rounds[2], false),
            AccountMeta::new_readonly(admin, true),
        ],
        data,
    }
}

/// ClaimJackpot. `ticket = None` sends the 33-byte nullifier-only form.
fn claim_ix(
    p: Pubkey,
    round: Pubkey,
    claimant: Pubkey,
    nullifier: [u8; 32],
    ticket: Option<([u8; 5], u64, Vec<[u8; 32]>)>,
) -> Instruction {
    let mut data = vec![0x06u8];
    data.extend_from_slice(&nullifier);
    if let Some((numbers, index, proof)) = ticket {
        data.extend_from_slice(&numbers);
        data.extend_from_slice(&index.to_le_bytes());
        data.push(proof.len() as u8);
        for h in proof {
            data.extend_from_slice(&h);
        }
    }
    let unused = AccountMeta::new_readonly(system_program::id(), false);
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(round, false),
            AccountMeta::new(claim_pda(&p, &nullifier), false),
            AccountMeta::new(claimant, true),
            unused.clone(),
            unused.clone(),
            unused.clone(),
            unused.clone(),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data,
    }
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), TransactionError> {
    let bh = ctx.banks_client.get_new_latest_blockhash(&ctx.last_blockhash).await.unwrap();
    ctx.last_blockhash = bh;
    let mut signers: Vec<&Keypair> = vec![&ctx.payer];
    signers.extend_from_slice(extra);
    let mut tx = Transaction::new_with_payer(ixs, Some(&ctx.payer.pubkey()));
    tx.sign(&signers, bh);
    ctx.banks_client.process_transaction(tx).await.map_err(|e| e.unwrap())
}

fn custom(code: u32) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(code))
}

async fn funded(ctx: &mut ProgramTestContext) -> Keypair {
    let kp = Keypair::new();
    let payer = ctx.payer.pubkey();
    send(ctx, &[system_instruction::transfer(&payer, &kp.pubkey(), 50_000_000)], &[]).await.unwrap();
    kp
}

/// (status byte, winner_nullifier) of a round.
async fn round_state(ctx: &mut ProgramTestContext, p: &Pubkey, id: u64) -> (u8, [u8; 32]) {
    let acc = ctx.banks_client.get_account(round_pda(p, id)).await.unwrap().unwrap();
    let mut w = [0u8; 32];
    w.copy_from_slice(&acc.data[127..159]);
    (acc.data[126], w)
}

/// Committed draw seed of round `id`. Round 2's seed is picked so the fallback
/// selects index 3 (not 0, the zero value, and not the last leaf).
fn seed_of(id: u64) -> [u8; 32] {
    let mut nonce = 0u64;
    loop {
        let seed = hashv(&[b"fallback-test-seed", &id.to_le_bytes(), &nonce.to_le_bytes()]).to_bytes();
        if id != 2 || fallback_winner_index(&seed, 2, POOL as u64) == 3 {
            return seed;
        }
        nonce += 1;
    }
}

struct Ticket {
    owner: Pubkey,
    numbers: [u8; 5],
    nullifier: [u8; 32],
}

/// Rounds 0, 1, 2 drawn with nobody claiming. Rounds 0 and 1 hold one winning
/// ticket each (owned by `loser`, never claimed). Round 2 holds 5 tickets; the
/// fallback selects `sel`, owned by `winner`; ticket `other` carries round 2's
/// drawn numbers but is not the selected one.
struct Fx {
    p: Pubkey,
    ctx: ProgramTestContext,
    winner: Keypair,
    loser: Keypair,
    attacker: Keypair,
    tickets: Vec<Ticket>,
    leaves: Vec<[u8; 32]>,
    root: [u8; 32],
    sel: usize,
    other: usize,
    r0_ticket: Ticket,
}

const POOL: usize = 5;

async fn three_drawn_rounds(fallback_after: u8, reveal_round_2: bool, round_2_tickets: bool) -> Fx {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let winner = funded(&mut ctx).await;
    let loser = funded(&mut ctx).await;
    let attacker = funded(&mut ctx).await;
    send(&mut ctx, &[init_ix(p, admin, fallback_after)], &[]).await.expect("init");

    // Rounds 0 and 1: one winning ticket each, never claimed.
    let mut r0_ticket = None;
    for id in 0..2u64 {
        let seed = seed_of(id);
        let t = Ticket { owner: loser.pubkey(), numbers: sorted_numbers(&draw_numbers(&seed, id)), nullifier: [0x30 + id as u8; 32] };
        let leaf = ticket_leaf(id, &t.owner.to_bytes(), &t.numbers, &t.nullifier);
        send(&mut ctx, &[commit_ix(p, admin, id, hashv(&[&seed]).to_bytes())], &[]).await.expect("commit");
        send(&mut ctx, &[anchor_ix(p, admin, id, tickets_root(&[leaf]), 1)], &[]).await.expect("anchor");
        send(&mut ctx, &[reveal_ix(p, admin, id, seed)], &[]).await.expect("reveal");
        if id == 0 {
            r0_ticket = Some(t);
        }
    }

    // Round 2: the fallback pool.
    let seed = seed_of(2);
    let drawn = sorted_numbers(&draw_numbers(&seed, 2));
    let sel = fallback_winner_index(&seed, 2, POOL as u64) as usize;
    assert_eq!(sel, 3);
    let other = (sel + 1) % POOL;
    let spare = (1..=30u8).find(|n| !drawn.contains(n)).unwrap();
    let mut lose = drawn;
    lose[0] = spare;
    let lose = sorted_numbers(&lose);
    let tickets: Vec<Ticket> = (0..POOL)
        .map(|i| {
            let (owner, numbers) = if i == sel {
                (winner.pubkey(), lose)
            } else if i == other {
                (loser.pubkey(), drawn)
            } else {
                (attacker.pubkey(), lose)
            };
            Ticket { owner, numbers, nullifier: [0xB0 + i as u8; 32] }
        })
        .collect();
    let leaves: Vec<[u8; 32]> = tickets
        .iter()
        .map(|t| ticket_leaf(2, &t.owner.to_bytes(), &t.numbers, &t.nullifier))
        .collect();
    let root = if round_2_tickets { tickets_root(&leaves) } else { [0u8; 32] };
    let count = if round_2_tickets { POOL as u64 } else { 0 };
    send(&mut ctx, &[commit_ix(p, admin, 2, hashv(&[&seed]).to_bytes())], &[]).await.expect("commit");
    send(&mut ctx, &[anchor_ix(p, admin, 2, root, count)], &[]).await.expect("anchor");
    if reveal_round_2 {
        send(&mut ctx, &[reveal_ix(p, admin, 2, seed)], &[]).await.expect("reveal");
    }
    Fx { p, ctx, winner, loser, attacker, tickets, leaves, root, sel, other, r0_ticket: r0_ticket.unwrap() }
}

impl Fx {
    fn rounds(&self) -> [Pubkey; 3] {
        [round_pda(&self.p, 0), round_pda(&self.p, 1), round_pda(&self.p, 2)]
    }
    fn fallback(&self) -> Instruction {
        fallback_ix(self.p, self.ctx.payer.pubkey(), self.rounds(), seed_of(2), self.root, POOL as u64)
    }
    /// Claim of round-2 ticket `i` (its own index and proof) signed by `claimant`.
    fn claim(&self, i: usize, claimant: &Keypair) -> Instruction {
        let t = &self.tickets[i];
        claim_ix(
            self.p,
            round_pda(&self.p, 2),
            claimant.pubkey(),
            t.nullifier,
            Some((t.numbers, i as u64, tickets_proof(&self.leaves, i))),
        )
    }
    async fn statuses(&mut self) -> [u8; 3] {
        let p = self.p;
        [
            round_state(&mut self.ctx, &p, 0).await.0,
            round_state(&mut self.ctx, &p, 1).await.0,
            round_state(&mut self.ctx, &p, 2).await.0,
        ]
    }
}

/// Fixture after a valid FallbackDraw.
async fn fallback_drawn() -> Fx {
    let mut f = three_drawn_rounds(3, true, true).await;
    let ix = f.fallback();
    send(&mut f.ctx, &[ix], &[]).await.expect("fallback draw");
    f
}

#[tokio::test]
async fn fallback_draw_checks_seed_pool_rounds_and_admin() {
    let mut f = three_drawn_rounds(3, true, true).await;
    let p = f.p;
    let admin = f.ctx.payer.pubkey();
    let attacker = f.attacker.insecure_clone();
    let r = f.rounds();
    let (root, size) = (f.root, POOL as u64);

    // Not the admin.
    let ix = fallback_ix(p, attacker.pubkey(), r, seed_of(2), root, size);
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(NOT_ADMIN));
    // A seed that does not match round 2's commitment (round 1's seed, a fresh one).
    for seed in [seed_of(1), [0x42u8; 32]] {
        let ix = fallback_ix(p, admin, r, seed, root, size);
        assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(INVALID_SEED));
    }
    // A pool that is not round 2's anchored tree (the old ignored root), or a different size.
    let ix = fallback_ix(p, admin, r, seed_of(2), [0xDD; 32], size);
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(FALLBACK_POOL_MISMATCH));
    let ix = fallback_ix(p, admin, r, seed_of(2), root, size + 1);
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(FALLBACK_POOL_MISMATCH));
    // Rounds out of order, or one round passed three times.
    let ix = fallback_ix(p, admin, [r[0], r[2], r[1]], seed_of(2), root, size);
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(FALLBACK_ROUNDS_NOT_CONSECUTIVE));
    let ix = fallback_ix(p, admin, [r[2], r[2], r[2]], seed_of(2), root, size);
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(FALLBACK_ROUNDS_NOT_CONSECUTIVE));
    // An account that is not a round PDA.
    let ix = fallback_ix(p, admin, [cfg_pda(&p), r[1], r[2]], seed_of(2), root, size);
    assert_eq!(
        send(&mut f.ctx, &[ix], &[]).await.unwrap_err(),
        TransactionError::InstructionError(0, InstructionError::InvalidAccountData)
    );
    assert_eq!(f.statuses().await, [ST_DRAWN; 3]);

    // The valid draw: rounds 0 and 1 NoWinner, round 2 FallbackDrawn, no winner recorded yet.
    let ix = f.fallback();
    send(&mut f.ctx, &[ix.clone()], &[]).await.expect("fallback draw");
    assert_eq!(f.statuses().await, [ST_NO_WINNER, ST_NO_WINNER, ST_FALLBACK_DRAWN]);
    assert_eq!(round_state(&mut f.ctx, &p, 2).await.1, [0u8; 32]);
    // Not twice.
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(WRONG_STATUS));
}

#[tokio::test]
async fn fallback_draw_readiness() {
    // Round 2 anchored but not drawn.
    let mut f = three_drawn_rounds(3, false, true).await;
    let ix = f.fallback();
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(WRONG_STATUS));
    assert_eq!(f.statuses().await, [ST_DRAWN, ST_DRAWN, ST_ANCHORED]);

    // Round 2 drawn with an empty ticket set: nothing to select.
    let mut f = three_drawn_rounds(3, true, false).await;
    let ix = fallback_ix(f.p, f.ctx.payer.pubkey(), f.rounds(), seed_of(2), [0u8; 32], 0);
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(FALLBACK_POOL_MISMATCH));

    // A config that asks for a longer no-winner streak than three rounds.
    let mut f = three_drawn_rounds(4, true, true).await;
    let ix = f.fallback();
    assert_eq!(send(&mut f.ctx, &[ix], &[]).await.unwrap_err(), custom(FALLBACK_NOT_READY));
    assert_eq!(f.statuses().await, [ST_DRAWN; 3]);
}

#[tokio::test]
async fn fallback_claim_without_ticket_is_rejected() {
    let mut f = fallback_drawn().await;
    let p = f.p;
    let attacker = f.attacker.insecure_clone();
    let winner = f.winner.insecure_clone();
    let seed = seed_of(2);
    // The removed path: the synthetic nullifier SHA-256(seed || "fallback" || index).
    let synthetic = hashv(&[&seed, b"fallback", &(f.sel as u64).to_le_bytes()]).to_bytes();
    let real = f.tickets[f.sel].nullifier;
    for (who, n) in [(&attacker, synthetic), (&attacker, real), (&winner, real)] {
        let ix = claim_ix(p, round_pda(&p, 2), who.pubkey(), n, None);
        assert_eq!(send(&mut f.ctx, &[ix], &[who]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));
    }
    assert_eq!(round_state(&mut f.ctx, &p, 2).await, (ST_FALLBACK_DRAWN, [0u8; 32]));
}

#[tokio::test]
async fn fallback_claim_with_unselected_ticket_is_rejected() {
    let mut f = fallback_drawn().await;
    let p = f.p;
    let loser = f.loser.insecure_clone();
    let attacker = f.attacker.insecure_clone();
    // Anchored ticket carrying the drawn numbers, valid proof, owner signs: not selected.
    let ix = f.claim(f.other, &loser);
    assert_eq!(send(&mut f.ctx, &[ix], &[&loser]).await.unwrap_err(), custom(NOT_FALLBACK_WINNER));
    // Every other unselected ticket, by its owner.
    for i in (0..POOL).filter(|i| *i != f.sel && *i != f.other) {
        let ix = f.claim(i, &attacker);
        assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(NOT_FALLBACK_WINNER));
    }
    // An unselected ticket presented at the selected index.
    let t = &f.tickets[f.other];
    let ix = claim_ix(p, round_pda(&p, 2), loser.pubkey(), t.nullifier,
        Some((t.numbers, f.sel as u64, tickets_proof(&f.leaves, f.other))));
    assert_eq!(send(&mut f.ctx, &[ix], &[&loser]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));
    // The selected index with a forged leaf: attacker's key, selected nullifier and numbers.
    let s = &f.tickets[f.sel];
    let ix = claim_ix(p, round_pda(&p, 2), attacker.pubkey(), s.nullifier,
        Some((s.numbers, f.sel as u64, tickets_proof(&f.leaves, f.sel))));
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));
    assert_eq!(round_state(&mut f.ctx, &p, 2).await, (ST_FALLBACK_DRAWN, [0u8; 32]));
}

#[tokio::test]
async fn copied_fallback_ticket_under_other_claimant_is_rejected() {
    let mut f = fallback_drawn().await;
    let p = f.p;
    // The selected ticket and proof copied (front-run) and signed by someone else.
    for who in [f.attacker.insecure_clone(), f.loser.insecure_clone()] {
        let ix = f.claim(f.sel, &who);
        assert_eq!(send(&mut f.ctx, &[ix], &[&who]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));
    }
    assert_eq!(round_state(&mut f.ctx, &p, 2).await, (ST_FALLBACK_DRAWN, [0u8; 32]));
    assert!(f.ctx.banks_client.get_account(claim_pda(&p, &f.tickets[f.sel].nullifier)).await.unwrap().is_none());
}

#[tokio::test]
async fn selected_fallback_winner_claims_once() {
    let mut f = fallback_drawn().await;
    let p = f.p;
    let winner = f.winner.insecure_clone();
    let attacker = f.attacker.insecure_clone();
    let loser = f.loser.insecure_clone();
    let w_null = f.tickets[f.sel].nullifier;

    let ix = f.claim(f.sel, &winner);
    send(&mut f.ctx, &[ix], &[&winner]).await.expect("selected owner claims");
    assert_eq!(round_state(&mut f.ctx, &p, 2).await, (ST_WON, w_null));
    assert!(f.ctx.banks_client.get_account(claim_pda(&p, &w_null)).await.unwrap().is_some());

    // Second claim of the same ticket.
    let ix = f.claim(f.sel, &winner);
    assert_eq!(send(&mut f.ctx, &[ix], &[&winner]).await.unwrap_err(), custom(ALREADY_CLAIMED));
    // Nullifier-only with the stored winner nullifier, and with another one.
    let ix = claim_ix(p, round_pda(&p, 2), attacker.pubkey(), w_null, None);
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(ALREADY_CLAIMED));
    let ix = claim_ix(p, round_pda(&p, 2), attacker.pubkey(), [0x99; 32], None);
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(INVALID_WINNER));
    // Another ticket of the round.
    let ix = f.claim(f.other, &loser);
    assert_eq!(send(&mut f.ctx, &[ix], &[&loser]).await.unwrap_err(), custom(INVALID_WINNER));

    // Round 0 is NoWinner after the fallback: its unclaimed winning ticket no longer claims.
    let t = &f.r0_ticket;
    let ix = claim_ix(p, round_pda(&p, 0), loser.pubkey(), t.nullifier, Some((t.numbers, 0, vec![])));
    assert_eq!(send(&mut f.ctx, &[ix], &[&loser]).await.unwrap_err(), custom(WRONG_STATUS));
}

#[tokio::test]
async fn won_round_without_claim_record_is_closed() {
    // A Won round recorded by the old FallbackDraw (synthetic winner nullifier, no
    // claim record) must not pay out to whoever reads the nullifier.
    let p = Pubkey::new_unique();
    let mut pt = program_test(p);
    let synthetic = [0x5Eu8; 32];
    let round = RoundState {
        disc: ROUND_STATE_DISC,
        round_id: 7,
        tickets_root: [0u8; 32],
        ticket_count: 0,
        total_null_deposited: 0,
        seed_commitment: [0u8; 32],
        seed_revealed: [0u8; 32],
        drawn_numbers: [0u8; 5],
        status: RoundStatus::Won,
        winner_nullifier: synthetic,
        no_winner_count: 0,
    };
    let mut data = vec![0u8; ROUND_STATE_SIZE];
    round.pack_into(&mut data);
    pt.add_account(round_pda(&p, 7), Account { lamports: 10_000_000, data, owner: p, executable: false, rent_epoch: 0 });
    let mut ctx = pt.start_with_context().await;
    let attacker = funded(&mut ctx).await;

    let ix = claim_ix(p, round_pda(&p, 7), attacker.pubkey(), synthetic, None);
    assert_eq!(send(&mut ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(ALREADY_CLAIMED));
    let ix = claim_ix(p, round_pda(&p, 7), attacker.pubkey(), synthetic, Some(([1, 2, 3, 4, 5], 0, vec![])));
    assert_eq!(send(&mut ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(ALREADY_CLAIMED));
    assert!(ctx.banks_client.get_account(claim_pda(&p, &synthetic)).await.unwrap().is_none());
}
