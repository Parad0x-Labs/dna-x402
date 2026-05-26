use crate::{
    error::ScratchError,
    instruction::ScratchInstruction,
    state::{ScratchAccount, SCRATCH_LEN, SCRATCH_VERSION},
    SCRATCH_SEED,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match ScratchInstruction::unpack(data)? {
        ScratchInstruction::CreateScratch {
            expires_at_slot,
            tag,
        } => process_create(program_id, accounts, expires_at_slot, tag),
        ScratchInstruction::CloseScratch => process_close(program_id, accounts),
        ScratchInstruction::CleanupExpired => process_cleanup(program_id, accounts),
    }
}

fn process_create(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    expires_at_slot: u64,
    tag: [u8; 8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?;
    let scratch = next_account_info(iter)?;
    let system = next_account_info(iter)?;

    if !owner.is_signer {
        return Err(ScratchError::MissingOwnerSignature.into());
    }
    if *system.key != solana_program::system_program::id() {
        return Err(ScratchError::MissingSystemProgram.into());
    }

    let (pda, bump) =
        Pubkey::find_program_address(&[SCRATCH_SEED, owner.key.as_ref(), &tag], program_id);
    if pda != *scratch.key {
        return Err(ScratchError::InvalidPda.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(SCRATCH_LEN);
    let clock = Clock::get()?;

    invoke_signed(
        &system_instruction::create_account(
            owner.key,
            &pda,
            lamports,
            SCRATCH_LEN as u64,
            program_id,
        ),
        &[owner.clone(), scratch.clone(), system.clone()],
        &[&[SCRATCH_SEED, owner.key.as_ref(), &tag, &[bump]]],
    )?;

    let state = ScratchAccount {
        version: SCRATCH_VERSION,
        bump,
        owner: owner.key.to_bytes(),
        expires_at_slot,
        tag,
        created_at_slot: clock.slot,
    };
    state.pack_into(&mut scratch.try_borrow_mut_data()?);
    Ok(())
}

fn process_close(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let owner = next_account_info(iter)?;
    let scratch = next_account_info(iter)?;

    if !owner.is_signer {
        return Err(ScratchError::MissingOwnerSignature.into());
    }

    let state = ScratchAccount::unpack(&scratch.try_borrow_data()?)
        .ok_or(ProgramError::InvalidAccountData)?;
    if state.owner != owner.key.to_bytes() {
        return Err(ScratchError::MissingOwnerSignature.into());
    }

    // Drain lamports to owner
    let lamports = scratch.lamports();
    **owner.try_borrow_mut_lamports()? = owner
        .lamports()
        .checked_add(lamports)
        .ok_or(ScratchError::ArithmeticOverflow)?;
    **scratch.try_borrow_mut_lamports()? = 0;
    scratch.try_borrow_mut_data()?.fill(0);
    Ok(())
}

fn process_cleanup(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let keeper = next_account_info(iter)?;
    let scratch = next_account_info(iter)?;

    let clock = Clock::get()?;
    let state = ScratchAccount::unpack(&scratch.try_borrow_data()?)
        .ok_or(ProgramError::InvalidAccountData)?;

    if clock.slot <= state.expires_at_slot {
        return Err(ScratchError::NotExpired.into());
    }

    // Drain lamports to keeper (permissionless cleanup bounty)
    let lamports = scratch.lamports();
    **keeper.try_borrow_mut_lamports()? = keeper
        .lamports()
        .checked_add(lamports)
        .ok_or(ScratchError::ArithmeticOverflow)?;
    **scratch.try_borrow_mut_lamports()? = 0;
    scratch.try_borrow_mut_data()?.fill(0);
    Ok(())
}
