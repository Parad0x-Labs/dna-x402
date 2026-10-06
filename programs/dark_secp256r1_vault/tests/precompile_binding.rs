// Program-level tests for the secp256r1 precompile binding, run against the
// DEFAULT build (no cargo features). They pin that Register and
// VerifyPasskeySignal bind the precompile-verified (pubkey, message) tuple in
// every build, not only with `--features mainnet`.
//
// solana-program-test 1.18 has no secp256r1 precompile (SIMD-0075 landed in
// Agave 2.x), so a no-op builtin is mounted at the precompile address. The
// signature itself is checked by the runtime on a real cluster; what these
// tests cover is the program-side binding, which is the part that was
// compiled out of default builds.
#![cfg(not(target_os = "windows"))]

use dark_secp256r1_vault::{
    processor::SECP256R1_PROGRAM_ID,
    secp256r1::compress_xy,
    state::{VaultRecord, VAULT_DISC, VAULT_RECORD_SIZE, VAULT_VERSION},
};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey, system_program,
    sysvar,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction, InstructionError},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

const ERR_PUBKEY_MISMATCH: u32 = 0x4009;
const ERR_NOT_BOUND: u32 = 0x400A;
const ERR_CHALLENGE_NOT_SIGNED: u32 = 0x400B;

fn noop_precompile(_: &Pubkey, _: &[AccountInfo], _: &[u8]) -> ProgramResult {
    Ok(())
}

fn program_test(program_id: Pubkey) -> ProgramTest {
    let mut pt = ProgramTest::new(
        "dark_secp256r1_vault",
        program_id,
        processor!(dark_secp256r1_vault::process_instruction),
    );
    pt.add_program("secp256r1_noop", SECP256R1_PROGRAM_ID, processor!(noop_precompile));
    pt
}

/// One-signature, self-referencing secp256r1 precompile data.
fn precompile_ix(pubkey: &[u8; 33], msg: &[u8]) -> Instruction {
    let pk_off = 16usize;
    let sig_off = pk_off + 33;
    let msg_off = sig_off + 64;
    let mut d = vec![1u8, 0u8];
    for v in [sig_off as u16, u16::MAX, pk_off as u16, u16::MAX, msg_off as u16, msg.len() as u16, u16::MAX] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(pubkey);
    d.extend_from_slice(&[0x5Au8; 64]);
    d.extend_from_slice(msg);
    Instruction { program_id: SECP256R1_PROGRAM_ID, accounts: vec![], data: d }
}

fn vault_pda(program_id: &Pubkey, wallet: &Pubkey, cred: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"passkey-vault", wallet.as_ref(), cred], program_id).0
}

fn key_xy(tag: u8) -> ([u8; 32], [u8; 32]) {
    let mut x = [tag; 32];
    x[0] = 0x10;
    let mut y = [tag.wrapping_add(1); 32];
    y[31] = tag & 1;
    (x, y)
}

fn register_ix(
    program_id: Pubkey,
    wallet: Pubkey,
    cred: [u8; 32],
    challenge: [u8; 32],
    x: [u8; 32],
    y: [u8; 32],
    with_sysvar: bool,
) -> Instruction {
    let mut data = vec![0x01u8];
    data.extend_from_slice(&[0x77u8; 32]); // agent pubkey
    data.extend_from_slice(&cred);
    data.extend_from_slice(&challenge);
    data.extend_from_slice(&x);
    data.extend_from_slice(&y);
    let mut accounts = vec![
        AccountMeta::new(vault_pda(&program_id, &wallet, &cred), false),
        AccountMeta::new(wallet, true),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    if with_sysvar {
        accounts.push(AccountMeta::new_readonly(sysvar::instructions::id(), false));
    }
    Instruction { program_id, accounts, data }
}

fn signal_ix(program_id: Pubkey, wallet: Pubkey, cred: [u8; 32], challenge: [u8; 32], next: [u8; 32]) -> Instruction {
    let mut data = vec![0x02u8];
    data.extend_from_slice(&challenge);
    data.extend_from_slice(&next);
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(vault_pda(&program_id, &wallet, &cred), false),
            AccountMeta::new_readonly(wallet, true),
            AccountMeta::new_readonly(sysvar::instructions::id(), false),
        ],
        data,
    }
}

async fn send(ctx: &mut ProgramTestContext, ixs: &[Instruction]) -> Result<(), TransactionError> {
    let bh = ctx.banks_client.get_new_latest_blockhash(&ctx.last_blockhash).await.unwrap();
    ctx.last_blockhash = bh;
    let mut tx = Transaction::new_with_payer(ixs, Some(&ctx.payer.pubkey()));
    tx.sign(&[&ctx.payer], bh);
    ctx.banks_client.process_transaction(tx).await.map_err(|e| e.unwrap())
}

fn custom(idx: u8, code: u32) -> TransactionError {
    TransactionError::InstructionError(idx, InstructionError::Custom(code))
}

async fn read_vault(ctx: &mut ProgramTestContext, pda: Pubkey) -> VaultRecord {
    let acc = ctx.banks_client.get_account(pda).await.unwrap().expect("vault exists");
    VaultRecord::unpack_from(&acc.data).expect("vault parses")
}

#[tokio::test]
async fn register_binds_verified_key_and_signin_rotates() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let wallet = ctx.payer.pubkey();
    let cred = [0x21u8; 32];
    let c1 = [0xC1u8; 32];
    let c2 = [0xC2u8; 32];
    let (x, y) = key_xy(3);
    let pk = compress_xy(&x, &y);

    send(&mut ctx, &[precompile_ix(&pk, &c1), register_ix(program_id, wallet, cred, c1, x, y, true)])
        .await
        .expect("register with matching precompile key");
    let rec = read_vault(&mut ctx, vault_pda(&program_id, &wallet, &cred)).await;
    assert_eq!(rec.has_p256, 1);
    assert_eq!(rec.p256_compressed, pk);

    send(&mut ctx, &[precompile_ix(&pk, &c1), signal_ix(program_id, wallet, cred, c1, c2)])
        .await
        .expect("bound key signing the live challenge signs in");
    let rec = read_vault(&mut ctx, vault_pda(&program_id, &wallet, &cred)).await;
    assert_eq!(rec.challenge_hash, c2);

    // The consumed challenge cannot be replayed.
    let err = send(&mut ctx, &[precompile_ix(&pk, &c1), signal_ix(program_id, wallet, cred, c1, c2)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(1, 0x4004));
}

#[tokio::test]
async fn register_rejects_key_other_than_the_one_verified() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let wallet = ctx.payer.pubkey();
    let cred = [0x22u8; 32];
    let (x, y) = key_xy(5);
    let (ox, oy) = key_xy(8);
    let other = compress_xy(&ox, &oy);

    let err = send(&mut ctx, &[precompile_ix(&other, &[1u8; 32]), register_ix(program_id, wallet, cred, [1u8; 32], x, y, true)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(1, ERR_PUBKEY_MISMATCH));
}

#[tokio::test]
async fn register_requires_precompile_and_sysvar() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let wallet = ctx.payer.pubkey();
    let cred = [0x23u8; 32];
    let (x, y) = key_xy(6);

    // No instructions sysvar account.
    let err = send(&mut ctx, &[precompile_ix(&compress_xy(&x, &y), &[0u8; 32]), register_ix(program_id, wallet, cred, [0u8; 32], x, y, false)])
        .await
        .unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(1, InstructionError::NotEnoughAccountKeys));

    // Register alone at index 0: no precompile in front of it.
    let err = send(&mut ctx, &[register_ix(program_id, wallet, cred, [0u8; 32], x, y, true)])
        .await
        .unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(0, InstructionError::InvalidInstructionData));

    // A different program at index 0 does not count as a precompile assertion.
    let mut fake = precompile_ix(&compress_xy(&x, &y), &[0u8; 32]);
    fake.program_id = solana_sdk::compute_budget::id();
    fake.data = vec![0x02, 0x40, 0x0D, 0x03, 0x00];
    let err = send(&mut ctx, &[fake, register_ix(program_id, wallet, cred, [0u8; 32], x, y, true)])
        .await
        .unwrap_err();
    assert_eq!(err, TransactionError::InstructionError(1, InstructionError::InvalidInstructionData));
}

#[tokio::test]
async fn signin_rejects_wrong_message_and_wrong_key() {
    let program_id = Pubkey::new_unique();
    let mut ctx = program_test(program_id).start_with_context().await;
    let wallet = ctx.payer.pubkey();
    let cred = [0x24u8; 32];
    let c1 = [0xA1u8; 32];
    let c2 = [0xA2u8; 32];
    let (x, y) = key_xy(9);
    let pk = compress_xy(&x, &y);
    let (ox, oy) = key_xy(12);
    let other = compress_xy(&ox, &oy);

    send(&mut ctx, &[precompile_ix(&pk, &c1), register_ix(program_id, wallet, cred, c1, x, y, true)])
        .await
        .expect("register");

    // Bound key signed a different message than the live challenge.
    let err = send(&mut ctx, &[precompile_ix(&pk, &[0xEEu8; 32]), signal_ix(program_id, wallet, cred, c1, c2)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(1, ERR_CHALLENGE_NOT_SIGNED));

    // A different key signed the live challenge.
    let err = send(&mut ctx, &[precompile_ix(&other, &c1), signal_ix(program_id, wallet, cred, c1, c2)])
        .await
        .unwrap_err();
    assert_eq!(err, custom(1, ERR_PUBKEY_MISMATCH));

    // Rejections did not rotate the challenge: the real sign-in still works.
    let rec = read_vault(&mut ctx, vault_pda(&program_id, &wallet, &cred)).await;
    assert_eq!(rec.challenge_hash, c1);
    send(&mut ctx, &[precompile_ix(&pk, &c1), signal_ix(program_id, wallet, cred, c1, c2)])
        .await
        .expect("sign-in after rejected attempts");
}

#[tokio::test]
async fn legacy_unbound_vault_cannot_sign_in() {
    let program_id = Pubkey::new_unique();
    let wallet = Keypair::new();
    let cred = [0x25u8; 32];
    let c1 = [0xB1u8; 32];
    let rec = VaultRecord {
        disc: VAULT_DISC,
        wallet_pubkey: wallet.pubkey().to_bytes(),
        credential_id_hash: cred,
        agent_pubkey: [0u8; 32],
        challenge_hash: c1,
        registered_at: 1,
        version: VAULT_VERSION,
        enc_key_nonce: [0u8; 12],
        enc_key_ciphertext: [0u8; 64],
        enc_key_tag: [0u8; 16],
        has_enc_key: 0,
        p256_compressed: [0u8; 33],
        has_p256: 0,
    };
    let mut data = vec![0u8; VAULT_RECORD_SIZE];
    rec.pack_into(&mut data);
    let mut pt = program_test(program_id);
    pt.add_account(
        vault_pda(&program_id, &wallet.pubkey(), &cred),
        Account { lamports: 10_000_000, data, owner: program_id, executable: false, rent_epoch: 0 },
    );
    let mut ctx = pt.start_with_context().await;

    let (x, y) = key_xy(1);
    let ix = signal_ix(program_id, wallet.pubkey(), cred, c1, [0xB2u8; 32]);
    let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut tx = Transaction::new_with_payer(&[precompile_ix(&compress_xy(&x, &y), &c1), ix], Some(&ctx.payer.pubkey()));
    tx.sign(&[&ctx.payer, &wallet], bh);
    let err = ctx.banks_client.process_transaction(tx).await.unwrap_err().unwrap();
    assert_eq!(err, custom(1, ERR_NOT_BOUND));
}
