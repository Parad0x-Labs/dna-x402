use crate::{
    error::SemaphoreError,
    instruction::SemaphoreInstruction,
    state::{
        GROUP_DISC, GROUP_RECORD_SIZE, NULLIFIER_DISC, NULLIFIER_RECORD_SIZE,
        GroupRecord, NullifierRecord,
    },
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

// ⚠️  EXTERNALLY UNAUDITED — test pilot deployment. Not audited by any third party.
//    Deploy with: cargo build-sbf --features mainnet
//    IS_MAINNET_READY=true enables full on-chain verification (signature checks,
//    SPL transfers, precompile validation). Use at your own risk until audited.
#[cfg(feature = "mainnet")]
pub const IS_MAINNET_READY: bool = true;
#[cfg(not(feature = "mainnet"))]
pub const IS_MAINNET_READY: bool = false;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match SemaphoreInstruction::unpack(data)? {
        SemaphoreInstruction::InitGroup { depth, root } =>
            process_init_group(program_id, accounts, depth, root),
        SemaphoreInstruction::UpdateRoot { new_root } =>
            process_update_root(accounts, new_root),
        SemaphoreInstruction::Signal { nullifier_hash, ext_nullifier, signal_hash } =>
            process_signal(program_id, accounts, nullifier_hash, ext_nullifier, signal_hash),
    }
}

// ── InitGroup ─────────────────────────────────────────────────────────────────

fn process_init_group(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    depth:      u8,
    root:       [u8; 32],
) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let group_pda   = next_account_info(iter)?;
    let admin_info  = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_pda, bump) = Pubkey::find_program_address(
        &[b"group", admin_info.key.as_ref()],
        program_id,
    );
    if expected_pda != *group_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(GROUP_RECORD_SIZE);

    invoke_signed(
        &system_instruction::create_account(
            admin_info.key,
            group_pda.key,
            lamports,
            GROUP_RECORD_SIZE as u64,
            program_id,
        ),
        &[admin_info.clone(), group_pda.clone(), system_prog.clone()],
        &[&[b"group", admin_info.key.as_ref(), &[bump]]],
    )?;

    let record = GroupRecord {
        disc:         GROUP_DISC,
        root,
        depth,
        member_count: 0,
        admin:        *admin_info.key,
    };
    let mut data = group_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("dark-semaphore: InitGroup depth={}", depth);
    Ok(())
}

// ── UpdateRoot ────────────────────────────────────────────────────────────────

fn process_update_root(
    accounts: &[AccountInfo],
    new_root: [u8; 32],
) -> ProgramResult {
    let iter       = &mut accounts.iter();
    let group_pda  = next_account_info(iter)?;
    let admin_info = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut data   = group_pda.try_borrow_mut_data()?;
    let mut record = GroupRecord::unpack_from(&data).ok_or(SemaphoreError::GroupNotFound)?;

    if record.admin != *admin_info.key {
        return Err(SemaphoreError::NotAdmin.into());
    }

    record.root         = new_root;
    record.member_count = record.member_count.saturating_add(1);
    let member_count    = record.member_count;
    record.pack_into(&mut data);

    msg!("dark-semaphore: UpdateRoot members={}", member_count);
    Ok(())
}

// ── Signal ────────────────────────────────────────────────────────────────────

fn process_signal(
    program_id:     &Pubkey,
    accounts:       &[AccountInfo],
    nullifier_hash: [u8; 32],
    _ext_nullifier: [u8; 32],
    _signal_hash:   [u8; 32],
) -> ProgramResult {
    let iter          = &mut accounts.iter();
    let group_pda     = next_account_info(iter)?;
    let nullifier_pda = next_account_info(iter)?;
    let signer        = next_account_info(iter)?;
    let system_prog   = next_account_info(iter)?;

    if !signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // IS_MAINNET_READY=true gate: Groth16 ZK membership proof required.
    // Wiring dark_bn254_gate is post-external-audit work.  Until then, Signal
    // hard-fails in mainnet-feature builds so unverified memberships cannot land.
    if IS_MAINNET_READY {
        msg!("dark-semaphore: Signal requires ZK proof (dark_bn254_gate) — not wired");
        return Err(SemaphoreError::ZkNotWired.into());
    }

    // Read admin key from group record (verifies group exists and is valid).
    let admin_key = {
        let group_data = group_pda.try_borrow_data()?;
        let record = GroupRecord::unpack_from(&group_data)
            .ok_or(SemaphoreError::GroupNotFound)?;
        record.admin
    };

    // Re-derive group PDA from admin key and verify consistency.
    let (expected_group_pda, _) = Pubkey::find_program_address(
        &[b"group", admin_key.as_ref()],
        program_id,
    );
    if expected_group_pda != *group_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Derive and verify nullifier PDA: [b"nullifier", admin_key, nullifier_hash]
    let (expected_null_pda, null_bump) = Pubkey::find_program_address(
        &[b"nullifier", admin_key.as_ref(), &nullifier_hash],
        program_id,
    );
    if expected_null_pda != *nullifier_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // If the PDA already exists, nullifier was already spent.
    if !nullifier_pda.data_is_empty() {
        return Err(SemaphoreError::NullifierAlreadyUsed.into());
    }

    // Create nullifier record. The act of creating this PDA is the spend.
    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(NULLIFIER_RECORD_SIZE);

    invoke_signed(
        &system_instruction::create_account(
            signer.key,
            nullifier_pda.key,
            lamports,
            NULLIFIER_RECORD_SIZE as u64,
            program_id,
        ),
        &[signer.clone(), nullifier_pda.clone(), system_prog.clone()],
        &[&[b"nullifier", admin_key.as_ref(), &nullifier_hash, &[null_bump]]],
    )?;

    let mut null_data = nullifier_pda.try_borrow_mut_data()?;
    NullifierRecord { disc: NULLIFIER_DISC, used: true }.pack_into(&mut null_data);

    msg!("dark-semaphore: Signal recorded");
    Ok(())
}
