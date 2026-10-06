// Program-level tests for the secp256k1 precompile binding, run against the
// DEFAULT build (no cargo features). The precompile at index 0 is the real
// KeccakSecp256k1 precompile, so every signature here is verified by the
// runtime; the tests pin that RegisterEthAgent binds what the precompile
// verified (ETH address, message, signature) in every build.
#![cfg(not(target_os = "windows"))]

use solana_program::{pubkey::Pubkey, system_program, sysvar};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction, InstructionError},
    secp256k1_instruction::new_secp256k1_instruction,
    signature::Signer,
    transaction::{Transaction, TransactionError},
};

const ERR_INVALID_SIGNATURE: u32 = 0x5001;
const ERR_ETH_ADDRESS_MISMATCH: u32 = 0x5008;
const ERR_MESSAGE_MISMATCH: u32 = 0x5009;

// new_secp256k1_instruction layout: [1][11 offsets][eth 20][sig 65][message]
const ETH_OFF: usize = 12;
const SIG_OFF: usize = 32;

fn program_test(program_id: Pubkey) -> ProgramTest {
    ProgramTest::new(
        "dark_secp256k1_auth",
        program_id,
        processor!(dark_secp256k1_auth::process_instruction),
    )
}

fn secret(tag: u8) -> libsecp256k1::SecretKey {
    let mut b = [tag; 32];
    b[0] = 0x01;
    libsecp256k1::SecretKey::parse(&b).unwrap()
}

/// Real precompile ix + the (eth_address, r, s, recovery_id) it carries.
fn precompile(sk: &libsecp256k1::SecretKey, msg: &[u8; 32]) -> (Instruction, [u8; 20], [u8; 32], [u8; 32], u8) {
    let ix = new_secp256k1_instruction(sk, msg);
    let mut eth = [0u8; 20];
    eth.copy_from_slice(&ix.data[ETH_OFF..ETH_OFF + 20]);
    let mut r = [0u8; 32];
    r.copy_from_slice(&ix.data[SIG_OFF..SIG_OFF + 32]);
    let mut s = [0u8; 32];
    s.copy_from_slice(&ix.data[SIG_OFF + 32..SIG_OFF + 64]);
    let rec = ix.data[SIG_OFF + 64];
    (ix, eth, r, s, rec)
}

fn pda(program_id: &Pubkey, eth: &[u8; 20]) -> Pubkey {
    Pubkey::find_program_address(&[b"eth-agent", eth], program_id).0
}

#[allow(clippy::too_many_arguments)]
fn register_ix(
    program_id: Pubkey,
    agent: Pubkey,
    claimed_eth: [u8; 20],
    r: [u8; 32],
    s: [u8; 32],
    rec: u8,
    msg_hash: [u8; 32],
    with_sysvar: bool,
) -> Instruction {
    let mut pda_seed = [0u8; 32];
    pda_seed[12..].copy_from_slice(&claimed_eth);
    let mut data = vec![0x01u8];
    data.extend_from_slice(&r);
    data.extend_from_slice(&s);
    data.push(rec);
    data.extend_from_slice(&msg_hash);
    data.extend_from_slice(&pda_seed);
    data.extend_from_slice(&[0x01u8; 32]);
    data.extend_from_slice(&[0x02u8; 32]);
    let mut accounts = vec![
        AccountMeta::new(pda(&program_id, &claimed_eth), false),
        AccountMeta::new(agent, true),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    if with_sysvar {
        accounts.push(AccountMeta::new_readonly(sysvar::instructions::id(), false));
    }
    Instruction { program_id, accounts, data }
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction]) -> Result<(), TransactionError> {
    let bh = ctx.banks_client.get_new_latest_blockhash(&ctx.last_blockhash).await.unwrap();
    ctx.last_blockhash = bh;
    let mut tx = Transaction::new_with_payer(ixs, Some(&ctx.payer.pubkey()));
    tx.sign(&[&ctx.payer], bh);
    ctx.banks_client.process_transaction(tx).await.map_err(|e| e.unwrap())
}

fn custom(code: u32) -> TransactionError {
    TransactionError::InstructionError(1, InstructionError::Custom(code))
}

#[tokio::test]
async fn register_with_verified_address_message_and_signature() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let msg = [0x42u8; 32];
    let (pre, eth, r, s, rec) = precompile(&secret(3), &msg);

    send(&mut ctx, &[pre, register_ix(program_id, agent, eth, r, s, rec, msg, true)])
        .await
        .expect("register bound to the verified ETH address");
    let acc = ctx.banks_client.get_account(pda(&program_id, &eth)).await.unwrap().expect("record");
    assert_eq!(&acc.data[1..21], &eth);
    assert_eq!(&acc.data[21..53], agent.as_ref());
}

#[tokio::test]
async fn register_rejects_address_other_than_the_one_verified() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let msg = [0x43u8; 32];
    let (pre, _eth, r, s, rec) = precompile(&secret(4), &msg);
    let (_, victim_eth, _, _, _) = precompile(&secret(5), &msg);

    let err = send(&mut ctx, &[pre, register_ix(program_id, agent, victim_eth, r, s, rec, msg, true)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_ETH_ADDRESS_MISMATCH));
}

#[tokio::test]
async fn register_rejects_message_other_than_the_one_verified() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let (pre, eth, r, s, rec) = precompile(&secret(6), &[0x44u8; 32]);

    let err = send(&mut ctx, &[pre, register_ix(program_id, agent, eth, r, s, rec, [0x45u8; 32], true)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_MESSAGE_MISMATCH));
}

#[tokio::test]
async fn register_rejects_signature_fields_other_than_the_ones_verified() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let msg = [0x46u8; 32];
    let (pre, eth, mut r, s, rec) = precompile(&secret(7), &msg);
    r[31] ^= 0x01;

    let err = send(&mut ctx, &[pre, register_ix(program_id, agent, eth, r, s, rec, msg, true)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_INVALID_SIGNATURE));
}

#[tokio::test]
async fn register_requires_precompile_and_sysvar() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let msg = [0x47u8; 32];
    let (pre, eth, r, s, rec) = precompile(&secret(8), &msg);

    let err = send(&mut ctx, &[pre.clone(), register_ix(program_id, agent, eth, r, s, rec, msg, false)])
        .await
        .unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(1, InstructionError::NotEnoughAccountKeys));

    let err = send(&mut ctx, &[register_ix(program_id, agent, eth, r, s, rec, msg, true)])
        .await
        .unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(0, InstructionError::InvalidInstructionData));

    let cu = Instruction {
        program_id: solana_sdk::compute_budget::id(),
        accounts: vec![],
        data: vec![0x02, 0x40, 0x0D, 0x03, 0x00],
    };
    let err = send(&mut ctx, &[cu, register_ix(program_id, agent, eth, r, s, rec, msg, true)])
        .await
        .unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(1, InstructionError::InvalidInstructionData));
}
