// ClaimJackpot must bind the winner to the draw (devnet finding 2026-10-06: in
// the default build the first nullifier claimed on a Drawn round became the
// winner, whatever ticket it belonged to).
//
// A Drawn round is won by an anchored ticket whose numbers are the drawn
// numbers; the ticket leaf commits to the owner key, so only the owner claims.
//
// Run against the SBF binary instead of the native processor with
// `SBF_OUT_DIR=<dir with dark_null_lottery.so> cargo test`.
#![cfg(not(target_os = "windows"))]

use dark_null_lottery::{
    processor::draw_numbers,
    ticket::{sorted_numbers, ticket_leaf, tickets_proof, tickets_root},
};
use solana_program::{hash::hashv, pubkey::Pubkey, system_instruction, system_program};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction, InstructionError},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

const ALREADY_CLAIMED: u32 = 0x6005;
const INVALID_WINNER: u32 = 0x6006;
const WRONG_STATUS: u32 = 0x6007;
const TICKET_NOT_WINNING: u32 = 0x600A;
const INVALID_TICKET_PROOF: u32 = 0x600B;

const ST_WON: u8 = 4;

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

fn init_ix(p: Pubkey, admin: Pubkey) -> Instruction {
    let mut data = vec![0x01u8];
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&[5, 30, 3]);
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

struct Ticket {
    owner: Pubkey,
    numbers: [u8; 5],
    nullifier: [u8; 32],
}

/// A losing number set: the drawn set with one number swapped for an undrawn one.
fn losing(drawn_sorted: [u8; 5]) -> [u8; 5] {
    let spare = (1..=30u8).find(|n| !drawn_sorted.contains(n)).unwrap();
    let mut l = drawn_sorted;
    l[0] = spare;
    sorted_numbers(&l)
}

struct Fixture {
    p: Pubkey,
    ctx: ProgramTestContext,
    winner: Keypair,
    loser: Keypair,
    attacker: Keypair,
    tickets: Vec<Ticket>,
    leaves: Vec<[u8; 32]>,
    drawn: [u8; 5],
}

/// Round 0 committed, anchored with 5 tickets (index 2 is the winning ticket
/// owned by `winner`), and drawn.
async fn drawn_round() -> Fixture {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let winner = funded(&mut ctx).await;
    let loser = funded(&mut ctx).await;
    let attacker = funded(&mut ctx).await;

    let seed = [0x5Au8; 32];
    let drawn = sorted_numbers(&draw_numbers(&seed, 0));
    let lose = losing(drawn);
    let tickets = vec![
        Ticket { owner: loser.pubkey(), numbers: lose, nullifier: [0xA0; 32] },
        Ticket { owner: attacker.pubkey(), numbers: lose, nullifier: [0xA1; 32] },
        Ticket { owner: winner.pubkey(), numbers: drawn, nullifier: [0xA2; 32] },
        Ticket { owner: loser.pubkey(), numbers: lose, nullifier: [0xA3; 32] },
        Ticket { owner: attacker.pubkey(), numbers: lose, nullifier: [0xA4; 32] },
    ];
    let leaves: Vec<[u8; 32]> = tickets
        .iter()
        .map(|t| ticket_leaf(0, &t.owner.to_bytes(), &t.numbers, &t.nullifier))
        .collect();
    let root = tickets_root(&leaves);

    send(&mut ctx, &[init_ix(p, admin)], &[]).await.expect("init");
    send(&mut ctx, &[commit_ix(p, admin, 0, hashv(&[&seed]).to_bytes())], &[]).await.expect("commit");
    send(&mut ctx, &[anchor_ix(p, admin, 0, root, tickets.len() as u64)], &[]).await.expect("anchor");
    send(&mut ctx, &[reveal_ix(p, admin, 0, seed)], &[]).await.expect("reveal");
    Fixture { p, ctx, winner, loser, attacker, tickets, leaves, drawn }
}

impl Fixture {
    fn claim(&self, i: usize, claimant: &Keypair) -> Instruction {
        let t = &self.tickets[i];
        claim_ix(
            self.p,
            round_pda(&self.p, 0),
            claimant.pubkey(),
            t.nullifier,
            Some((t.numbers, i as u64, tickets_proof(&self.leaves, i))),
        )
    }
}

#[tokio::test]
async fn nullifier_only_claim_on_drawn_round_is_rejected() {
    let mut f = drawn_round().await;
    let attacker = f.attacker.insecure_clone();
    let p = f.p;
    // The pre-fix behaviour: any nullifier claimed first on a Drawn round won.
    for n in [[0xA1u8; 32], [0x99u8; 32], [0xA2u8; 32]] {
        let ix = claim_ix(p, round_pda(&p, 0), attacker.pubkey(), n, None);
        let err = send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err();
        assert_eq!(err, custom(INVALID_TICKET_PROOF));
    }
    let (status, w) = round_state(&mut f.ctx, &p, 0).await;
    assert_ne!(status, ST_WON);
    assert_eq!(w, [0u8; 32]);
}

#[tokio::test]
async fn anchored_losing_ticket_cannot_claim() {
    let mut f = drawn_round().await;
    let loser = f.loser.insecure_clone();
    let attacker = f.attacker.insecure_clone();
    // Valid membership proofs, numbers are not the drawn numbers.
    let ix = f.claim(0, &loser);
    assert_eq!(send(&mut f.ctx, &[ix], &[&loser]).await.unwrap_err(), custom(TICKET_NOT_WINNING));
    let ix = f.claim(4, &attacker);
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(TICKET_NOT_WINNING));
}

#[tokio::test]
async fn forged_or_stolen_winning_ticket_cannot_claim() {
    let mut f = drawn_round().await;
    let attacker = f.attacker.insecure_clone();
    let p = f.p;
    let drawn = f.drawn;

    // Attacker relabels his own anchored ticket (index 1) with the drawn numbers.
    let own = &f.tickets[1];
    let ix = claim_ix(p, round_pda(&p, 0), attacker.pubkey(), own.nullifier,
        Some((drawn, 1, tickets_proof(&f.leaves, 1))));
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));

    // Attacker copies the winner's ticket and proof (front-run) and signs himself.
    let ix = f.claim(2, &attacker);
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));

    // Winner's ticket at the wrong index, with a short proof, and past ticket_count.
    let w = &f.tickets[2];
    let winner = f.winner.insecure_clone();
    let ix = claim_ix(p, round_pda(&p, 0), winner.pubkey(), w.nullifier,
        Some((w.numbers, 3, tickets_proof(&f.leaves, 2))));
    assert_eq!(send(&mut f.ctx, &[ix], &[&winner]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));
    let mut short = tickets_proof(&f.leaves, 2);
    short.pop();
    let ix = claim_ix(p, round_pda(&p, 0), winner.pubkey(), w.nullifier, Some((w.numbers, 2, short)));
    assert_eq!(send(&mut f.ctx, &[ix], &[&winner]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));
    let ix = claim_ix(p, round_pda(&p, 0), winner.pubkey(), w.nullifier,
        Some((w.numbers, 5, tickets_proof(&f.leaves, 2))));
    assert_eq!(send(&mut f.ctx, &[ix], &[&winner]).await.unwrap_err(), custom(INVALID_TICKET_PROOF));

    let (status, _) = round_state(&mut f.ctx, &p, 0).await;
    assert_ne!(status, ST_WON);
}

#[tokio::test]
async fn winning_ticket_owner_claims_once() {
    let mut f = drawn_round().await;
    let winner = f.winner.insecure_clone();
    let attacker = f.attacker.insecure_clone();
    let p = f.p;
    let w_null = f.tickets[2].nullifier;

    let ix = f.claim(2, &winner);
    send(&mut f.ctx, &[ix], &[&winner]).await.expect("winner claims");
    let (status, stored) = round_state(&mut f.ctx, &p, 0).await;
    assert_eq!(status, ST_WON);
    assert_eq!(stored, w_null);
    assert!(f.ctx.banks_client.get_account(claim_pda(&p, &w_null)).await.unwrap().is_some());

    // Second claim of the same ticket.
    let ix = f.claim(2, &winner);
    assert_eq!(send(&mut f.ctx, &[ix], &[&winner]).await.unwrap_err(), custom(ALREADY_CLAIMED));
    // Another nullifier on the Won round.
    let ix = claim_ix(p, round_pda(&p, 0), attacker.pubkey(), [0xA1; 32], None);
    assert_eq!(send(&mut f.ctx, &[ix], &[&attacker]).await.unwrap_err(), custom(INVALID_WINNER));
}

#[tokio::test]
async fn single_ticket_round_and_status_checks() {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let owner = funded(&mut ctx).await;
    let seed = [0x21u8; 32];
    let drawn = sorted_numbers(&draw_numbers(&seed, 0));
    let leaf = ticket_leaf(0, &owner.pubkey().to_bytes(), &drawn, &[0x77; 32]);

    send(&mut ctx, &[init_ix(p, admin)], &[]).await.unwrap();
    send(&mut ctx, &[commit_ix(p, admin, 0, hashv(&[&seed]).to_bytes())], &[]).await.unwrap();
    send(&mut ctx, &[anchor_ix(p, admin, 0, tickets_root(&[leaf]), 1)], &[]).await.unwrap();

    // Anchored, not drawn yet.
    let ix = claim_ix(p, round_pda(&p, 0), owner.pubkey(), [0x77; 32], Some((drawn, 0, vec![])));
    assert_eq!(send(&mut ctx, &[ix.clone()], &[&owner]).await.unwrap_err(), custom(WRONG_STATUS));

    send(&mut ctx, &[reveal_ix(p, admin, 0, seed)], &[]).await.unwrap();
    // An account that is not a round PDA is refused.
    let mut foreign = ix.clone();
    foreign.accounts[0] = AccountMeta::new(cfg_pda(&p), false);
    assert_eq!(
        send(&mut ctx, &[foreign], &[&owner]).await.unwrap_err(),
        TransactionError::InstructionError(0, InstructionError::InvalidAccountData)
    );
    // Depth-0 tree: the leaf is the root, empty proof.
    send(&mut ctx, &[ix], &[&owner]).await.expect("single ticket claims");
    let (status, stored) = round_state(&mut ctx, &p, 0).await;
    assert_eq!(status, ST_WON);
    assert_eq!(stored, [0x77; 32]);
}
