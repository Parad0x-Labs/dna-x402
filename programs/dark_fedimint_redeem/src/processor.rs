//! Redeem-program processor. Thin dispatcher over `dark-fedimint-ecash`'s real
//! Ristretto BDHKE verify.

use crate::curve_syscall::verify_dleq_syscall;
use crate::error::RedeemError;
use crate::instruction::RedeemInstruction;
use crate::state::{
    MintConfig, NullifierRecord, MINT_CONFIG_LEN, MINT_CONFIG_VERSION, NULLIFIER_RECORD_LEN,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hashv,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::{IsInitialized, Pack},
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

pub const MINT_CONFIG_SEED: &[u8] = b"mint_config";
pub const RESERVE_VAULT_SEED: &[u8] = b"reserve_vault";
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match RedeemInstruction::unpack(data)? {
        RedeemInstruction::InitMint {
            group_pub,
            denomination,
        } => process_init_mint(program_id, accounts, group_pub, denomination),
        RedeemInstruction::Fund { amount } => process_fund(program_id, accounts, amount),
        RedeemInstruction::Redeem { y, c, dleq } => {
            process_redeem(program_id, accounts, y, c, dleq)
        }
    }
}

/// `nullifier = SHA256("eNULL-NULLIFIER-v1" ‖ Y)`. Keyed on the unlinkable token
/// point `Y`, computed via the cheap sol_sha256 syscall (`hashv`).
fn nullifier_of(y: &[u8; 32]) -> [u8; 32] {
    hashv(&[b"eNULL-NULLIFIER-v1", y]).to_bytes()
}

// ─── InitMint ─────────────────────────────────────────────────────────────────

fn process_init_mint(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    group_pub: [u8; 32],
    denomination: u64,
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let mint_config_info = next_account_info(iter)?;
    let reserve_vault_info = next_account_info(iter)?;
    let authority_info = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if denomination == 0 {
        return Err(RedeemError::ZeroDenomination.into());
    }
    if group_pub == [0u8; 32] {
        return Err(RedeemError::WrongMintKey.into());
    }
    if !authority_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (mint_config_key, config_bump) =
        Pubkey::find_program_address(&[MINT_CONFIG_SEED, authority_info.key.as_ref()], program_id);
    if mint_config_key != *mint_config_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    let (reserve_vault_key, vault_bump) = Pubkey::find_program_address(
        &[RESERVE_VAULT_SEED, mint_config_info.key.as_ref()],
        program_id,
    );
    if reserve_vault_key != *reserve_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    if mint_config_info.data_len() > 0 {
        return Err(RedeemError::AlreadyInitialized.into());
    }

    let rent = Rent::get()?;

    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            mint_config_info.key,
            rent.minimum_balance(MINT_CONFIG_LEN),
            MINT_CONFIG_LEN as u64,
            program_id,
        ),
        &[
            authority_info.clone(),
            mint_config_info.clone(),
            system_program.clone(),
        ],
        &[&[
            MINT_CONFIG_SEED,
            authority_info.key.as_ref(),
            &[config_bump],
        ]],
    )?;

    // Reserve vault: a rent-exempt system-owned PDA that only this program can
    // debit (via direct lamport math during redeem, since it's program-owned-ish
    // — we create it owned by the system program and move lamports directly,
    // matching dark_shielded_pool's pool_vault).
    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            reserve_vault_info.key,
            rent.minimum_balance(0),
            0,
            program_id,
        ),
        &[
            authority_info.clone(),
            reserve_vault_info.clone(),
            system_program.clone(),
        ],
        &[&[
            RESERVE_VAULT_SEED,
            mint_config_info.key.as_ref(),
            &[vault_bump],
        ]],
    )?;

    let config = MintConfig {
        version: MINT_CONFIG_VERSION,
        bump: config_bump,
        is_initialized: true,
        authority: authority_info.key.to_bytes(),
        group_pub,
        denomination,
        vault_bump,
        redeemed_count: 0,
    };
    MintConfig::pack(config, &mut mint_config_info.data.borrow_mut())?;

    msg!(
        "FedimintRedeem: init mint denom={} (group key stored)",
        denomination
    );
    Ok(())
}

// ─── Fund (top up the reserve) ──────────────────────────────────────────────

fn process_fund(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let mint_config_info = next_account_info(iter)?;
    let reserve_vault_info = next_account_info(iter)?;
    let funder_info = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    let config = MintConfig::unpack(&mint_config_info.data.borrow())?;
    if !config.is_initialized() {
        return Err(RedeemError::NotInitialized.into());
    }
    let (reserve_vault_key, _vault_bump) = Pubkey::find_program_address(
        &[RESERVE_VAULT_SEED, mint_config_info.key.as_ref()],
        program_id,
    );
    if reserve_vault_key != *reserve_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if !funder_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    invoke_signed(
        &system_instruction::transfer(funder_info.key, reserve_vault_info.key, amount),
        &[
            funder_info.clone(),
            reserve_vault_info.clone(),
            system_program.clone(),
        ],
        &[],
    )?;
    msg!("FedimintRedeem: funded reserve +{}", amount);
    Ok(())
}

// ─── Redeem ──────────────────────────────────────────────────────────────────

fn process_redeem(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    y: [u8; 32],
    c: [u8; 32],
    dleq_bytes: [u8; 64],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let mint_config_info = next_account_info(iter)?;
    let reserve_vault_info = next_account_info(iter)?;
    let nullifier_rec_info = next_account_info(iter)?;
    let recipient_info = next_account_info(iter)?;
    let fee_payer_info = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    if !fee_payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut config = MintConfig::unpack(&mint_config_info.data.borrow())?;
    if !config.is_initialized() {
        return Err(RedeemError::NotInitialized.into());
    }

    // 1. Verify the DLEQ against the STORED group key K via the Ristretto
    //    syscalls — proves C = k·Y for the federation's shared k, WITHOUT the
    //    chain ever knowing k. (e, z) = dleq.
    let mut e = [0u8; 32];
    let mut z = [0u8; 32];
    e.copy_from_slice(&dleq_bytes[..32]);
    z.copy_from_slice(&dleq_bytes[32..]);
    if !verify_dleq_syscall(&config.group_pub, &y, &c, &e, &z) {
        return Err(RedeemError::DleqInvalid.into());
    }

    // 2. The token's nullifier is derived from its unlinkable point Y.
    let supplied_nullifier = nullifier_of(&y);

    // 3. Nullifier PDA must not yet exist (unseen = not spent).
    let (nullifier_key, null_bump) = Pubkey::find_program_address(
        &[
            NULLIFIER_SEED,
            mint_config_info.key.as_ref(),
            &supplied_nullifier,
        ],
        program_id,
    );
    if nullifier_key != *nullifier_rec_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if nullifier_rec_info.data_len() > 0 {
        return Err(RedeemError::NullifierAlreadySpent.into());
    }

    // 4. Bind the reserve vault to THIS config's PDA. Without this, an attacker
    //    can present a valid token + config of their OWN cheap federation (so the
    //    DLEQ passes and the nullifier PDA is namespaced to their config) while
    //    pointing reserve_vault at a DIFFERENT federation's reserve — every
    //    reserve vault is program-owned, so the unchecked lamport debit below
    //    would drain the victim. Same guard `process_fund` already enforces.
    let (reserve_vault_key, _vault_bump) = Pubkey::find_program_address(
        &[RESERVE_VAULT_SEED, mint_config_info.key.as_ref()],
        program_id,
    );
    if reserve_vault_key != *reserve_vault_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // 4b. Refuse a self-pay: if recipient IS the reserve vault, the two lamport
    //     mutations below cancel out (vault pays itself) yet the nullifier is
    //     still created, BURNING a single-use token for zero net payout. Reject
    //     BEFORE the nullifier is minted so a careless caller doesn't destroy a
    //     valid token. (Low severity: no fund loss, but token-griefing.)
    if recipient_info.key == reserve_vault_info.key {
        return Err(RedeemError::RecipientIsReserveVault.into());
    }

    // Reserve must hold at least one denomination.
    if reserve_vault_info.lamports() < config.denomination {
        return Err(RedeemError::InsufficientReserve.into());
    }

    let rent = Rent::get()?;
    let clock = Clock::get()?;

    // 5. Create the nullifier PDA (mark spent). Fee-payer funds its rent.
    invoke_signed(
        &system_instruction::create_account(
            fee_payer_info.key,
            nullifier_rec_info.key,
            rent.minimum_balance(NULLIFIER_RECORD_LEN),
            NULLIFIER_RECORD_LEN as u64,
            program_id,
        ),
        &[
            fee_payer_info.clone(),
            nullifier_rec_info.clone(),
            system_program.clone(),
        ],
        &[&[
            NULLIFIER_SEED,
            mint_config_info.key.as_ref(),
            &supplied_nullifier,
            &[null_bump],
        ]],
    )?;

    let record = NullifierRecord {
        bump: null_bump,
        nullifier: supplied_nullifier,
        spent_at: clock.unix_timestamp,
    };
    NullifierRecord::pack(record, &mut nullifier_rec_info.data.borrow_mut())?;

    // 6. Release ONE denomination: reserve_vault -> recipient.
    **reserve_vault_info.lamports.borrow_mut() -= config.denomination;
    **recipient_info.lamports.borrow_mut() += config.denomination;

    config.redeemed_count = config
        .redeemed_count
        .checked_add(1)
        .ok_or(RedeemError::ArithmeticOverflow)?;
    MintConfig::pack(config.clone(), &mut mint_config_info.data.borrow_mut())?;

    msg!(
        "FedimintRedeem: redeemed denom={} -> {} (count={})",
        config.denomination,
        recipient_info.key,
        config.redeemed_count
    );
    Ok(())
}
