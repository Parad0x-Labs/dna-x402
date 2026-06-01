//! agent-credential-mint instruction processor
//!
//! IS_MAINNET_READY = false (devnet mode):
//!   All Token-2022 CPIs are skipped. Only CredentialRecord PDAs are written.
//!   x402 fee verification is also skipped.
//!
//! IS_MAINNET_READY = true (`--features mainnet`):
//!   Full Token-2022 CPI path: NonTransferable mint creation, PermanentDelegate
//!   assignment, token mint/burn, TokenMetadata writes, and x402 fee checks.
//!   This path is NOT yet wired. It is gated behind IS_MAINNET_READY to prevent
//!   accidental deployment before the third-party audit.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    program::invoke_signed,
    sysvar::Sysvar,
    rent::Rent,
};
use sha2::{Digest, Sha256};

use crate::{
    IS_MAINNET_READY,
    CRED_RECORD_SEED, PROTOCOL_AUTHORITY_SEED, PASSPORT_VERSION,
    error::CredentialError,
    instruction::CredentialInstruction,
    state::{
        BindingType, CredentialRecord, CredentialStatus,
        CRED_DISC, CRED_RECORD_SIZE,
    },
};

pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    let ix = CredentialInstruction::unpack(data)?;

    match ix {
        CredentialInstruction::IssueCredential {
            agent_pubkey,
            device_pubkey,
            binding_type,
            x402_receipt_hash,
        } => process_issue(program_id, accounts, agent_pubkey, device_pubkey, binding_type, x402_receipt_hash),

        CredentialInstruction::RevokeCredential { agent_pubkey } => {
            process_revoke(program_id, accounts, agent_pubkey)
        }

        CredentialInstruction::UpgradeCredential {
            old_device_pubkey,
            new_device_pubkey,
            x402_receipt_hash,
        } => process_upgrade(program_id, accounts, old_device_pubkey, new_device_pubkey, x402_receipt_hash),
    }
}

// ── IssueCredential ───────────────────────────────────────────────────────────

fn process_issue(
    program_id:        &Pubkey,
    accounts:          &[AccountInfo],
    agent_pubkey:      [u8; 32],
    device_pubkey:     [u8; 33],
    binding_type:      BindingType,
    _x402_receipt_hash: [u8; 32],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();

    let agent_wallet_info       = next_account_info(account_info_iter)?;
    // credential_mint_info — Token-2022 mint (mainnet only)
    let _credential_mint_info   = next_account_info(account_info_iter)?;
    // agent_token_account_info — ATA for credential_mint (mainnet only)
    let _agent_token_account    = next_account_info(account_info_iter)?;
    let credential_record_info  = next_account_info(account_info_iter)?;
    let _protocol_authority     = next_account_info(account_info_iter)?;
    let system_program_info     = next_account_info(account_info_iter)?;

    // Derive and verify CredentialRecord PDA
    let (cred_pda, cred_bump) = Pubkey::find_program_address(
        &[CRED_RECORD_SEED, &agent_pubkey],
        program_id,
    );
    if cred_pda != *credential_record_info.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Reject duplicate issuance
    if !credential_record_info.data_is_empty() {
        return Err(CredentialError::AlreadyIssued.into());
    }

    // Compute agent_id_hash = SHA-256(agent_pubkey || device_pubkey)
    let agent_id_hash = compute_agent_id_hash(&agent_pubkey, &device_pubkey);

    // Get clock for issued_at fields
    let clock = Clock::get()?;

    let record = CredentialRecord {
        disc:             CRED_DISC,
        agent_pubkey,
        device_pubkey,
        binding_type,
        credential_mint:  [0u8; 32], // populated in mainnet path
        issued_at_slot:   clock.slot,
        issued_at_unix:   clock.unix_timestamp as u64,
        passport_version: PASSPORT_VERSION,
        agent_id_hash,
        status:           CredentialStatus::Active,
        binding_version:  0,
        _reserved:        [0u8; 4],
    };

    // Allocate CredentialRecord PDA
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(CRED_RECORD_SIZE);
    let bump_seed = [cred_bump];
    let signer_seeds: &[&[u8]] = &[CRED_RECORD_SEED, &agent_pubkey, &bump_seed];

    invoke_signed(
        &system_instruction::create_account(
            agent_wallet_info.key,
            credential_record_info.key,
            lamports,
            CRED_RECORD_SIZE as u64,
            program_id,
        ),
        &[
            agent_wallet_info.clone(),
            credential_record_info.clone(),
            system_program_info.clone(),
        ],
        &[signer_seeds],
    )?;

    // Write CredentialRecord
    let mut pda_data = credential_record_info.try_borrow_mut_data()?;
    record.pack_into(&mut pda_data);

    if IS_MAINNET_READY {
        // TODO (post-audit): CPI into spl-token-2022 to:
        //   1. Create mint with NonTransferable + PermanentDelegate extensions
        //   2. Initialize TokenMetadata
        //   3. MintTo 1 token → agent ATA
        //   4. Verify x402 receipt hash against payment record
        msg!("IS_MAINNET_READY: Token-2022 CPI path not yet wired (pending audit)");
        return Err(CredentialError::NotMainnetReady.into());
    }

    msg!("agent-credential-mint: IssueCredential devnet — PDA written, token CPI skipped");
    Ok(())
}

// ── RevokeCredential ──────────────────────────────────────────────────────────

fn process_revoke(
    program_id:  &Pubkey,
    accounts:    &[AccountInfo],
    agent_pubkey: [u8; 32],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();

    let authority_info          = next_account_info(account_info_iter)?;
    let _agent_token_account    = next_account_info(account_info_iter)?;
    let _credential_mint_info   = next_account_info(account_info_iter)?;
    let credential_record_info  = next_account_info(account_info_iter)?;

    // Derive and verify protocol_authority PDA
    let (authority_pda, _auth_bump) = Pubkey::find_program_address(
        &[PROTOCOL_AUTHORITY_SEED],
        program_id,
    );

    // In devnet mode allow admin keypair; in mainnet only protocol_authority PDA
    if IS_MAINNET_READY && *authority_info.key != authority_pda {
        return Err(CredentialError::Unauthorized.into());
    }

    // Derive and verify CredentialRecord PDA
    let (cred_pda, _) = Pubkey::find_program_address(
        &[CRED_RECORD_SEED, &agent_pubkey],
        program_id,
    );
    if cred_pda != *credential_record_info.key {
        return Err(ProgramError::InvalidAccountData);
    }

    if credential_record_info.data_is_empty() {
        return Err(CredentialError::CredentialNotFound.into());
    }

    // Load and verify not already revoked
    let mut pda_data = credential_record_info.try_borrow_mut_data()?;
    let mut record = CredentialRecord::unpack_from(&pda_data)?;

    if record.status == CredentialStatus::Revoked {
        return Err(CredentialError::AlreadyRevoked.into());
    }

    // Mark revoked — DO NOT close the PDA (preserve audit log)
    record.status = CredentialStatus::Revoked;
    record.pack_into(&mut pda_data);
    drop(pda_data);

    if IS_MAINNET_READY {
        // TODO (post-audit): CPI into spl-token-2022 Burn via PermanentDelegate
        //   invoke_signed with [PROTOCOL_AUTHORITY_SEED, &[auth_bump]] to burn
        //   the 1 NonTransferable token from agent's ATA.
        msg!("IS_MAINNET_READY: Token-2022 burn CPI not yet wired (pending audit)");
        return Err(CredentialError::NotMainnetReady.into());
    }

    msg!("agent-credential-mint: RevokeCredential devnet — PDA flagged revoked, burn CPI skipped");
    Ok(())
}

// ── UpgradeCredential ─────────────────────────────────────────────────────────

fn process_upgrade(
    _program_id:        &Pubkey,
    accounts:           &[AccountInfo],
    old_device_pubkey:  [u8; 33],
    new_device_pubkey:  [u8; 33],
    _x402_receipt_hash: [u8; 32],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();

    let agent_wallet_info       = next_account_info(account_info_iter)?;
    let _old_token_account      = next_account_info(account_info_iter)?;
    let _credential_mint_info   = next_account_info(account_info_iter)?;
    let _new_token_account      = next_account_info(account_info_iter)?;
    let credential_record_info  = next_account_info(account_info_iter)?;

    // Load record
    if credential_record_info.data_is_empty() {
        return Err(CredentialError::CredentialNotFound.into());
    }

    let mut pda_data = credential_record_info.try_borrow_mut_data()?;
    let mut record   = CredentialRecord::unpack_from(&pda_data)?;

    // Verify caller is the registered agent
    let agent_pubkey_bytes: [u8; 32] = agent_wallet_info.key.to_bytes();
    if agent_pubkey_bytes != record.agent_pubkey {
        return Err(CredentialError::Unauthorized.into());
    }

    // Verify old_device_pubkey matches stored record
    if old_device_pubkey != record.device_pubkey {
        return Err(CredentialError::DevicePubkeyMismatch.into());
    }

    if record.status == CredentialStatus::Revoked {
        return Err(CredentialError::AlreadyRevoked.into());
    }

    // Get clock
    let clock = Clock::get()?;

    // Recompute agent_id_hash with new device_pubkey (agent identity preserved)
    let new_agent_id_hash = compute_agent_id_hash(&record.agent_pubkey, &new_device_pubkey);

    // Update record
    record.device_pubkey    = new_device_pubkey;
    record.agent_id_hash    = new_agent_id_hash;
    record.issued_at_slot   = clock.slot;
    record.issued_at_unix   = clock.unix_timestamp as u64;
    record.binding_version  = record.binding_version.saturating_add(1);
    record.credential_mint  = [0u8; 32]; // reset until mainnet CPI creates new mint

    record.pack_into(&mut pda_data);
    drop(pda_data);

    if IS_MAINNET_READY {
        // TODO (post-audit):
        //   1. Burn old credential token via PermanentDelegate
        //   2. Create new mint (or reuse with updated TokenMetadata)
        //   3. MintTo 1 token → agent ATA
        //   4. Verify x402 re-issuance receipt
        msg!("IS_MAINNET_READY: UpgradeCredential Token-2022 CPI path not yet wired");
        return Err(CredentialError::NotMainnetReady.into());
    }

    msg!("agent-credential-mint: UpgradeCredential devnet — PDA updated, token CPIs skipped");
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

pub fn compute_agent_id_hash(agent_pubkey: &[u8; 32], device_pubkey: &[u8; 33]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(agent_pubkey);
    h.update(device_pubkey);
    h.finalize().into()
}
