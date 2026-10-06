// AnchorTickets and RevealDraw must require the admin stored in the
// `[b"lottery-config"]` PDA, not just any signer (devnet finding 2026-10-06:
// a non-admin signer set tickets_root / ticket_count on a Committed round).
#![cfg(not(target_os = "windows"))]

use solana_program::{hash::hashv, pubkey::Pubkey, system_program};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction, InstructionError},
    signature::{Keypair, Signer},
    system_instruction,
    transaction::{Transaction, TransactionError},
};

const NOT_ADMIN: u32 = 0x6008;

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

fn anchor_ix(p: Pubkey, signer: Pubkey, id: u64, cfg: Pubkey) -> Instruction {
    let mut data = vec![0x03u8];
    data.extend_from_slice(&[0x5Eu8; 32]);
    data.extend_from_slice(&10u64.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(round_pda(&p, id), false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new_readonly(cfg, false),
        ],
        data,
    }
}

fn reveal_ix(p: Pubkey, signer: Pubkey, id: u64, seed: [u8; 32]) -> Instruction {
    let mut data = vec![0x04u8];
    data.extend_from_slice(&seed);
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(round_pda(&p, id), false),
            AccountMeta::new_readonly(signer, true),
            AccountMeta::new_readonly(cfg_pda(&p), false),
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

fn ix_err(e: InstructionError) -> TransactionError {
    TransactionError::InstructionError(0, e)
}

/// Round status byte: disc(1) round_id(8) tickets_root(32) ticket_count(8)
/// total(8) seed_commitment(32) seed_revealed(32) drawn(5) status(1).
async fn round_status(ctx: &mut ProgramTestContext, p: &Pubkey, id: u64) -> (u8, [u8; 32]) {
    let acc = ctx.banks_client.get_account(round_pda(p, id)).await.unwrap().unwrap();
    let mut root = [0u8; 32];
    root.copy_from_slice(&acc.data[9..41]);
    (acc.data[1 + 8 + 32 + 8 + 8 + 32 + 32 + 5], root)
}

#[tokio::test]
async fn only_config_admin_can_anchor_and_reveal() {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let attacker = Keypair::new();
    let seed = [0x33u8; 32];
    let commitment = hashv(&[&seed]).to_bytes();

    send(&mut ctx, &[init_ix(p, admin)], &[]).await.expect("init");
    send(&mut ctx, &[system_instruction::transfer(&admin, &attacker.pubkey(), 10_000_000)], &[]).await.unwrap();
    send(&mut ctx, &[commit_ix(p, admin, 0, commitment)], &[]).await.expect("admin commit");
    let (status0, _) = round_status(&mut ctx, &p, 0).await;

    // Non-admin signer cannot anchor tickets.
    let err = send(&mut ctx, &[anchor_ix(p, attacker.pubkey(), 0, cfg_pda(&p))], &[&attacker]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::Custom(NOT_ADMIN)));
    let (status, root) = round_status(&mut ctx, &p, 0).await;
    assert_eq!(status, status0, "round state untouched");
    assert_eq!(root, [0u8; 32]);

    // Missing config account.
    let mut short = anchor_ix(p, attacker.pubkey(), 0, cfg_pda(&p));
    short.accounts.pop();
    let err = send(&mut ctx, &[short], &[&attacker]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::NotEnoughAccountKeys));

    // A look-alike config that is not the canonical PDA is refused.
    let err = send(&mut ctx, &[anchor_ix(p, attacker.pubkey(), 0, attacker.pubkey())], &[&attacker]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::InvalidAccountData));

    // Admin anchors.
    send(&mut ctx, &[anchor_ix(p, admin, 0, cfg_pda(&p))], &[]).await.expect("admin anchor");
    let (_, root) = round_status(&mut ctx, &p, 0).await;
    assert_eq!(root, [0x5Eu8; 32]);

    // Non-admin cannot reveal even with the committed seed.
    let err = send(&mut ctx, &[reveal_ix(p, attacker.pubkey(), 0, seed)], &[&attacker]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::Custom(NOT_ADMIN)));

    // Admin reveals.
    send(&mut ctx, &[reveal_ix(p, admin, 0, seed)], &[]).await.expect("admin reveal");
}

#[tokio::test]
async fn non_admin_cannot_commit() {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let attacker = Keypair::new();
    send(&mut ctx, &[init_ix(p, admin)], &[]).await.expect("init");
    send(&mut ctx, &[system_instruction::transfer(&admin, &attacker.pubkey(), 10_000_000)], &[]).await.unwrap();
    let mut ix = commit_ix(p, attacker.pubkey(), 0, [1u8; 32]);
    ix.accounts[2] = AccountMeta::new(attacker.pubkey(), true);
    let err = send(&mut ctx, &[ix], &[&attacker]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::Custom(NOT_ADMIN)));
}
