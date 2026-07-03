//! End-to-end flows for the x402 refund escrow, on a real bank via
//! solana-program-test: happy-path settlement, equivocation slash, and
//! timeout refund. The ed25519 precompile instruction is built by hand (signing
//! with the seller's Solana keypair) so the test needs no ed25519-dalek pin.

#![cfg(test)]

use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    ed25519_program,
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::Transaction,
};
use x402_refund_escrow::{
    instruction::EscrowInstruction,
    processor::process,
    receipt::{SettleReceipt, STATUS_FAIL, STATUS_SUCCESS},
    state::{status, Escrow, ESCROW_ACCOUNT_LEN, ESCROW_SEED_PREFIX},
};

fn program_id() -> Pubkey {
    // fixed id for the test bank
    Pubkey::new_from_array([9u8; 32])
}

fn escrow_pda(pc: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ESCROW_SEED_PREFIX, pc], &program_id())
}

/// Build a native ed25519-precompile instruction verifying `signer` over `msg`.
/// Layout matches solana_sdk::ed25519_instruction::new_ed25519_instruction.
fn ed25519_ix(signer: &Keypair, msg: &[u8]) -> Instruction {
    let pk = signer.pubkey().to_bytes();
    let sig = signer.sign_message(msg);
    let sig_bytes: &[u8] = sig.as_ref();
    let pk_off: u16 = 16;
    let sig_off: u16 = pk_off + 32;
    let msg_off: u16 = sig_off + 64;
    let m = u16::MAX;
    let mut d = vec![1u8, 0u8];
    d.extend_from_slice(&sig_off.to_le_bytes());
    d.extend_from_slice(&m.to_le_bytes());
    d.extend_from_slice(&pk_off.to_le_bytes());
    d.extend_from_slice(&m.to_le_bytes());
    d.extend_from_slice(&msg_off.to_le_bytes());
    d.extend_from_slice(&(msg.len() as u16).to_le_bytes());
    d.extend_from_slice(&m.to_le_bytes());
    d.extend_from_slice(&pk);
    d.extend_from_slice(sig_bytes);
    d.extend_from_slice(msg);
    Instruction::new_with_bytes(ed25519_program::id(), &d, vec![])
}

fn open_ix(buyer: &Pubkey, pda: &Pubkey, seller: &Pubkey, amount: u64, pc: [u8; 32], deadline: i64, window: i64) -> Instruction {
    Instruction::new_with_bytes(
        program_id(),
        &EscrowInstruction::OpenEscrow {
            seller: seller.to_bytes(),
            amount,
            payment_commitment: pc,
            deadline,
            dispute_window: window,
        }
        .pack(),
        vec![
            AccountMeta::new(*buyer, true),
            AccountMeta::new(*pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    )
}

fn bond_ix(seller: &Pubkey, pda: &Pubkey, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        program_id(),
        &EscrowInstruction::PostBond { amount }.pack(),
        vec![
            AccountMeta::new(*seller, true),
            AccountMeta::new(*pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    )
}

async fn read_escrow(ctx: &mut ProgramTestContext, pda: &Pubkey) -> Escrow {
    let acct: Account = ctx
        .banks_client
        .get_account(*pda)
        .await
        .unwrap()
        .expect("escrow exists");
    Escrow::unpack_from_slice(&acct.data).unwrap()
}

async fn lamports(ctx: &mut ProgramTestContext, key: &Pubkey) -> u64 {
    ctx.banks_client
        .get_account(*key)
        .await
        .unwrap()
        .map(|a| a.lamports)
        .unwrap_or(0)
}

fn setup() -> ProgramTest {
    ProgramTest::new("x402_refund_escrow", program_id(), processor!(process))
}

async fn fund(ctx: &mut ProgramTestContext, to: &Pubkey, amount: u64) {
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[system_instruction::transfer(&ctx.payer.pubkey(), to, amount)],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
}

const AMOUNT: u64 = 1_000_000;
const BOND: u64 = 2_000_000;

#[tokio::test]
async fn happy_path_settle_pays_seller() {
    let mut ctx = setup().start_with_context().await;
    let buyer = Keypair::from_bytes(&ctx.payer.to_bytes()).unwrap();
    let seller = Keypair::new();
    fund(&mut ctx, &seller.pubkey(), 5_000_000).await;

    let pc = [42u8; 32];
    let (pda, _) = escrow_pda(&pc);
    let deadline = 1_900_000_000i64; // far future vs test clock
    let window = 3600i64;

    // open + bond
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[open_ix(&buyer.pubkey(), &pda, &seller.pubkey(), AMOUNT, pc, deadline, window)],
        Some(&buyer.pubkey()),
        &[&buyer],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[bond_ix(&seller.pubkey(), &pda, BOND)],
        Some(&seller.pubkey()),
        &[&seller],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    let e = read_escrow(&mut ctx, &pda).await;
    assert_eq!(e.status, status::OPEN);
    assert_eq!(e.bond, BOND);
    let pda_before = lamports(&mut ctx, &pda).await;

    // settle success
    let receipt = SettleReceipt {
        payment_commitment: pc,
        status: STATUS_SUCCESS,
        response_hash: [7u8; 32],
        deadline,
    };
    let settle = Instruction::new_with_bytes(
        program_id(),
        &EscrowInstruction::SettleSuccess { receipt_ix_index: 0 }.pack(),
        vec![
            AccountMeta::new_readonly(seller.pubkey(), true),
            AccountMeta::new(pda, false),
            AccountMeta::new(seller.pubkey(), false),
            AccountMeta::new_readonly(sysvar::instructions::id(), false),
        ],
    );
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix(&seller, &receipt.encode()), settle],
        Some(&seller.pubkey()),
        &[&seller],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    let e = read_escrow(&mut ctx, &pda).await;
    assert_eq!(e.status, status::SETTLED_SUCCESS);
    assert_eq!(e.response_hash, [7u8; 32]);
    let pda_after = lamports(&mut ctx, &pda).await;
    assert_eq!(pda_before - pda_after, AMOUNT, "amount left the escrow to the seller");

    // after maturity, close: bond -> seller, rent -> buyer, account reclaimed
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = deadline + window + 10;
    ctx.set_sysvar(&clock);
    let close = Instruction::new_with_bytes(
        program_id(),
        &EscrowInstruction::CloseAfterDispute.pack(),
        vec![
            AccountMeta::new(pda, false),
            AccountMeta::new(seller.pubkey(), false),
            AccountMeta::new(buyer.pubkey(), false),
        ],
    );
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[close], Some(&seller.pubkey()), &[&seller], bh);
    ctx.banks_client.process_transaction(tx).await.unwrap();
    assert_eq!(lamports(&mut ctx, &pda).await, 0, "escrow closed, rent reclaimed");
}

#[tokio::test]
async fn equivocation_slashes_seller_to_buyer() {
    let mut ctx = setup().start_with_context().await;
    let buyer = Keypair::from_bytes(&ctx.payer.to_bytes()).unwrap();
    let seller = Keypair::new();
    fund(&mut ctx, &seller.pubkey(), 5_000_000).await;

    let pc = [43u8; 32];
    let (pda, _) = escrow_pda(&pc);
    let deadline = 1_900_000_000i64;

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[open_ix(&buyer.pubkey(), &pda, &seller.pubkey(), AMOUNT, pc, deadline, 3600)],
        Some(&buyer.pubkey()),
        &[&buyer],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[bond_ix(&seller.pubkey(), &pda, BOND)],
        Some(&seller.pubkey()),
        &[&seller],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    let buyer_before = lamports(&mut ctx, &buyer.pubkey()).await;

    // two conflicting success receipts (same payment, different response) — fraud
    let r1 = SettleReceipt { payment_commitment: pc, status: STATUS_SUCCESS, response_hash: [1u8; 32], deadline };
    let r2 = SettleReceipt { payment_commitment: pc, status: STATUS_FAIL, response_hash: [0u8; 32], deadline };
    let prove = Instruction::new_with_bytes(
        program_id(),
        &EscrowInstruction::ProveEquivocation { ix_index_a: 0, ix_index_b: 1 }.pack(),
        vec![
            AccountMeta::new(pda, false),
            AccountMeta::new(buyer.pubkey(), false),
            AccountMeta::new_readonly(sysvar::instructions::id(), false),
        ],
    );
    // anyone can submit; seller pays fees here for simplicity
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ed25519_ix(&seller, &r1.encode()), ed25519_ix(&seller, &r2.encode()), prove],
        Some(&seller.pubkey()),
        &[&seller],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    // slashing resolves + closes the escrow: account gone, buyer got amount + bond + rent
    assert_eq!(lamports(&mut ctx, &pda).await, 0, "escrow closed after slash");
    let buyer_after = lamports(&mut ctx, &buyer.pubkey()).await;
    assert!(
        buyer_after - buyer_before >= AMOUNT + BOND,
        "amount + bond went to the buyer"
    );
}

#[tokio::test]
async fn timeout_refunds_buyer() {
    let mut ctx = setup().start_with_context().await;
    let buyer = Keypair::from_bytes(&ctx.payer.to_bytes()).unwrap();
    let seller = Keypair::new();
    fund(&mut ctx, &seller.pubkey(), 5_000_000).await;

    // deadline just ahead of the genesis clock, then warp well past it
    let clock = ctx.banks_client.get_sysvar::<solana_sdk::clock::Clock>().await.unwrap();
    let deadline = clock.unix_timestamp + 1;
    let pc = [44u8; 32];
    let (pda, _) = escrow_pda(&pc);

    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[open_ix(&buyer.pubkey(), &pda, &seller.pubkey(), AMOUNT, pc, deadline, 3600)],
        Some(&buyer.pubkey()),
        &[&buyer],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[bond_ix(&seller.pubkey(), &pda, BOND)],
        Some(&seller.pubkey()),
        &[&seller],
        bh,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    // force the clock past the deadline — deterministic, no reliance on warp timing
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_sdk::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = deadline + 1_000;
    ctx.set_sysvar(&clock);

    let buyer_before = lamports(&mut ctx, &buyer.pubkey()).await;
    let refund = Instruction::new_with_bytes(
        program_id(),
        &EscrowInstruction::RefundOnTimeout.pack(),
        vec![
            AccountMeta::new(pda, false),
            AccountMeta::new(buyer.pubkey(), false),
        ],
    );
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[refund], Some(&buyer.pubkey()), &[&buyer], bh);
    ctx.banks_client.process_transaction(tx).await.unwrap();

    let e = read_escrow(&mut ctx, &pda).await;
    assert_eq!(e.status, status::REFUNDED);
    let buyer_after = lamports(&mut ctx, &buyer.pubkey()).await;
    assert!(buyer_after >= buyer_before + AMOUNT - 10_000, "buyer got the escrowed amount back");
}
