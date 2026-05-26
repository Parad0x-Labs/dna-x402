use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use crate::{
    error::DarkChaffError,
    instruction::ChaffInstruction,
    state::{
        ChaffBatch, BATCH_VERSION, CHAFF_BATCH_LEN, CHAFF_INTENT_LEN, EPOCH_SECONDS, MAX_CHAFF,
        MIN_CHAFF,
    },
    BATCH_SEED, INTENT_SEED,
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match ChaffInstruction::unpack(data)? {
        ChaffInstruction::CreateChaffBatch { count, epoch } => {
            process_create(program_id, accounts, count, epoch)
        }
        ChaffInstruction::CloseChaffBatch { epoch } => process_close(program_id, accounts, epoch),
    }
}

// ── CreateChaffBatch ──────────────────────────────────────────────────────────

fn process_create(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    count: u8,
    epoch: u64,
) -> ProgramResult {
    if count < MIN_CHAFF || count > MAX_CHAFF {
        return Err(DarkChaffError::InvalidCount.into());
    }

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let batch = next_account_info(iter)?;
    let sys_prog = next_account_info(iter)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(DarkChaffError::MissingPayerSignature.into());
    }
    if *sys_prog.key != system_program::id() {
        return Err(DarkChaffError::MissingSystemProgram.into());
    }

    let (expected_batch, batch_bump) = Pubkey::find_program_address(
        &[BATCH_SEED, payer.key.as_ref(), &epoch.to_le_bytes()],
        program_id,
    );
    if expected_batch != *batch.key {
        return Err(DarkChaffError::InvalidBatchPda.into());
    }

    let rent = Rent::get()?;
    let lamps_b = rent.minimum_balance(CHAFF_BATCH_LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            batch.key,
            lamps_b,
            CHAFF_BATCH_LEN as u64,
            program_id,
        ),
        &[payer.clone(), batch.clone(), sys_prog.clone()],
        &[&[
            BATCH_SEED,
            payer.key.as_ref(),
            &epoch.to_le_bytes(),
            &[batch_bump],
        ]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let state = ChaffBatch {
        version: BATCH_VERSION,
        bump: batch_bump,
        count,
        epoch,
        payer: payer.key.to_bytes(),
        created_at: now,
    };
    state.pack_into(&mut batch.try_borrow_mut_data()?);

    // Create each intent PDA
    let lamps_i = rent.minimum_balance(CHAFF_INTENT_LEN);
    for idx in 0..count {
        let intent = next_account_info(iter)?;
        let (expected_intent, intent_bump) =
            Pubkey::find_program_address(&[INTENT_SEED, &epoch.to_le_bytes(), &[idx]], program_id);
        if expected_intent != *intent.key {
            return Err(DarkChaffError::InvalidIntentPda.into());
        }
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                intent.key,
                lamps_i,
                CHAFF_INTENT_LEN as u64,
                program_id,
            ),
            &[payer.clone(), intent.clone(), sys_prog.clone()],
            &[&[INTENT_SEED, &epoch.to_le_bytes(), &[idx], &[intent_bump]]],
        )?;
        let mut d = intent.try_borrow_mut_data()?;
        d[0] = intent_bump;
        d[1..9].copy_from_slice(&epoch.to_le_bytes());
        d[9] = idx;
        d[10..18].copy_from_slice(&now.to_le_bytes());
    }

    msg!(
        "dark_chaff: created {} chaff intents epoch={}",
        count,
        epoch
    );
    Ok(())
}

// ── CloseChaffBatch ───────────────────────────────────────────────────────────

fn process_close(program_id: &Pubkey, accounts: &[AccountInfo], epoch: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let batch = next_account_info(iter)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(DarkChaffError::MissingPayerSignature.into());
    }

    // Epoch guard: cannot close future epochs
    let now_unix = Clock::get()?.unix_timestamp;
    let current_epoch = (now_unix as u64) / EPOCH_SECONDS;
    if epoch > current_epoch {
        return Err(DarkChaffError::FutureEpoch.into());
    }

    // Load batch state
    let state =
        ChaffBatch::unpack(&batch.try_borrow_data()?).ok_or(DarkChaffError::UninitializedBatch)?;
    let count = state.count;

    // Verify batch PDA
    let (expected_batch, _) = Pubkey::find_program_address(
        &[BATCH_SEED, payer.key.as_ref(), &epoch.to_le_bytes()],
        program_id,
    );
    if expected_batch != *batch.key {
        return Err(DarkChaffError::InvalidBatchPda.into());
    }

    // Close intent PDAs first
    for idx in 0..count {
        let intent = next_account_info(iter)?;
        let (expected_intent, _) =
            Pubkey::find_program_address(&[INTENT_SEED, &epoch.to_le_bytes(), &[idx]], program_id);
        if expected_intent != *intent.key {
            return Err(DarkChaffError::InvalidIntentPda.into());
        }
        drain_to_payer(intent, payer)?;
    }

    // Close batch PDA
    drain_to_payer(batch, payer)?;

    msg!("dark_chaff: closed {} chaff intents epoch={}", count, epoch);
    Ok(())
}

fn drain_to_payer<'a>(account: &AccountInfo<'a>, payer: &AccountInfo<'a>) -> ProgramResult {
    let lamports = account.lamports();
    **payer.try_borrow_mut_lamports()? = payer
        .lamports()
        .checked_add(lamports)
        .ok_or(DarkChaffError::ArithmeticOverflow)?;
    **account.try_borrow_mut_lamports()? = 0;
    account.try_borrow_mut_data()?.fill(0);
    Ok(())
}
