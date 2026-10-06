// Relay-rail bucket pools: the pool seed key is a program PDA and Pause/Resume
// requires the admin signer (devnet finding 2026-10-06: bucket authorities were
// keypairs derived from sha256(tag || denom || wallet pubkey), so anyone could
// re-derive them and Pause/Resume the buckets).
#![cfg(not(target_os = "windows"))]

use dark_shielded_pool_program::{
    instruction::PoolInstruction,
    processor::{bucket_authority_address, POOL_CONFIG_SEED, POOL_VAULT_SEED},
};
use solana_program::{hash::hashv, pubkey::Pubkey, system_program};
use solana_program_test::*;
use solana_sdk::{
    instruction::{AccountMeta, Instruction, InstructionError},
    signature::{Keypair, Signer},
    system_instruction,
    transaction::{Transaction, TransactionError},
};

const DENOM: u64 = 100_000_000;

fn program_test(p: Pubkey) -> ProgramTest {
    let mut pt = ProgramTest::new(
        "dark_shielded_pool_program",
        p,
        processor!(dark_shielded_pool_program::processor::process_instruction),
    );
    pt.set_compute_max_units(1_400_000);
    pt
}

fn pool_keys(p: &Pubkey, seed_key: &Pubkey) -> (Pubkey, Pubkey) {
    let cfg = Pubkey::find_program_address(&[POOL_CONFIG_SEED, seed_key.as_ref()], p).0;
    let vault = Pubkey::find_program_address(&[POOL_VAULT_SEED, cfg.as_ref()], p).0;
    (cfg, vault)
}

fn init_bucket_ix(p: Pubkey, admin: Pubkey, bucket: Pubkey, admin_signs: bool) -> Instruction {
    let (cfg, vault) = pool_keys(&p, &bucket);
    Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(cfg, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(bucket, false),
            AccountMeta::new(admin, admin_signs),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PoolInstruction::InitBucketPool { denomination: DENOM }.pack(),
    }
}

fn pause_ix(p: Pubkey, cfg: Pubkey, signer: Pubkey, pause: bool) -> Instruction {
    Instruction {
        program_id: p,
        accounts: vec![AccountMeta::new(cfg, false), AccountMeta::new_readonly(signer, true)],
        data: if pause { PoolInstruction::PausePool } else { PoolInstruction::ResumePool }.pack(),
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

async fn config_bytes(ctx: &mut ProgramTestContext, cfg: Pubkey) -> Vec<u8> {
    ctx.banks_client.get_account(cfg).await.unwrap().expect("config").data
}

/// The old init-buckets derivation: a keypair anyone can recompute from public data.
fn public_data_keypair(admin: &Pubkey) -> Keypair {
    let seed = hashv(&[b"dark-relay-bucket-v3", &DENOM.to_le_bytes(), admin.as_ref()]).to_bytes();
    solana_sdk::signer::keypair::keypair_from_seed(&seed).unwrap()
}

#[tokio::test]
async fn bucket_pool_is_pda_keyed_and_only_admin_can_pause() {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let (bucket, _) = bucket_authority_address(&p, &admin, DENOM);
    let (cfg, _) = pool_keys(&p, &bucket);

    send(&mut ctx, &[init_bucket_ix(p, admin, bucket, true)], &[]).await.expect("init bucket");
    let data = config_bytes(&mut ctx, cfg).await;
    assert_eq!(&data[4..36], admin.as_ref(), "stored authority is the admin");
    assert_eq!(u64::from_le_bytes(data[36..44].try_into().unwrap()), DENOM);
    assert_eq!(data[3], 0);

    // Any other signer, including a keypair recomputed from public data, is refused.
    let outsider = public_data_keypair(&admin);
    send(&mut ctx, &[system_instruction::transfer(&admin, &outsider.pubkey(), 5_000_000)], &[]).await.unwrap();
    let err = send(&mut ctx, &[pause_ix(p, cfg, outsider.pubkey(), true)], &[&outsider]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::InvalidArgument));
    assert_eq!(config_bytes(&mut ctx, cfg).await[3], 0, "still unpaused");

    // The admin pauses and resumes.
    send(&mut ctx, &[pause_ix(p, cfg, admin, true)], &[]).await.expect("admin pause");
    assert_eq!(config_bytes(&mut ctx, cfg).await[3], 1);
    let err = send(&mut ctx, &[pause_ix(p, cfg, outsider.pubkey(), false)], &[&outsider]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::InvalidArgument));
    send(&mut ctx, &[pause_ix(p, cfg, admin, false)], &[]).await.expect("admin resume");
    assert_eq!(config_bytes(&mut ctx, cfg).await[3], 0);

    // Second init of the same bucket fails (account exists).
    assert!(send(&mut ctx, &[init_bucket_ix(p, admin, bucket, true)], &[]).await.is_err());
}

#[tokio::test]
async fn init_bucket_rejects_foreign_bucket_key_and_unsigned_admin() {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let admin = ctx.payer.pubkey();
    let other = Keypair::new();

    // Bucket key derived for a different admin.
    let (foreign, _) = bucket_authority_address(&p, &other.pubkey(), DENOM);
    let err = send(&mut ctx, &[init_bucket_ix(p, admin, foreign, true)], &[]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::InvalidArgument));

    // A plain keypair in the bucket slot (not the PDA).
    let kp = Keypair::new();
    let err = send(&mut ctx, &[init_bucket_ix(p, admin, kp.pubkey(), true)], &[]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::InvalidArgument));

    // Admin that does not sign.
    let (bucket, _) = bucket_authority_address(&p, &other.pubkey(), DENOM);
    let err = send(&mut ctx, &[init_bucket_ix(p, other.pubkey(), bucket, false)], &[]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::MissingRequiredSignature));
}

#[tokio::test]
async fn legacy_init_pool_still_binds_signer_as_authority() {
    let p = Pubkey::new_unique();
    let mut ctx = program_test(p).start_with_context().await;
    let authority = ctx.payer.pubkey();
    let (cfg, vault) = pool_keys(&p, &authority);
    let ix = Instruction {
        program_id: p,
        accounts: vec![
            AccountMeta::new(cfg, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(authority, true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PoolInstruction::InitPool { denomination: DENOM }.pack(),
    };
    send(&mut ctx, &[ix], &[]).await.expect("init pool");
    assert_eq!(&config_bytes(&mut ctx, cfg).await[4..36], authority.as_ref());
    let stranger = Keypair::new();
    send(&mut ctx, &[system_instruction::transfer(&authority, &stranger.pubkey(), 5_000_000)], &[]).await.unwrap();
    let err = send(&mut ctx, &[pause_ix(p, cfg, stranger.pubkey(), true)], &[&stranger]).await.unwrap_err();
    assert_eq!(err, ix_err(InstructionError::InvalidArgument));
}
