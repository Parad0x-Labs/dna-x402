use crate::{
    error::AuthError,
    instruction::AuthInstruction,
    state::{ETH_AGENT_DISC, ETH_AGENT_RECORD_SIZE, EthAgentRecord},
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    keccak,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

// The secp256k1 precompile binding below is enforced in every build. It used to
// be compiled only with the `mainnet` cargo feature, so default (devnet) builds
// bound any ETH address to any caller; that feature is kept as a no-op so existing
// build commands keep working. The signed message is the canonical binding message
// (see `binding.rs`), which names the program id and the agent signer.

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
    r: [u8; 32], s: [u8; 32], recovery_id: u8, msg_hash: [u8; 32],
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

    // Parse the secp256k1 precompile at index 0 and bind what it verified:
    //   - the recovered ETH address must equal the eth_address in pda_seed
    //   - the signature must be the r || s || recovery_id in this instruction
    //   - msg_hash must be keccak256 of the signed message (the EIP-191 digest)
    //   - the signed message must be the canonical binding message for this
    //     program id, this agent signer, the ETH address, domain_hash and
    //     auth_hash, so a signature made for one agent cannot bind the ETH
    //     address to another one
    let ix_sysvar = next_account_info(iter)?;
    let verified_ix = load_precompile_ix(ix_sysvar)?;
    let verified = crate::secp256k1::parse_single_verified(&verified_ix.data, 0)?;
    if verified.eth_address != eth_address {
        return Err(AuthError::EthAddressMismatch.into());
    }
    if verified.signature[..32] != r || verified.signature[32..64] != s
        || verified.signature[64] != recovery_id
    {
        return Err(AuthError::InvalidSignature.into());
    }
    if keccak::hash(verified.message).to_bytes() != msg_hash {
        return Err(AuthError::MessageMismatch.into());
    }
    let expected = crate::binding::binding_message(
        program_id, agent_signer.key, &eth_address, &domain_hash, &auth_hash,
    );
    if verified.message != expected.as_slice() {
        return Err(AuthError::BindingMessageMismatch.into());
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

/// Load the secp256k1 precompile instruction at index 0. The precompile
/// guarantees the private key owner signed its message; the caller binds the
/// verified tuple. This instruction must not itself be at index 0.
fn load_precompile_ix(
    ix_sysvar: &AccountInfo,
) -> Result<solana_program::instruction::Instruction, ProgramError> {
    use solana_program::sysvar::instructions;
    let current_idx = instructions::load_current_index_checked(ix_sysvar)? as usize;
    if current_idx == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let precompile_ix = instructions::load_instruction_at_checked(0, ix_sysvar)?;
    if precompile_ix.program_id != solana_program::secp256k1_program::id() {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(precompile_ix)
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
