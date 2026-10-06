// Program-level tests for the secp256k1 precompile binding, run against the
// DEFAULT build (no cargo features). The precompile at index 0 is the real
// KeccakSecp256k1 precompile, so every signature here is verified by the
// runtime; the tests pin that RegisterEthAgent binds what the precompile
// verified (ETH address, signature, message) and that the signed message is
// the canonical binding message for this program and this agent signer.
//
// Run against the SBF binary instead of the native processor with
// `SBF_OUT_DIR=<dir with dark_secp256k1_auth.so> cargo test`.
#![cfg(not(target_os = "windows"))]

use dark_secp256k1_auth::binding::binding_message;
use solana_program::{keccak, pubkey::Pubkey, system_instruction, system_program, sysvar};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction, InstructionError},
    secp256k1_instruction::{construct_eth_pubkey, new_secp256k1_instruction},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

const ERR_INVALID_SIGNATURE: u32 = 0x5001;
const ERR_AGENT_ALREADY_REGISTERED: u32 = 0x5002;
const ERR_ETH_ADDRESS_MISMATCH: u32 = 0x5008;
const ERR_MESSAGE_MISMATCH: u32 = 0x5009;
const ERR_BINDING_MESSAGE_MISMATCH: u32 = 0x500A;

// new_secp256k1_instruction layout: [1][11 offsets][eth 20][sig 65][message]
const SIG_OFF: usize = 32;

const DOMAIN: [u8; 32] = [0x02u8; 32];
const AUTH: [u8; 32] = [0x01u8; 32];

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

fn eth_of(sk: &libsecp256k1::SecretKey) -> [u8; 20] {
    construct_eth_pubkey(&libsecp256k1::PublicKey::from_secret_key(sk))
}

/// A signed registration bundle: the precompile ix plus the fields the
/// RegisterEthAgent instruction carries.
#[derive(Clone)]
struct Signed {
    pre: Instruction,
    eth: [u8; 20],
    r: [u8; 32],
    s: [u8; 32],
    rec: u8,
    msg_hash: [u8; 32],
}

/// ETH key `sk` signs `message`; the precompile ix carries it.
fn sign(sk: &libsecp256k1::SecretKey, message: &[u8]) -> Signed {
    let pre = new_secp256k1_instruction(sk, message);
    let mut r = [0u8; 32];
    r.copy_from_slice(&pre.data[SIG_OFF..SIG_OFF + 32]);
    let mut s = [0u8; 32];
    s.copy_from_slice(&pre.data[SIG_OFF + 32..SIG_OFF + 64]);
    let rec = pre.data[SIG_OFF + 64];
    Signed { pre, eth: eth_of(sk), r, s, rec, msg_hash: keccak::hash(message).to_bytes() }
}

/// ETH key `sk` signs the canonical binding message for (program, agent).
fn sign_binding(sk: &libsecp256k1::SecretKey, program: &Pubkey, agent: &Pubkey, domain: [u8; 32], auth: [u8; 32]) -> Signed {
    sign(sk, &binding_message(program, agent, &eth_of(sk), &domain, &auth))
}

fn pda(program_id: &Pubkey, eth: &[u8; 20]) -> Pubkey {
    Pubkey::find_program_address(&[b"eth-agent", eth], program_id).0
}

#[allow(clippy::too_many_arguments)]
fn register_ix_raw(
    program_id: Pubkey,
    agent: Pubkey,
    claimed_eth: [u8; 20],
    r: [u8; 32],
    s: [u8; 32],
    rec: u8,
    msg_hash: [u8; 32],
    auth: [u8; 32],
    domain: [u8; 32],
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
    data.extend_from_slice(&auth);
    data.extend_from_slice(&domain);
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

fn register_ix(program_id: Pubkey, agent: Pubkey, b: &Signed) -> Instruction {
    register_ix_raw(program_id, agent, b.eth, b.r, b.s, b.rec, b.msg_hash, AUTH, DOMAIN, true)
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction], extra: &[&Keypair]) -> Result<u64, TransactionError> {
    let bh = ctx.banks_client.get_new_latest_blockhash(&ctx.last_blockhash).await.unwrap();
    ctx.last_blockhash = bh;
    let mut signers: Vec<&Keypair> = vec![&ctx.payer];
    signers.extend_from_slice(extra);
    let mut tx = Transaction::new_with_payer(ixs, Some(&ctx.payer.pubkey()));
    tx.sign(&signers, bh);
    let res = ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap();
    res.result.map(|_| res.metadata.map(|m| m.compute_units_consumed).unwrap_or(0))
}

fn custom(code: u32) -> TransactionError {
    TransactionError::InstructionError(1, InstructionError::Custom(code))
}

async fn funded(ctx: &mut ProgramTestContext) -> Keypair {
    let kp = Keypair::new();
    let payer = ctx.payer.pubkey();
    send(ctx, &[system_instruction::transfer(&payer, &kp.pubkey(), 50_000_000)], &[])
        .await
        .unwrap();
    kp
}

#[tokio::test]
async fn register_with_canonical_binding_message() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let b = sign_binding(&secret(3), &program_id, &agent, DOMAIN, AUTH);

    let cu = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, agent, &b)], &[])
        .await
        .expect("register bound to the verified ETH address");
    eprintln!("RegisterEthAgent compute units (tx): {cu}");
    assert!(cu < 200_000, "fits the default compute budget");
    let acc = ctx.banks_client.get_account(pda(&program_id, &b.eth)).await.unwrap().expect("record");
    assert_eq!(&acc.data[1..21], &b.eth);
    assert_eq!(&acc.data[21..53], agent.as_ref());
    assert_eq!(&acc.data[53..85], &AUTH);
    assert_eq!(&acc.data[85..117], &DOMAIN);

    // Same signature again: the address is taken.
    let err = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, agent, &b)], &[])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_AGENT_ALREADY_REGISTERED));
}

/// Devnet finding 2026-10-06: the signed message did not commit to the agent
/// key, so anyone holding a public ETH signature could submit it first with
/// their own agent key and squat the ETH address.
#[tokio::test]
async fn replayed_signature_for_a_different_agent_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let victim = funded(&mut ctx).await;
    let attacker = funded(&mut ctx).await;
    let b = sign_binding(&secret(9), &program_id, &victim.pubkey(), DOMAIN, AUTH);

    // Attacker front-runs with the victim's precompile ix and fields, signing as agent.
    let err = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, attacker.pubkey(), &b)], &[&attacker])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_BINDING_MESSAGE_MISMATCH));
    assert!(ctx.banks_client.get_account(pda(&program_id, &b.eth)).await.unwrap().is_none(), "address not squatted");

    // The agent the ETH key signed for still registers.
    send(&mut ctx, &[b.pre.clone(), register_ix(program_id, victim.pubkey(), &b)], &[&victim])
        .await
        .expect("victim registers");
    let acc = ctx.banks_client.get_account(pda(&program_id, &b.eth)).await.unwrap().unwrap();
    assert_eq!(&acc.data[21..53], victim.pubkey().as_ref());
}

#[tokio::test]
async fn signature_for_another_program_id_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let b = sign_binding(&secret(10), &Pubkey::new_unique(), &agent, DOMAIN, AUTH);
    let err = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, agent, &b)], &[])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_BINDING_MESSAGE_MISMATCH));
}

#[tokio::test]
async fn domain_or_auth_hash_other_than_the_signed_ones_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let b = sign_binding(&secret(11), &program_id, &agent, DOMAIN, AUTH);

    let ix = register_ix_raw(program_id, agent, b.eth, b.r, b.s, b.rec, b.msg_hash, AUTH, [0x77; 32], true);
    let err = send(&mut ctx, &[b.pre.clone(), ix], &[]).await.unwrap_err();
    assert_eq!(err, custom(ERR_BINDING_MESSAGE_MISMATCH));

    let ix = register_ix_raw(program_id, agent, b.eth, b.r, b.s, b.rec, b.msg_hash, [0x77; 32], DOMAIN, true);
    let err = send(&mut ctx, &[b.pre.clone(), ix], &[]).await.unwrap_err();
    assert_eq!(err, custom(ERR_BINDING_MESSAGE_MISMATCH));
}

/// The pre-fix format (a bare 32-byte message with no agent, program or domain)
/// no longer binds anything.
#[tokio::test]
async fn legacy_unbound_message_is_rejected() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let b = sign(&secret(12), &[0x42u8; 32]);
    let err = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, agent, &b)], &[])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_BINDING_MESSAGE_MISMATCH));
}

#[tokio::test]
async fn register_rejects_address_other_than_the_one_verified() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let b = sign_binding(&secret(4), &program_id, &agent, DOMAIN, AUTH);
    let victim_eth = eth_of(&secret(5));

    let ix = register_ix_raw(program_id, agent, victim_eth, b.r, b.s, b.rec, b.msg_hash, AUTH, DOMAIN, true);
    let err = send(&mut ctx, &[b.pre.clone(), ix], &[]).await.unwrap_err();
    assert_eq!(err, custom(ERR_ETH_ADDRESS_MISMATCH));
}

#[tokio::test]
async fn register_rejects_msg_hash_other_than_the_signed_digest() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let mut b = sign_binding(&secret(6), &program_id, &agent, DOMAIN, AUTH);
    b.msg_hash = [0x45u8; 32];

    let err = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, agent, &b)], &[])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_MESSAGE_MISMATCH));
}

#[tokio::test]
async fn register_rejects_signature_fields_other_than_the_ones_verified() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let mut b = sign_binding(&secret(7), &program_id, &agent, DOMAIN, AUTH);
    b.r[31] ^= 0x01;

    let err = send(&mut ctx, &[b.pre.clone(), register_ix(program_id, agent, &b)], &[])
        .await
        .unwrap_err();
    assert_eq!(err, custom(ERR_INVALID_SIGNATURE));
}

#[tokio::test]
async fn register_requires_precompile_and_sysvar() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let agent = ctx.payer.pubkey();
    let b = sign_binding(&secret(8), &program_id, &agent, DOMAIN, AUTH);

    let no_sysvar = register_ix_raw(program_id, agent, b.eth, b.r, b.s, b.rec, b.msg_hash, AUTH, DOMAIN, false);
    let err = send(&mut ctx, &[b.pre.clone(), no_sysvar], &[]).await.unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(1, InstructionError::NotEnoughAccountKeys));

    let err = send(&mut ctx, &[register_ix(program_id, agent, &b)], &[]).await.unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(0, InstructionError::InvalidInstructionData));

    let cu = Instruction {
        program_id: solana_sdk::compute_budget::id(),
        accounts: vec![],
        data: vec![0x02, 0x40, 0x0D, 0x03, 0x00],
    };
    let err = send(&mut ctx, &[cu, register_ix(program_id, agent, &b)], &[]).await.unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(1, InstructionError::InvalidInstructionData));
}
