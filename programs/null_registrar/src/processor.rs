use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
    program::invoke_signed,
    clock::Clock,
};

use crate::{
    error::RegistrarError,
    instruction::{validate_name, RegistrarInstruction},
    state::{
        NullDomain,    NULL_DOMAIN_SIZE,    NULL_DOMAIN_DISC,
        RegistryConfig, REGISTRY_CONFIG_SIZE, REGISTRY_CONFIG_DISC,
    },
    IS_MAINNET_READY,
};

/// Registry config PDA seed.
pub const REGISTRY_SEED: &[u8] = b"null-registry";
/// Per-domain PDA prefix seed.
pub const DOMAIN_SEED:   &[u8] = b"null-domain";

pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    let ix = RegistrarInstruction::unpack(data)?;

    match ix {
        RegistrarInstruction::InitRegistry { registration_fee, null_mint, treasury } => {
            process_init_registry(program_id, accounts, registration_fee, null_mint, treasury)
        }
        RegistrarInstruction::Register { name, content_hash } => {
            process_register(program_id, accounts, name, content_hash)
        }
        RegistrarInstruction::UpdateContent { name, new_content_hash } => {
            process_update_content(program_id, accounts, name, new_content_hash)
        }
        RegistrarInstruction::Transfer { name, new_owner } => {
            process_transfer(program_id, accounts, name, new_owner)
        }
        RegistrarInstruction::Resolve { name } => {
            process_resolve(program_id, accounts, name)
        }
    }
}

// ─── 0x01 InitRegistry ───────────────────────────────────────────────────────

fn process_init_registry(
    program_id:       &Pubkey,
    accounts:         &[AccountInfo],
    registration_fee: u64,
    null_mint:        [u8; 32],
    treasury:         [u8; 32],
) -> ProgramResult {
    let iter     = &mut accounts.iter();
    let payer    = next_account_info(iter)?;   // [signer, writable]
    let config   = next_account_info(iter)?;   // [writable] registry config PDA
    let sys_prog = next_account_info(iter)?;   // system program

    let (config_pda, bump) =
        Pubkey::find_program_address(&[REGISTRY_SEED], program_id);
    if config.key != &config_pda {
        return Err(ProgramError::InvalidArgument);
    }
    if !config.data_is_empty() {
        // Already initialised — idempotency guard
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent         = Rent::get()?;
    let lamports_req = rent.minimum_balance(REGISTRY_CONFIG_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            config.key,
            lamports_req,
            REGISTRY_CONFIG_SIZE as u64,
            program_id,
        ),
        &[payer.clone(), config.clone(), sys_prog.clone()],
        &[&[REGISTRY_SEED, &[bump]]],
    )?;

    let cfg = RegistryConfig {
        disc:              REGISTRY_CONFIG_DISC,
        authority:         payer.key.to_bytes(),
        registration_fee,
        null_mint,
        treasury,
        total_registered:  0,
        bump,
    };
    let mut data = config.try_borrow_mut_data()?;
    cfg.pack_into(&mut data);

    msg!("null-registrar: registry initialised  fee={} bump={}", registration_fee, bump);
    Ok(())
}

// ─── 0x02 Register ───────────────────────────────────────────────────────────

fn process_register(
    program_id:   &Pubkey,
    accounts:     &[AccountInfo],
    name:         [u8; 64],
    content_hash: [u8; 32],
) -> ProgramResult {
    let printable_len = validate_name(&name)?;

    let iter        = &mut accounts.iter();
    let payer       = next_account_info(iter)?;   // [signer, writable]
    let domain_acct = next_account_info(iter)?;   // [writable] NullDomain PDA
    let config_acct = next_account_info(iter)?;   // [writable] RegistryConfig PDA
    let _null_src   = next_account_info(iter)?;   // NULL token source ATA (future SPL CPI)
    let _treasury   = next_account_info(iter)?;   // NULL treasury ATA (future SPL CPI)
    let sys_prog    = next_account_info(iter)?;   // system program

    // Verify domain PDA — seed is the printable bytes only (max 32 bytes, no
    // null-padding). Solana enforces a 32-byte per-seed limit; using the full
    // 64-byte name buffer would exceed that limit. The printable slice is
    // unique per name so PDA uniqueness is preserved.
    let (domain_pda, bump) =
        Pubkey::find_program_address(&[DOMAIN_SEED, &name[..printable_len]], program_id);
    if domain_acct.key != &domain_pda {
        return Err(ProgramError::InvalidArgument);
    }

    // Not already registered
    if !domain_acct.data_is_empty() {
        return Err(ProgramError::Custom(RegistrarError::NameAlreadyRegistered as u32));
    }

    // Read registry config
    let config_raw = config_acct.try_borrow_data()?;
    let mut cfg = RegistryConfig::unpack_from(&config_raw)
        .ok_or(ProgramError::InvalidAccountData)?;
    drop(config_raw);

    // ── SPL NULL transfer (gated behind IS_MAINNET_READY) ──────────────────
    if IS_MAINNET_READY {
        // TODO: invoke spl_token::transfer CPI from _null_src → _treasury
        // for cfg.registration_fee atomic NULL tokens.
        // Guarded until post-audit.
        msg!("null-registrar: SPL transfer CPI (mainnet path, not yet wired)");
    } else {
        msg!(
            "null-registrar: IS_MAINNET_READY=false  fee={}  NOT debited (pilot mode)",
            cfg.registration_fee
        );
    }

    // Create domain PDA — signer seeds must match find_program_address seeds
    // (printable bytes only, not the full 64-byte padded buffer).
    let rent         = Rent::get()?;
    let lamports_req = rent.minimum_balance(NULL_DOMAIN_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            domain_acct.key,
            lamports_req,
            NULL_DOMAIN_SIZE as u64,
            program_id,
        ),
        &[payer.clone(), domain_acct.clone(), sys_prog.clone()],
        &[&[DOMAIN_SEED, &name[..printable_len], &[bump]]],
    )?;

    // Write domain state
    let clock    = Clock::get()?;
    let domain   = NullDomain {
        disc:          NULL_DOMAIN_DISC,
        name,
        owner:         payer.key.to_bytes(),
        content_hash,
        registered_at: clock.unix_timestamp,
        expires_at:    0, // founding domains never expire
        null_paid:     cfg.registration_fee,
        bump,
    };
    {
        let mut d = domain_acct.try_borrow_mut_data()?;
        domain.pack_into(&mut d);
    }

    // Increment registry counter
    cfg.total_registered = cfg.total_registered
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    {
        let mut cfg_data = config_acct.try_borrow_mut_data()?;
        cfg.pack_into(&mut cfg_data);
    }

    msg!(
        "null-registrar: registered  name_len={}  pda={}  bump={}",
        printable_len,
        domain_pda,
        bump,
    );
    Ok(())
}

// ─── 0x03 UpdateContent ──────────────────────────────────────────────────────

fn process_update_content(
    program_id:       &Pubkey,
    accounts:         &[AccountInfo],
    name:             [u8; 64],
    new_content_hash: [u8; 32],
) -> ProgramResult {
    validate_name(&name)?;

    let iter        = &mut accounts.iter();
    let owner       = next_account_info(iter)?;   // [signer]
    let domain_acct = next_account_info(iter)?;   // [writable] NullDomain PDA

    // Verify PDA address — printable bytes only (see process_register comment)
    let printable_len = validate_name(&name)?;
    let (domain_pda, _bump) =
        Pubkey::find_program_address(&[DOMAIN_SEED, &name[..printable_len]], program_id);
    if domain_acct.key != &domain_pda {
        return Err(ProgramError::InvalidArgument);
    }

    let mut data   = domain_acct.try_borrow_mut_data()?;
    let mut domain = NullDomain::unpack_from(&data)
        .ok_or(ProgramError::InvalidAccountData)?;

    // Owner check
    if domain.owner != owner.key.to_bytes() {
        return Err(ProgramError::Custom(RegistrarError::NotOwner as u32));
    }
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    domain.content_hash = new_content_hash;
    domain.pack_into(&mut data);

    msg!("null-registrar: content updated  pda={}", domain_pda);
    Ok(())
}

// ─── 0x04 Transfer ───────────────────────────────────────────────────────────

fn process_transfer(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    name:       [u8; 64],
    new_owner:  [u8; 32],
) -> ProgramResult {
    validate_name(&name)?;

    let iter        = &mut accounts.iter();
    let owner       = next_account_info(iter)?;   // [signer]
    let domain_acct = next_account_info(iter)?;   // [writable] NullDomain PDA

    let printable_len_t = validate_name(&name)?;
    let (domain_pda, _bump) =
        Pubkey::find_program_address(&[DOMAIN_SEED, &name[..printable_len_t]], program_id);
    if domain_acct.key != &domain_pda {
        return Err(ProgramError::InvalidArgument);
    }

    let mut data   = domain_acct.try_borrow_mut_data()?;
    let mut domain = NullDomain::unpack_from(&data)
        .ok_or(ProgramError::InvalidAccountData)?;

    if domain.owner != owner.key.to_bytes() {
        return Err(ProgramError::Custom(RegistrarError::NotOwner as u32));
    }
    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    domain.owner = new_owner;
    domain.pack_into(&mut data);

    msg!("null-registrar: transferred  pda={}", domain_pda);
    Ok(())
}

// ─── 0x05 Resolve ────────────────────────────────────────────────────────────

fn process_resolve(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    name:       [u8; 64],
) -> ProgramResult {
    validate_name(&name)?;

    let iter        = &mut accounts.iter();
    let domain_acct = next_account_info(iter)?;   // [readonly] NullDomain PDA

    let printable_len_r = validate_name(&name)?;
    let (domain_pda, _bump) =
        Pubkey::find_program_address(&[DOMAIN_SEED, &name[..printable_len_r]], program_id);
    if domain_acct.key != &domain_pda {
        return Err(ProgramError::InvalidArgument);
    }

    let data   = domain_acct.try_borrow_data()?;
    let domain = NullDomain::unpack_from(&data)
        .ok_or(ProgramError::InvalidAccountData)?;

    // Emit content_hash into the transaction log for indexers
    msg!(
        "null-registrar: resolve  pda={}  content_hash={:?}",
        domain_pda,
        &domain.content_hash,
    );
    Ok(())
}
