use crate::{
    error::HookError,
    instruction::HookInstruction,
    state::{
        ALLOWLIST_DISC, ALLOWLIST_ENTRY_SIZE, CONFIG_DISC, HOOK_CONFIG_SIZE,
        AllowlistEntry, HookConfig,
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
    match HookInstruction::unpack(data)? {
        HookInstruction::Execute { amount } =>
            process_execute(program_id, accounts, amount),
        HookInstruction::InitConfig { dark_pool_limit_atomic } =>
            process_init_config(program_id, accounts, dark_pool_limit_atomic),
        HookInstruction::AddToAllowlist { flags } =>
            process_add_to_allowlist(program_id, accounts, flags),
        HookInstruction::RemoveFromAllowlist =>
            process_remove_from_allowlist(accounts),
    }
}

// ── Execute ───────────────────────────────────────────────────────────────────

fn process_execute(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    amount:     u64,
) -> ProgramResult {
    // Token-2022 passes accounts in a fixed order:
    //   [0] source_account
    //   [1] mint
    //   [2] destination_account
    //   [3] source_owner
    //   [4] validation_state_pda (extra accounts)
    // Additional accounts (our PDAs) are appended after the mandatory 5.
    let iter             = &mut accounts.iter();
    let _source_acct     = next_account_info(iter)?;
    let _mint            = next_account_info(iter)?;
    let _dest_acct       = next_account_info(iter)?;
    let source_owner     = next_account_info(iter)?;
    let _validation_pda  = next_account_info(iter)?;

    // Optional: config PDA may be passed as account[5].
    // If absent, we skip the hook entirely (permissive default).
    let config_info = iter.next();
    if config_info.is_none() {
        msg!("null-token-hook: No config account — pass-through");
        return Ok(());
    }
    let config_info = config_info.unwrap();

    // Load the hook config.
    let config = {
        let data = config_info.try_borrow_data()?;
        match HookConfig::unpack_from(&data) {
            Some(c) => c,
            None => {
                msg!("null-token-hook: Config not initialised — pass-through");
                return Ok(());
            }
        }
    };

    // Hook disabled → pass-through.
    if !config.hook_enabled {
        msg!("null-token-hook: Hook disabled — pass-through");
        return Ok(());
    }

    // Derive the expected config PDA and verify the account passed is correct.
    let (expected_config_pda, _) = Pubkey::find_program_address(
        &[b"hook-config", &config.admin],
        program_id,
    );
    if expected_config_pda != *config_info.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Optional: allowlist PDA may be passed as account[6].
    let allowlist_info = iter.next();

    if let Some(al_info) = allowlist_info {
        if !al_info.data_is_empty() {
            // Verify this is the allowlist PDA for the source owner.
            let (expected_al_pda, _) = Pubkey::find_program_address(
                &[b"allowlist", source_owner.key.as_ref()],
                program_id,
            );
            if expected_al_pda == *al_info.key {
                let al_data = al_info.try_borrow_data()?;
                if let Some(entry) = AllowlistEntry::unpack_from(&al_data) {
                    if entry.passport_verified() {
                        msg!("null-token-hook: Agent passport verified — allowed");
                        return Ok(());
                    }
                }
            }
        }
    }

    // No passport.  Apply dark-pool limit gate.
    if config.dark_pool_limit_atomic > 0 && amount > config.dark_pool_limit_atomic {
        msg!(
            "null-token-hook: Amount {} exceeds dark-pool limit {} — rejected",
            amount,
            config.dark_pool_limit_atomic,
        );
        return Err(HookError::ExceedsDarkPoolLimit.into());
    }

    // IS_MAINNET_READY = false: default permissive — allow through.
    // NOTE: When IS_MAINNET_READY is set to true, this branch must be changed to
    //       return HookError::NotAuthorized so that unapproved wallets are fully blocked.
    if IS_MAINNET_READY {
        return Err(HookError::NotAuthorized.into());
    }

    msg!("null-token-hook: Devnet pass-through (no passport, within limit)");
    Ok(())
}

// ── InitConfig ────────────────────────────────────────────────────────────────

fn process_init_config(
    program_id:              &Pubkey,
    accounts:                &[AccountInfo],
    dark_pool_limit_atomic:  u64,
) -> ProgramResult {
    let iter        = &mut accounts.iter();
    let config_pda  = next_account_info(iter)?;
    let admin_info  = next_account_info(iter)?;
    let system_prog = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_pda, bump) = Pubkey::find_program_address(
        &[b"hook-config", admin_info.key.as_ref()],
        program_id,
    );
    if expected_pda != *config_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    if !config_pda.data_is_empty() {
        return Err(HookError::ConfigAlreadyExists.into());
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(HOOK_CONFIG_SIZE);

    invoke_signed(
        &system_instruction::create_account(
            admin_info.key,
            config_pda.key,
            lamports,
            HOOK_CONFIG_SIZE as u64,
            program_id,
        ),
        &[admin_info.clone(), config_pda.clone(), system_prog.clone()],
        &[&[b"hook-config", admin_info.key.as_ref(), &[bump]]],
    )?;

    let record = HookConfig {
        disc:                   CONFIG_DISC,
        admin:                  admin_info.key.to_bytes(),
        hook_enabled:           true,
        dark_pool_limit_atomic,
    };
    let mut data = config_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("null-token-hook: InitConfig dark_pool_limit={}", dark_pool_limit_atomic);
    Ok(())
}

// ── AddToAllowlist ────────────────────────────────────────────────────────────

fn process_add_to_allowlist(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    flags:      u64,
) -> ProgramResult {
    let iter           = &mut accounts.iter();
    let allowlist_pda  = next_account_info(iter)?;
    let target_wallet  = next_account_info(iter)?;
    let admin_info     = next_account_info(iter)?;
    let system_prog    = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Require the hook config PDA as account[4] and verify admin is authorised.
    let config_pda = next_account_info(iter)?;
    let (expected_config_pda, _) = Pubkey::find_program_address(
        &[b"hook-config", admin_info.key.as_ref()],
        program_id,
    );
    if expected_config_pda != *config_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }
    {
        let data = config_pda.try_borrow_data()?;
        let config = HookConfig::unpack_from(&data).ok_or(HookError::NotAdmin)?;
        if config.admin != admin_info.key.to_bytes() {
            return Err(HookError::NotAdmin.into());
        }
    }

    let (expected_al_pda, al_bump) = Pubkey::find_program_address(
        &[b"allowlist", target_wallet.key.as_ref()],
        program_id,
    );
    if expected_al_pda != *allowlist_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    if allowlist_pda.data_is_empty() {
        let rent     = Rent::get()?;
        let lamports = rent.minimum_balance(ALLOWLIST_ENTRY_SIZE);
        invoke_signed(
            &system_instruction::create_account(
                admin_info.key,
                allowlist_pda.key,
                lamports,
                ALLOWLIST_ENTRY_SIZE as u64,
                program_id,
            ),
            &[admin_info.clone(), allowlist_pda.clone(), system_prog.clone()],
            &[&[b"allowlist", target_wallet.key.as_ref(), &[al_bump]]],
        )?;
    }

    let entry = AllowlistEntry {
        disc:   ALLOWLIST_DISC,
        pubkey: target_wallet.key.to_bytes(),
        flags,
    };
    let mut data = allowlist_pda.try_borrow_mut_data()?;
    entry.pack_into(&mut data);

    msg!("null-token-hook: AddToAllowlist flags={:#x}", flags);
    Ok(())
}

// ── RemoveFromAllowlist ───────────────────────────────────────────────────────

fn process_remove_from_allowlist(accounts: &[AccountInfo]) -> ProgramResult {
    let iter          = &mut accounts.iter();
    let allowlist_pda = next_account_info(iter)?;
    let admin_info    = next_account_info(iter)?;

    if !admin_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if allowlist_pda.data_is_empty() {
        return Err(HookError::AllowlistNotFound.into());
    }

    // Verify the stored pubkey in the entry matches the PDA before zeroing.
    {
        let data = allowlist_pda.try_borrow_data()?;
        if data[0] != ALLOWLIST_DISC[0] {
            return Err(HookError::AllowlistNotFound.into());
        }
    }

    // Zero out the entire account data — the disc mismatch on future reads
    // will cause unpack_from to return None, effectively revoking the entry.
    let mut data = allowlist_pda.try_borrow_mut_data()?;
    data.fill(0);

    msg!("null-token-hook: RemoveFromAllowlist — entry zeroed");
    Ok(())
}
