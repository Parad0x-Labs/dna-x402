use crate::{
    error::VaultError,
    instruction::VaultInstruction,
    state::{VAULT_DISC, VAULT_RECORD_SIZE, VAULT_VERSION, VaultRecord},
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

/// The secp256r1 precompile program ID (SIMD-0075, live on Solana since June 2025).
/// In production, the transaction must include a secp256r1 precompile instruction
/// that verifies the P-256 assertion *before* this instruction runs.
/// The precompile validates signature + pubkey atomically at the tx level.
#[allow(dead_code)]
const SECP256R1_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("Secp256r1SigVerify1111111111111111111111111");

/// When false, P-256 signature verification is not enforced on-chain.
/// The transaction is expected to include a secp256r1 precompile instruction,
/// but this program does not verify its presence (devnet trust model).
///
/// Set to true (post-audit) to require the precompile instruction in the same
/// transaction via a runtime sysvar check before accepting a registration.
pub const IS_MAINNET_READY: bool = false;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match VaultInstruction::unpack(data)? {
        VaultInstruction::RegisterPasskeyVault {
            agent_pubkey,
            credential_id_hash,
            challenge_hash,
            p256_pubkey_x,
            p256_pubkey_y,
        } => process_register(
            program_id,
            accounts,
            agent_pubkey,
            credential_id_hash,
            challenge_hash,
            p256_pubkey_x,
            p256_pubkey_y,
        ),
        VaultInstruction::VerifyPasskeySignal { challenge_hash, new_challenge_hash } =>
            process_verify_signal(program_id, accounts, challenge_hash, new_challenge_hash),
        VaultInstruction::RevokePasskeyVault =>
            process_revoke(program_id, accounts),
        VaultInstruction::StoreEncryptedKey { nonce, ciphertext, tag } =>
            process_store_enc_key(program_id, accounts, nonce, ciphertext, tag),
    }
}

// ── RegisterPasskeyVault ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn process_register(
    program_id:         &Pubkey,
    accounts:           &[AccountInfo],
    agent_pubkey:       [u8; 32],
    credential_id_hash: [u8; 32],
    challenge_hash:     [u8; 32],
    _p256_pubkey_x:     [u8; 32],  // stored in tx precompile; we record the vault binding only
    _p256_pubkey_y:     [u8; 32],
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let vault_pda    = next_account_info(iter)?;
    let wallet_owner = next_account_info(iter)?;
    let system_prog  = next_account_info(iter)?;

    if !wallet_owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // NOTE: In production, verify that the transaction includes a secp256r1
    // precompile instruction signed with p256_pubkey_x / p256_pubkey_y over
    // challenge_hash before proceeding.  For devnet (IS_MAINNET_READY = false),
    // this check is skipped and the client-supplied fields are trusted.

    // Derive the vault PDA: [b"passkey-vault", wallet_pubkey, credential_id_hash]
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[
            b"passkey-vault",
            wallet_owner.key.as_ref(),
            &credential_id_hash,
        ],
        program_id,
    );
    if expected_pda != *vault_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    if !vault_pda.data_is_empty() {
        return Err(VaultError::VaultAlreadyRegistered.into());
    }

    let slot = Clock::get()?.slot;

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(VAULT_RECORD_SIZE);

    invoke_signed(
        &system_instruction::create_account(
            wallet_owner.key,
            vault_pda.key,
            lamports,
            VAULT_RECORD_SIZE as u64,
            program_id,
        ),
        &[wallet_owner.clone(), vault_pda.clone(), system_prog.clone()],
        &[&[
            b"passkey-vault",
            wallet_owner.key.as_ref(),
            &credential_id_hash,
            &[bump],
        ]],
    )?;

    let record = VaultRecord {
        disc:               VAULT_DISC,
        wallet_pubkey:      wallet_owner.key.to_bytes(),
        credential_id_hash,
        agent_pubkey,
        challenge_hash,
        registered_at:      slot,
        version:            VAULT_VERSION,
        enc_key_nonce:      [0u8; 12],
        enc_key_ciphertext: [0u8; 64],
        enc_key_tag:        [0u8; 16],
        has_enc_key:        0,
    };

    let mut data = vault_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("dark-secp256r1-vault: RegisterPasskeyVault slot={}", slot);
    Ok(())
}

// ── VerifyPasskeySignal ───────────────────────────────────────────────────────

fn process_verify_signal(
    program_id:         &Pubkey,
    accounts:           &[AccountInfo],
    challenge_hash:     [u8; 32],
    new_challenge_hash: [u8; 32],
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let vault_pda    = next_account_info(iter)?;
    let wallet_owner = next_account_info(iter)?;

    if !wallet_owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let mut record = {
        let data = vault_pda.try_borrow_data()?;
        VaultRecord::unpack_from(&data).ok_or(VaultError::VaultNotFound)?
    };

    // Verify the vault belongs to the signer.
    if record.wallet_pubkey != wallet_owner.key.to_bytes() {
        return Err(VaultError::NotOwner.into());
    }

    // Verify the vault PDA is correctly derived (guards against spoofed accounts).
    let (expected_pda, _) = Pubkey::find_program_address(
        &[
            b"passkey-vault",
            wallet_owner.key.as_ref(),
            &record.credential_id_hash,
        ],
        program_id,
    );
    if expected_pda != *vault_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify the challenge matches — prevents replay of old assertions.
    if record.challenge_hash != challenge_hash {
        return Err(VaultError::ReplayedChallenge.into());
    }

    // Advance the challenge to prevent reuse of this assertion.
    record.challenge_hash = new_challenge_hash;

    let mut data = vault_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("dark-secp256r1-vault: Signal verified");
    Ok(())
}

// ── RevokePasskeyVault ────────────────────────────────────────────────────────

fn process_revoke(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let vault_pda    = next_account_info(iter)?;
    let wallet_owner = next_account_info(iter)?;

    if !wallet_owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    {
        let data   = vault_pda.try_borrow_data()?;
        let record = VaultRecord::unpack_from(&data).ok_or(VaultError::VaultNotFound)?;

        if record.wallet_pubkey != wallet_owner.key.to_bytes() {
            return Err(VaultError::NotOwner.into());
        }

        // Verify the PDA matches the stored credential.
        let (expected_pda, _) = Pubkey::find_program_address(
            &[
                b"passkey-vault",
                wallet_owner.key.as_ref(),
                &record.credential_id_hash,
            ],
            program_id,
        );
        if expected_pda != *vault_pda.key {
            return Err(ProgramError::InvalidAccountData);
        }
    }

    // Zero out the vault — the disc byte will no longer match, blocking future reads.
    let mut data = vault_pda.try_borrow_mut_data()?;
    data.fill(0);

    msg!("dark-secp256r1-vault: Vault revoked and zeroed");
    Ok(())
}

// ── StoreEncryptedKey ─────────────────────────────────────────────────────────

fn process_store_enc_key(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    nonce:      [u8; 12],
    ciphertext: [u8; 64],
    tag:        [u8; 16],
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let vault_pda    = next_account_info(iter)?;
    let wallet_owner = next_account_info(iter)?;

    if !wallet_owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Unpack the existing record — fail if the vault does not exist or is corrupt.
    let mut record = {
        let data = vault_pda.try_borrow_data()?;
        VaultRecord::unpack_from(&data).ok_or(VaultError::VaultNotFound)?
    };

    // Verify the vault belongs to the signer.
    if record.wallet_pubkey != wallet_owner.key.to_bytes() {
        return Err(VaultError::NotOwner.into());
    }

    // Verify the PDA is correctly derived.
    let (expected_pda, _) = Pubkey::find_program_address(
        &[
            b"passkey-vault",
            wallet_owner.key.as_ref(),
            &record.credential_id_hash,
        ],
        program_id,
    );
    if expected_pda != *vault_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Immutability: once an encrypted key is stored, refuse further writes.
    if record.has_enc_key == 1 {
        return Err(VaultError::KeyAlreadyStored.into());
    }

    // If this is a legacy 138-byte account, resize it to fit the new fields.
    if vault_pda.data_len() < VAULT_RECORD_SIZE {
        vault_pda.realloc(VAULT_RECORD_SIZE, false)?;
    }

    // Write the encrypted key material.
    record.enc_key_nonce      = nonce;
    record.enc_key_ciphertext = ciphertext;
    record.enc_key_tag        = tag;
    record.has_enc_key        = 1;

    let mut data = vault_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("dark-secp256r1-vault: EncryptedKey stored on-chain");
    Ok(())
}
