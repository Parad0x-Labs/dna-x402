//! PDA creation that a pre-funding transfer cannot block.

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

/// Create the PDA `target` with `space` bytes owned by `owner`. If the
/// address already holds lamports (anyone can transfer to it before it
/// exists), top it up to rent exemption and allocate + assign instead of
/// create_account, so pre-funding cannot block the creation. An address that
/// already holds data or belongs to another program fails with `in_use`.
pub fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
    in_use: ProgramError,
) -> ProgramResult {
    let need = Rent::get()?.minimum_balance(space);
    if target.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(payer.key, target.key, need, space as u64, owner),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        )
    } else {
        if !system_program::check_id(target.owner) || !target.data_is_empty() {
            return Err(in_use);
        }
        let top_up = need.saturating_sub(target.lamports());
        if top_up > 0 {
            invoke(
                &system_instruction::transfer(payer.key, target.key, top_up),
                &[payer.clone(), target.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target.key, space as u64),
            &[target.clone(), system.clone()],
            &[seeds],
        )?;
        invoke_signed(&system_instruction::assign(target.key, owner), &[target.clone(), system.clone()], &[seeds])
    }
}
