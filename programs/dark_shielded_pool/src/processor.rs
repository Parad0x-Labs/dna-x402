use crate::error::ShieldedPoolError;
use crate::instruction::PoolInstruction;
use crate::state::{
    NoteLeaf, NullifierRecord, PoolConfig, NOTE_LEAF_LEN, NULLIFIER_RECORD_LEN, POOL_CONFIG_LEN,
    POOL_CONFIG_VERSION,
};
use dark_shielded_verifier::{
    placeholder_verifying_key, verify_groth16, VK_N_PUBLIC,
};
use sha2::{Digest, Sha256};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack},
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

// ─── hash helpers ─────────────────────────────────────────────────────────────

/// Compute note commitment: H("dark-pool-commit-v1" || secret || leaf_index_le)
/// The `secret` never touches the chain — it's chosen client-side.
pub fn commitment_hash(secret: &[u8; 32], leaf_index: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark-pool-commit-v1");
    h.update(secret);
    h.update(leaf_index.to_le_bytes());
    h.finalize().into()
}

/// Compute nullifier: H("dark-pool-null-v1" || secret || pool_config_pubkey)
/// Deterministic from secret + pool; unlinked to commitment without knowing secret.
pub fn nullifier_hash(secret: &[u8; 32], pool_key: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark-pool-null-v1");
    h.update(secret);
    h.update(pool_key);
    h.finalize().into()
}

/// Update the rolling commitment-chain Merkle root.
pub fn update_merkle_root(old_root: &[u8; 32], commitment: &[u8; 32], leaf_index: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark-pool-merkle-v1");
    h.update(old_root);
    h.update(commitment);
    h.update(leaf_index.to_le_bytes());
    h.finalize().into()
}

/// Real Groth16 proof verification using BN254 alt_bn128 pairing syscall.
///
/// Public inputs for ShieldedWithdraw circuit:
///   [0] = nullifier     (must match on-chain nullifier slot)
///   [1] = merkle_root   (must match current pool root)
///
/// The verifying key is the PLACEHOLDER from dark-shielded-verifier.
/// Replace `placeholder_verifying_key()` with the final VK bytes after
/// compiling shielded_withdraw.circom and running the trusted setup.
pub fn verify_proof_groth16(
    proof: &[u8; 256],
    nullifier: &[u8; 32],
    merkle_root: &[u8; 32],
) -> bool {
    let vk = placeholder_verifying_key();
    let public_inputs: [[u8; 32]; VK_N_PUBLIC] = [*nullifier, *merkle_root];
    match verify_groth16(proof, &vk, &public_inputs) {
        Ok(valid) => valid,
        Err(_)    => false,
    }
}

// ─── PDA seeds ────────────────────────────────────────────────────────────────

pub const POOL_CONFIG_SEED: &[u8] = b"pool_config";
pub const POOL_VAULT_SEED:  &[u8] = b"pool_vault";
pub const NOTE_LEAF_SEED:   &[u8] = b"note_leaf";
pub const NULLIFIER_SEED:   &[u8] = b"nullifier";

// ─── entrypoint dispatcher ────────────────────────────────────────────────────

pub fn process_instruction(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    let ix = PoolInstruction::unpack(data)?;
    match ix {
        PoolInstruction::InitPool { denomination } =>
            process_init_pool(program_id, accounts, denomination),
        PoolInstruction::Deposit { commitment } =>
            process_deposit(program_id, accounts, commitment),
        PoolInstruction::Withdraw { nullifier, proof, recipient } =>
            process_withdraw(program_id, accounts, nullifier, proof, recipient),
        PoolInstruction::PausePool  => process_pause(program_id, accounts, true),
        PoolInstruction::ResumePool => process_pause(program_id, accounts, false),
    }
}

// ─── InitPool ─────────────────────────────────────────────────────────────────

fn process_init_pool(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    denomination: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info  = next_account_info(iter)?;
    let pool_vault_info   = next_account_info(iter)?;
    let authority_info    = next_account_info(iter)?;
    let system_program    = next_account_info(iter)?;

    if denomination == 0 {
        return Err(ShieldedPoolError::ZeroDenomination.into());
    }

    // Derive and validate pool_config PDA
    let (pool_config_key, config_bump) = Pubkey::find_program_address(
        &[POOL_CONFIG_SEED, authority_info.key.as_ref()],
        program_id,
    );
    if pool_config_key != *pool_config_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Derive and validate pool_vault PDA
    let (pool_vault_key, vault_bump) = Pubkey::find_program_address(
        &[POOL_VAULT_SEED, pool_config_info.key.as_ref()],
        program_id,
    );
    if pool_vault_key != *pool_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let rent = Rent::get()?;

    // Create pool_config account
    let config_lamports = rent.minimum_balance(POOL_CONFIG_LEN);
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            pool_config_info.key,
            config_lamports,
            POOL_CONFIG_LEN as u64,
            program_id,
        ),
        &[authority_info.clone(), pool_config_info.clone(), system_program.clone()],
        &[&[POOL_CONFIG_SEED, authority_info.key.as_ref(), &[config_bump]]],
    )?;

    // Create pool_vault account (holds deposited lamports above rent)
    let vault_lamports = rent.minimum_balance(0);
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            pool_vault_info.key,
            vault_lamports,
            0,
            program_id,
        ),
        &[authority_info.clone(), pool_vault_info.clone(), system_program.clone()],
        &[&[POOL_VAULT_SEED, pool_config_info.key.as_ref(), &[vault_bump]]],
    )?;

    let config = PoolConfig {
        version:        POOL_CONFIG_VERSION,
        bump:           config_bump,
        is_initialized: true,
        is_paused:      false,
        authority:      authority_info.key.to_bytes(),
        denomination,
        merkle_root:    [0u8; 32],
        note_count:     0,
    };
    PoolConfig::pack(config, &mut pool_config_info.data.borrow_mut())?;

    msg!("ShieldedPool: initialized denomination={}", denomination);
    Ok(())
}

// ─── Deposit ──────────────────────────────────────────────────────────────────

fn process_deposit(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    commitment: [u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info = next_account_info(iter)?;
    let pool_vault_info  = next_account_info(iter)?;
    let note_leaf_info   = next_account_info(iter)?;
    let depositor_info   = next_account_info(iter)?;
    let system_program   = next_account_info(iter)?;

    let mut config = PoolConfig::unpack(&pool_config_info.data.borrow())?;
    if !config.is_initialized() {
        return Err(ShieldedPoolError::NotInitialized.into());
    }
    if config.is_paused {
        return Err(ShieldedPoolError::PoolPaused.into());
    }
    if commitment == [0u8; 32] {
        return Err(ShieldedPoolError::ZeroCommitment.into());
    }

    let leaf_index = config.note_count;
    let clock = Clock::get()?;
    let rent  = Rent::get()?;

    // Create note_leaf PDA
    let (note_leaf_key, leaf_bump) = Pubkey::find_program_address(
        &[NOTE_LEAF_SEED, pool_config_info.key.as_ref(), &leaf_index.to_le_bytes()],
        program_id,
    );
    if note_leaf_key != *note_leaf_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    invoke_signed(
        &system_instruction::create_account(
            depositor_info.key,
            note_leaf_info.key,
            rent.minimum_balance(NOTE_LEAF_LEN),
            NOTE_LEAF_LEN as u64,
            program_id,
        ),
        &[depositor_info.clone(), note_leaf_info.clone(), system_program.clone()],
        &[&[NOTE_LEAF_SEED, pool_config_info.key.as_ref(), &leaf_index.to_le_bytes(), &[leaf_bump]]],
    )?;

    // Transfer denomination lamports: depositor → pool_vault
    invoke_signed(
        &system_instruction::transfer(depositor_info.key, pool_vault_info.key, config.denomination),
        &[depositor_info.clone(), pool_vault_info.clone(), system_program.clone()],
        &[],
    )?;

    // Record note leaf
    let leaf = NoteLeaf {
        bump:         leaf_bump,
        commitment,
        leaf_index,
        deposited_at: clock.unix_timestamp,
    };
    NoteLeaf::pack(leaf, &mut note_leaf_info.data.borrow_mut())?;

    // Update pool state
    config.merkle_root = update_merkle_root(&config.merkle_root, &commitment, leaf_index);
    config.note_count  = config.note_count.checked_add(1)
        .ok_or(ShieldedPoolError::ArithmeticOverflow)?;
    PoolConfig::pack(config, &mut pool_config_info.data.borrow_mut())?;

    msg!("ShieldedPool: deposit leaf_index={}", leaf_index);
    Ok(())
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

fn process_withdraw(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    nullifier:  [u8; 32],
    proof:      [u8; 256],
    recipient:  Pubkey,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info   = next_account_info(iter)?;
    let pool_vault_info    = next_account_info(iter)?;
    let nullifier_rec_info = next_account_info(iter)?;
    let recipient_info     = next_account_info(iter)?;
    let system_program     = next_account_info(iter)?;

    let config = PoolConfig::unpack(&pool_config_info.data.borrow())?;
    if !config.is_initialized() {
        return Err(ShieldedPoolError::NotInitialized.into());
    }
    if config.is_paused {
        return Err(ShieldedPoolError::PoolPaused.into());
    }
    if recipient != *recipient_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Check nullifier PDA doesn't exist yet (existence = already spent)
    let (nullifier_key, null_bump) = Pubkey::find_program_address(
        &[NULLIFIER_SEED, pool_config_info.key.as_ref(), &nullifier],
        program_id,
    );
    if nullifier_key != *nullifier_rec_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if nullifier_rec_info.data_len() > 0 {
        return Err(ShieldedPoolError::NullifierAlreadySpent.into());
    }

    // Verify the ZK proof (stub)
    if !verify_proof_groth16(&proof, &nullifier, &config.merkle_root) {
        return Err(ShieldedPoolError::ProofInvalid.into());
    }

    let rent  = Rent::get()?;
    let clock = Clock::get()?;

    // Check vault has enough lamports
    let vault_balance = pool_vault_info.lamports();
    if vault_balance < config.denomination {
        return Err(ShieldedPoolError::InsufficientFunds.into());
    }

    // Create nullifier record PDA (marks note as spent)
    invoke_signed(
        &system_instruction::create_account(
            recipient_info.key,
            nullifier_rec_info.key,
            rent.minimum_balance(NULLIFIER_RECORD_LEN),
            NULLIFIER_RECORD_LEN as u64,
            program_id,
        ),
        &[recipient_info.clone(), nullifier_rec_info.clone(), system_program.clone()],
        &[&[NULLIFIER_SEED, pool_config_info.key.as_ref(), &nullifier, &[null_bump]]],
    )?;

    let record = NullifierRecord {
        bump: null_bump,
        nullifier,
        spent_at: clock.unix_timestamp,
    };
    NullifierRecord::pack(record, &mut nullifier_rec_info.data.borrow_mut())?;

    // Transfer denomination lamports: pool_vault → recipient
    // Direct lamport manipulation (valid for SOL, no CPI needed)
    **pool_vault_info.lamports.borrow_mut()   -= config.denomination;
    **recipient_info.lamports.borrow_mut()    += config.denomination;

    msg!("ShieldedPool: withdraw denomination={} → {:?}", config.denomination, recipient);
    Ok(())
}

// ─── PausePool / ResumePool ──────────────────────────────────────────────────

fn process_pause(
    _program_id: &Pubkey,
    accounts:    &[AccountInfo],
    pause:       bool,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let pool_config_info = next_account_info(iter)?;
    let authority_info   = next_account_info(iter)?;

    let mut config = PoolConfig::unpack(&pool_config_info.data.borrow())?;
    if config.authority != authority_info.key.to_bytes() {
        return Err(ProgramError::InvalidArgument);
    }
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    config.is_paused = pause;
    PoolConfig::pack(config, &mut pool_config_info.data.borrow_mut())?;
    msg!("ShieldedPool: paused={}", pause);
    Ok(())
}
