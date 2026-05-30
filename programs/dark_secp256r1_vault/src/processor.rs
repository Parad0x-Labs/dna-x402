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
// ⚠️  EXTERNALLY UNAUDITED — test pilot deployment. Not audited by any third party.
//    Deploy with: cargo build-sbf --features mainnet
//    IS_MAINNET_READY=true enables full on-chain verification (signature checks,
//    SPL transfers, precompile validation). Use at your own risk until audited.
#[cfg(feature = "mainnet")]
pub const IS_MAINNET_READY: bool = true;
#[cfg(not(feature = "mainnet"))]
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

    // When compiled with --features mainnet the tx MUST include a secp256r1
    // (SIMD-0075) precompile instruction at index 0. We extract the pubkey the
    // precompile cryptographically verified and require it to match the P-256
    // key supplied here — binding the vault to a key that actually signed.
    // Devnet skips this (devnet trust model) and stores no P-256 binding.
    #[cfg(feature = "mainnet")]
    let (p256_compressed, has_p256) = {
        let ix_sysvar = next_account_info(iter)?;
        let verified_pubkey = verify_and_extract_precompile_pubkey(ix_sysvar)?;
        let expected = crate::secp256r1::compress_xy(&_p256_pubkey_x, &_p256_pubkey_y);
        if verified_pubkey != expected {
            return Err(VaultError::PasskeyPubkeyMismatch.into());
        }
        (expected, 1u8)
    };
    #[cfg(not(feature = "mainnet"))]
    let (p256_compressed, has_p256) = ([0u8; 33], 0u8);

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
        p256_compressed,
        has_p256,
    };

    let mut data = vault_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("dark-secp256r1-vault: RegisterPasskeyVault slot={} bound_p256={}", slot, has_p256);
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

    // Mainnet: require a secp256r1 precompile (index 0) proving the bound passkey
    // signed exactly this challenge. This is the real "sign in with Face ID" check:
    // same P-256 key as registration, fresh signature over the live challenge.
    #[cfg(feature = "mainnet")]
    {
        if record.has_p256 != 1 {
            return Err(VaultError::PasskeyNotBound.into());
        }
        let ix_sysvar = next_account_info(iter)?;
        verify_precompile_signal(ix_sysvar, &record.p256_compressed, &challenge_hash)?;
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

/// Load the secp256r1 (SIMD-0075) precompile instruction at index 0 and return
/// the compressed pubkey it cryptographically verified. The vault instruction
/// must not itself be at index 0 (the precompile occupies it).
#[cfg(feature = "mainnet")]
fn verify_and_extract_precompile_pubkey(
    ix_sysvar: &AccountInfo,
) -> Result<[u8; 33], ProgramError> {
    use solana_program::sysvar::instructions;
    let current_idx = instructions::load_current_index_checked(ix_sysvar)? as usize;
    if current_idx == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let precompile_ix = instructions::load_instruction_at_checked(0, ix_sysvar)?;
    if precompile_ix.program_id != SECP256R1_PROGRAM_ID {
        return Err(ProgramError::InvalidInstructionData);
    }
    let verified = crate::secp256r1::parse_single_verified(&precompile_ix.data, 0)?;
    Ok(verified.pubkey_compressed)
}

/// Verify that the index-0 secp256r1 precompile proves `expected_pubkey` signed
/// exactly `expected_message` (the live challenge). Used by the recurring
/// sign-in (VerifyPasskeySignal).
#[cfg(feature = "mainnet")]
fn verify_precompile_signal(
    ix_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 33],
    expected_message: &[u8; 32],
) -> ProgramResult {
    use solana_program::sysvar::instructions;
    let current_idx = instructions::load_current_index_checked(ix_sysvar)? as usize;
    if current_idx == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let precompile_ix = instructions::load_instruction_at_checked(0, ix_sysvar)?;
    if precompile_ix.program_id != SECP256R1_PROGRAM_ID {
        return Err(ProgramError::InvalidInstructionData);
    }
    let verified = crate::secp256r1::parse_single_verified(&precompile_ix.data, 0)?;
    if &verified.pubkey_compressed != expected_pubkey {
        return Err(VaultError::PasskeyPubkeyMismatch.into());
    }
    if verified.message != expected_message {
        return Err(VaultError::ChallengeNotSigned.into());
    }
    Ok(())
}
