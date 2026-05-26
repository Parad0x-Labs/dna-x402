use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use crate::{
    error::ReceiptError,
    instruction::ReceiptInstruction,
    state::{ReceiptRoot, RECEIPT_NULLIFIER_LEN, RECEIPT_ROOT_LEN, ROOT_VERSION},
    NULL_SEED, ROOT_SEED,
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match ReceiptInstruction::unpack(data)? {
        ReceiptInstruction::InitRoot => process_init_root(program_id, accounts),
        ReceiptInstruction::UpdateRoot { root } => process_update_root(program_id, accounts, root),
        ReceiptInstruction::RedeemReceipt { nullifier } => {
            process_redeem_receipt(program_id, accounts, &nullifier)
        }
    }
}

fn process_init_root(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let root_pda = next_account_info(iter)?;
    let sys_prog = next_account_info(iter)?;

    if !authority.is_signer {
        return Err(ReceiptError::MissingAuthority.into());
    }
    if *sys_prog.key != system_program::id() {
        return Err(ReceiptError::MissingSystemProgram.into());
    }

    let (expected, bump) =
        Pubkey::find_program_address(&[ROOT_SEED, authority.key.as_ref()], program_id);
    if expected != *root_pda.key {
        return Err(ReceiptError::InvalidRootPda.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(RECEIPT_ROOT_LEN);
    invoke_signed(
        &system_instruction::create_account(
            authority.key,
            root_pda.key,
            lamports,
            RECEIPT_ROOT_LEN as u64,
            program_id,
        ),
        &[authority.clone(), root_pda.clone(), sys_prog.clone()],
        &[&[ROOT_SEED, authority.key.as_ref(), &[bump]]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let state = ReceiptRoot {
        version: ROOT_VERSION,
        bump,
        authority: authority.key.to_bytes(),
        root: [0u8; 32],
        count: 0,
        updated_at: now,
    };
    ReceiptRoot::pack_into_slice(&state, &mut root_pda.try_borrow_mut_data()?);
    msg!(
        "dark_compressed_receipts: init root authority={}",
        authority.key
    );
    Ok(())
}

fn process_update_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    root: [u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let root_pda = next_account_info(iter)?;

    if !authority.is_signer {
        return Err(ReceiptError::MissingAuthority.into());
    }

    let mut state = ReceiptRoot::unpack_from_slice(&root_pda.try_borrow_data()?)?;

    if state.authority != authority.key.to_bytes() {
        return Err(ReceiptError::WrongAuthority.into());
    }

    let (expected, _) =
        Pubkey::find_program_address(&[ROOT_SEED, authority.key.as_ref()], program_id);
    if expected != *root_pda.key {
        return Err(ReceiptError::InvalidRootPda.into());
    }

    state.root = root;
    state.count = state
        .count
        .checked_add(1)
        .ok_or(ReceiptError::ArithmeticOverflow)?;
    state.updated_at = Clock::get()?.unix_timestamp;
    ReceiptRoot::pack_into_slice(&state, &mut root_pda.try_borrow_mut_data()?);
    msg!(
        "dark_compressed_receipts: updated root count={}",
        state.count
    );
    Ok(())
}

fn process_redeem_receipt(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    nullifier: &[u8; 32],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let _root = next_account_info(iter)?; // readable — verified root exists
    let null_pda = next_account_info(iter)?;
    let sys_prog = next_account_info(iter)?;

    if !payer.is_signer || !payer.is_writable {
        return Err(ReceiptError::MissingAuthority.into());
    }
    if *sys_prog.key != system_program::id() {
        return Err(ReceiptError::MissingSystemProgram.into());
    }

    let (expected_null, null_bump) =
        Pubkey::find_program_address(&[NULL_SEED, nullifier.as_ref()], program_id);
    if expected_null != *null_pda.key {
        return Err(ReceiptError::InvalidNullifierPda.into());
    }

    // Duplicate redemption check
    if null_pda.owner == program_id {
        return Err(ReceiptError::AlreadyRedeemed.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(RECEIPT_NULLIFIER_LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            null_pda.key,
            lamports,
            RECEIPT_NULLIFIER_LEN as u64,
            program_id,
        ),
        &[payer.clone(), null_pda.clone(), sys_prog.clone()],
        &[&[NULL_SEED, nullifier.as_ref(), &[null_bump]]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let mut rec = null_pda.try_borrow_mut_data()?;
    rec[0] = null_bump;
    rec[1..9].copy_from_slice(&now.to_le_bytes());

    msg!("dark_compressed_receipts: redeemed nullifier");
    Ok(())
}
