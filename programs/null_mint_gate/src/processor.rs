use crate::{
    error::MintGateError,
    instruction::MintGateInstruction,
    state::{
        AGENT_EMISSION_RECORD_DISC, AGENT_EMISSION_RECORD_SIZE,
        EMISSION_CONFIG_DISC, EMISSION_CONFIG_SIZE,
        AgentEmissionRecord, EmissionConfig,
    },
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
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

// ─────────────────────────────────────────────────────────────────────────────
// Public entry-point
// ─────────────────────────────────────────────────────────────────────────────

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match MintGateInstruction::unpack(data)? {
        MintGateInstruction::InitEmission {
            null_mint,
            max_null_per_claim,
            epoch_duration,
            epoch_null_cap,
        } => process_init(
            program_id,
            accounts,
            null_mint,
            max_null_per_claim,
            epoch_duration,
            epoch_null_cap,
        ),

        MintGateInstruction::ClaimEmission {
            nullifier_hash,
            receipt_commitment,
            null_amount_atomic,
        } => process_claim(
            program_id,
            accounts,
            nullifier_hash,
            receipt_commitment,
            null_amount_atomic,
        ),

        MintGateInstruction::AdvanceEpoch { new_epoch } => {
            process_advance_epoch(program_id, accounts, new_epoch)
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x01 InitEmission
// ─────────────────────────────────────────────────────────────────────────────

fn process_init(
    program_id:         &Pubkey,
    accounts:           &[AccountInfo],
    null_mint:          [u8; 32],
    max_null_per_claim: u64,
    epoch_duration:     u64,
    epoch_null_cap:     u64,
) -> ProgramResult {
    let iter          = &mut accounts.iter();
    let emission_cfg  = next_account_info(iter)?;
    let admin         = next_account_info(iter)?;
    let system_prog   = next_account_info(iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_pda, bump) =
        Pubkey::find_program_address(&[b"emission-config"], program_id);
    if expected_pda != *emission_cfg.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if !emission_cfg.data_is_empty() {
        return Err(MintGateError::AlreadyInitialized.into());
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(EMISSION_CONFIG_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            admin.key,
            emission_cfg.key,
            lamports,
            EMISSION_CONFIG_SIZE as u64,
            program_id,
        ),
        &[admin.clone(), emission_cfg.clone(), system_prog.clone()],
        &[&[b"emission-config", &[bump]]],
    )?;

    let config = EmissionConfig {
        disc:                      EMISSION_CONFIG_DISC,
        admin:                     admin.key.to_bytes(),
        null_mint,
        max_null_per_claim_atomic: max_null_per_claim,
        epoch_duration_slots:      epoch_duration,
        epoch_null_cap_atomic:     epoch_null_cap,
        current_epoch:             0,
        epoch_null_minted_atomic:  0,
        is_active:                 true,
    };
    let mut data = emission_cfg.try_borrow_mut_data()?;
    config.pack_into(&mut data);

    msg!("dark-null-mint-gate: InitEmission");
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x02 ClaimEmission
// ─────────────────────────────────────────────────────────────────────────────

fn process_claim(
    program_id:         &Pubkey,
    accounts:           &[AccountInfo],
    nullifier_hash:     [u8; 32],
    receipt_commitment: [u8; 32],
    null_amount_atomic: u64,
) -> ProgramResult {
    let iter             = &mut accounts.iter();
    let emission_cfg     = next_account_info(iter)?;
    let emission_record  = next_account_info(iter)?;
    let agent            = next_account_info(iter)?;
    let system_prog      = next_account_info(iter)?;

    if !agent.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ── Read and validate config ──────────────────────────────────────────
    let mut cfg = {
        let data = emission_cfg.try_borrow_data()?;
        EmissionConfig::unpack_from(&data)
            .ok_or(ProgramError::InvalidAccountData)?
    };

    if !cfg.is_active {
        return Err(MintGateError::MintGateNotActive.into());
    }
    if null_amount_atomic > cfg.max_null_per_claim_atomic {
        return Err(MintGateError::ExceedsClaimLimit.into());
    }
    let new_minted = cfg
        .epoch_null_minted_atomic
        .checked_add(null_amount_atomic)
        .ok_or(ProgramError::InvalidArgument)?;
    if new_minted > cfg.epoch_null_cap_atomic {
        return Err(MintGateError::EpochCapExceeded.into());
    }

    // ── Validate emission_record PDA ──────────────────────────────────────
    let (expected_record_pda, record_bump) =
        Pubkey::find_program_address(&[b"emission", &nullifier_hash], program_id);
    if expected_record_pda != *emission_record.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if !emission_record.data_is_empty() {
        // PDA already exists → nullifier already claimed
        return Err(MintGateError::AlreadyClaimed.into());
    }

    // ── Create AgentEmissionRecord PDA ────────────────────────────────────
    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(AGENT_EMISSION_RECORD_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            agent.key,
            emission_record.key,
            lamports,
            AGENT_EMISSION_RECORD_SIZE as u64,
            program_id,
        ),
        &[agent.clone(), emission_record.clone(), system_prog.clone()],
        &[&[b"emission", &nullifier_hash, &[record_bump]]],
    )?;

    let slot = Clock::get().map(|c| c.slot).unwrap_or(0);
    let record = AgentEmissionRecord {
        disc:               AGENT_EMISSION_RECORD_DISC,
        nullifier_hash,
        receipt_commitment,
        null_amount_atomic,
        epoch:              cfg.current_epoch,
        claimed_at_slot:    slot,
        agent_pubkey:       agent.key.to_bytes(),
    };
    {
        let mut rec_data = emission_record.try_borrow_mut_data()?;
        record.pack_into(&mut rec_data);
    }

    // ── Update epoch minted counter ───────────────────────────────────────
    cfg.epoch_null_minted_atomic = new_minted;
    {
        let mut cfg_data = emission_cfg.try_borrow_mut_data()?;
        cfg.pack_into(&mut cfg_data);
    }

    // IS_MAINNET_READY=false: skip SPL mint CPI, record is sufficient.
    if IS_MAINNET_READY {
        // TODO: invoke SPL token mint-to CPI with null_mint and agent ATA.
    }

    msg!(
        "dark-null-mint-gate: Emission recorded {} atomic NULL",
        null_amount_atomic
    );
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 0x03 AdvanceEpoch
// ─────────────────────────────────────────────────────────────────────────────

fn process_advance_epoch(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    new_epoch:  u64,
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let emission_cfg = next_account_info(iter)?;
    let admin        = next_account_info(iter)?;

    if !admin.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ── Validate config PDA ───────────────────────────────────────────────
    let (expected_pda, _) =
        Pubkey::find_program_address(&[b"emission-config"], program_id);
    if expected_pda != *emission_cfg.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut cfg = {
        let data = emission_cfg.try_borrow_data()?;
        EmissionConfig::unpack_from(&data)
            .ok_or(ProgramError::InvalidAccountData)?
    };

    if cfg.admin != admin.key.to_bytes() {
        return Err(MintGateError::NotAdmin.into());
    }
    if new_epoch <= cfg.current_epoch {
        return Err(MintGateError::EpochAlreadyAdvanced.into());
    }

    cfg.current_epoch            = new_epoch;
    cfg.epoch_null_minted_atomic = 0;
    {
        let mut data = emission_cfg.try_borrow_mut_data()?;
        cfg.pack_into(&mut data);
    }

    msg!(
        "dark-null-mint-gate: AdvanceEpoch new_epoch={}",
        new_epoch
    );
    Ok(())
}
