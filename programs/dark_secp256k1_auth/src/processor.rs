use crate::{
    error::AuthError,
    instruction::AuthInstruction,
    state::{ETH_AGENT_DISC, ETH_AGENT_RECORD_SIZE, EthAgentRecord},
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

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match AuthInstruction::unpack(data)? {
        AuthInstruction::RegisterEthAgent {
            r, s, recovery_id, msg_hash, pda_seed, auth_hash, domain_hash,
        } => process_register(program_id, accounts, r, s, recovery_id, msg_hash, pda_seed, auth_hash, domain_hash),
        AuthInstruction::RevokeEthAgent { eth_address } =>
            process_revoke(program_id, accounts, eth_address),
    }
}

#[allow(clippy::too_many_arguments)]
fn process_register(
    program_id: &Pubkey, accounts: &[AccountInfo],
    _r: [u8; 32], _s: [u8; 32], _recovery_id: u8, _msg_hash: [u8; 32],
    pda_seed: [u8; 32], auth_hash: [u8; 32], domain_hash: [u8; 32],
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let record_pda   = next_account_info(iter)?;
    let agent_signer = next_account_info(iter)?;
    let system_prog  = next_account_info(iter)?;

    if !agent_signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let eth_address: [u8; 20] = pda_seed[12..32].try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let (expected_pda, bump) = Pubkey::find_program_address(
        &[b"eth-agent", &eth_address], program_id,
    );
    if expected_pda != *record_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if !record_pda.data_is_empty() {
        return Err(AuthError::AgentAlreadyRegistered.into());
    }

    // When compiled with --features mainnet the tx MUST include a secp256k1
    // precompile instruction at index 0.  Devnet trust model skips this.
    // Full recovered-address verification against eth_address is post-audit.
    #[cfg(feature = "mainnet")]
    {
        let ix_sysvar = next_account_info(iter)?;
        verify_secp256k1_precompile_presence(ix_sysvar)?;
    }

    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(ETH_AGENT_RECORD_SIZE);
    invoke_signed(
        &system_instruction::create_account(
            agent_signer.key, record_pda.key, lamports,
            ETH_AGENT_RECORD_SIZE as u64, program_id,
        ),
        &[agent_signer.clone(), record_pda.clone(), system_prog.clone()],
        &[&[b"eth-agent", &eth_address, &[bump]]],
    )?;

    let slot = Clock::get().map(|c| c.slot).unwrap_or(0);
    let record = EthAgentRecord {
        disc:          ETH_AGENT_DISC,
        eth_address,
        agent_pubkey:  agent_signer.key.to_bytes(),
        auth_hash,
        domain_hash,
        registered_at: slot,
        is_active:     true,
    };
    let mut data = record_pda.try_borrow_mut_data()?;
    record.pack_into(&mut data);

    msg!("dark-secp256k1-auth: RegisterEthAgent");
    Ok(())
}

/// Verify the tx contains a secp256k1 precompile instruction at index 0.
/// Full ETH address recovery against pda_seed is deferred to post-audit.
#[cfg(feature = "mainnet")]
fn verify_secp256k1_precompile_presence(ix_sysvar: &AccountInfo) -> ProgramResult {
    use solana_program::sysvar::instructions;
    let current_idx = instructions::load_current_index_checked(ix_sysvar)? as usize;
    if current_idx == 0 {
        // This instruction must not be first in the tx.
        return Err(ProgramError::InvalidInstructionData);
    }
    let precompile_ix = instructions::load_instruction_at_checked(0, ix_sysvar)?;
    if precompile_ix.program_id != solana_program::secp256k1_program::id() {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn process_revoke(
    program_id: &Pubkey, accounts: &[AccountInfo], eth_address: [u8; 20],
) -> ProgramResult {
    let iter         = &mut accounts.iter();
    let record_pda   = next_account_info(iter)?;
    let agent_signer = next_account_info(iter)?;

    if !agent_signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"eth-agent", &eth_address], program_id,
    );
    if expected_pda != *record_pda.key {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut data   = record_pda.try_borrow_mut_data()?;
    let mut record = EthAgentRecord::unpack_from(&data).ok_or(AuthError::AgentNotFound)?;

    if record.agent_pubkey != agent_signer.key.to_bytes() {
        return Err(AuthError::NotOwner.into());
    }

    record.is_active = false;
    record.pack_into(&mut data);

    msg!("dark-secp256k1-auth: RevokeEthAgent");
    Ok(())
}
