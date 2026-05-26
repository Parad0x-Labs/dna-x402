use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use crate::{
    error::DarkNullError,
    instruction::DarkNullifierInstruction,
    state::{NullifierBank, BANK_VERSION, NULLIFIER_BANK_LEN, NULLIFIER_RECORD_LEN},
    BANK_SEED, DOMAIN, NULL_REC_SEED,
};

// ── Entry ─────────────────────────────────────────────────────────────────────

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match DarkNullifierInstruction::unpack(data)? {
        DarkNullifierInstruction::InitBank { shard, epoch } => {
            process_init_bank(program_id, accounts, shard, epoch)
        }
        DarkNullifierInstruction::InsertNullifier { nullifier, epoch } => {
            process_insert_nullifier(program_id, accounts, &nullifier, epoch)
        }
    }
}

// ── bank_index ────────────────────────────────────────────────────────────────

/// Deterministic shard selector: first byte of hashv([nullifier, epoch_le, domain]).
/// With 256 shards the collision-probability per epoch is tolerable for
/// privacy workloads while keeping hot-write pressure uniform.
pub fn bank_index(nullifier: &[u8; 32], epoch: u64, domain: &[u8]) -> u8 {
    hashv(&[nullifier.as_ref(), &epoch.to_le_bytes(), domain]).to_bytes()[0]
}

// ── InitBank ──────────────────────────────────────────────────────────────────

fn process_init_bank(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    shard: u8,
    epoch: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let bank = next_account_info(iter)?;
    let system_pg = next_account_info(iter)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(DarkNullError::MissingPayerSignature.into());
    }
    if !bank.is_writable {
        return Err(DarkNullError::InvalidBankAccount.into());
    }
    if *system_pg.key != system_program::id() {
        return Err(DarkNullError::MissingSystemProgram.into());
    }

    let epoch_le = epoch.to_le_bytes();
    let seeds = [BANK_SEED, &[shard][..], epoch_le.as_ref()];
    let (expected, bump) = Pubkey::find_program_address(&seeds, program_id);
    if expected != *bank.key {
        return Err(DarkNullError::InvalidBankPda.into());
    }

    if bank.data_len() < NULLIFIER_BANK_LEN {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(NULLIFIER_BANK_LEN);
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                bank.key,
                lamports,
                NULLIFIER_BANK_LEN as u64,
                program_id,
            ),
            &[payer.clone(), bank.clone(), system_pg.clone()],
            &[&[BANK_SEED, &[shard], &epoch_le, &[bump]]],
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let state = NullifierBank {
        version: BANK_VERSION,
        bump,
        shard,
        epoch,
        count: 0,
        root: [0u8; 32],
        updated_at: now,
    };
    NullifierBank::pack_into_slice(&state, &mut bank.try_borrow_mut_data()?);
    msg!("dark_nullifier_banks: init shard={} epoch={}", shard, epoch);
    Ok(())
}

// ── InsertNullifier ───────────────────────────────────────────────────────────

fn process_insert_nullifier(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    nullifier: &[u8; 32],
    epoch: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let bank = next_account_info(iter)?;
    let null_rec = next_account_info(iter)?;
    let system_pg = next_account_info(iter)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(DarkNullError::MissingPayerSignature.into());
    }
    if *system_pg.key != system_program::id() {
        return Err(DarkNullError::MissingSystemProgram.into());
    }

    // Load bank state — must already be initialized.
    let mut bank_state = {
        let data = bank.try_borrow_data()?;
        if data.len() < NULLIFIER_BANK_LEN || data[0] != BANK_VERSION {
            return Err(ProgramError::UninitializedAccount);
        }
        NullifierBank::unpack_from_slice(&data)?
    };

    // Verify the correct shard for this nullifier.
    let expected_shard = bank_index(nullifier, epoch, DOMAIN);
    if expected_shard != bank_state.shard {
        return Err(DarkNullError::WrongShard.into());
    }

    // Derive and validate the nullifier-record PDA.
    let (expected_rec, rec_bump) = Pubkey::find_program_address(
        &[NULL_REC_SEED, &[bank_state.shard], nullifier.as_ref()],
        program_id,
    );
    if expected_rec != *null_rec.key {
        return Err(DarkNullError::InvalidNullifierRecordPda.into());
    }

    // Duplicate check: PDA already owned by this program means already inserted.
    if null_rec.owner == program_id {
        return Err(DarkNullError::DuplicateNullifier.into());
    }

    // Allocate the nullifier-record PDA.
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(NULLIFIER_RECORD_LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            null_rec.key,
            lamports,
            NULLIFIER_RECORD_LEN as u64,
            program_id,
        ),
        &[payer.clone(), null_rec.clone(), system_pg.clone()],
        &[&[
            NULL_REC_SEED,
            &[bank_state.shard],
            nullifier.as_ref(),
            &[rec_bump],
        ]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    {
        let mut rec_data = null_rec.try_borrow_mut_data()?;
        rec_data[0] = rec_bump;
        rec_data[1..9].copy_from_slice(&now.to_le_bytes());
    }

    // Accumulate nullifier into bank root.
    bank_state.root = hashv(&[bank_state.root.as_ref(), nullifier.as_ref()]).to_bytes();
    bank_state.count = bank_state
        .count
        .checked_add(1)
        .ok_or(DarkNullError::ArithmeticOverflow)?;
    bank_state.updated_at = now;
    NullifierBank::pack_into_slice(&bank_state, &mut bank.try_borrow_mut_data()?);

    msg!(
        "dark_nullifier_banks: inserted shard={} count={}",
        bank_state.shard,
        bank_state.count
    );
    Ok(())
}
