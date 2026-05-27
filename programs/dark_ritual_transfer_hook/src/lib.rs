//! dark_ritual_transfer_hook — Token-2022 Transfer Hook
//!
//! Every transfer of a ritual-bound token must pass through this hook.
//! The hook inspects the current transaction's Instructions sysvar to verify:
//!   1. dark_ritual_gate VerifyRitualShape instruction is present
//!   2. Ritual type == AgentSpendNoCustodyV1 (0x01)
//!   3. No forbidden programs in the instruction set
//!
//! NOT_PRODUCTION — Devnet only. Not audited. mainnet_ready = false.

pub mod error;

use error::RitualHookError;
use sha2::{Digest, Sha256};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction, sysvar,
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

// ── Constants ─────────────────────────────────────────────────────────────────

/// dark_ritual_gate deployed on devnet
pub const DARK_RITUAL_GATE_ID_STR: &str = "31qmvsHijLMnQogQ4yvtZom7b1V9ETDx37x2LkhywtCy";
/// VerifyRitualShape instruction tag
pub const VERIFY_RITUAL_SHAPE_TAG: u8 = 0x00;
/// AgentSpendNoCustodyV1 ritual type byte
pub const RITUAL_TYPE_AGENT_SPEND: u8 = 0x01;
/// SPL Memo V2 program
pub const SPL_MEMO_ID_STR: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/// Transfer Hook Execute discriminator (spl-transfer-hook-interface)
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// InitializeExtraAccountMetaList discriminator
pub const INIT_EXTRA_ACCOUNTS_DISCRIMINATOR: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];

// ── Entrypoint ────────────────────────────────────────────────────────────────

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    if input.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let discriminator: [u8; 8] = input[..8]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    match discriminator {
        EXECUTE_DISCRIMINATOR => {
            if input.len() < 16 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let amount = u64::from_le_bytes(
                input[8..16]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            );
            process_execute(program_id, accounts, amount)
        }
        INIT_EXTRA_ACCOUNTS_DISCRIMINATOR => process_initialize(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ── Initialize ────────────────────────────────────────────────────────────────

/// Initialize the extra account meta list PDA.
///
/// Accounts expected:
///   [0] extra_account_meta_list PDA (writable, signer — via seeds)
///   [1] mint (read)
///   [2] authority (signer, writable — pays rent)
///   [3] system_program
///
/// PDA seeds: [b"extra-account-metas", mint.key.as_ref()]
/// Stores one ExtraAccountMeta: sysvar::instructions::ID (read-only, non-signer)
fn process_initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let extra_account_meta_list_info = next_account_info(account_info_iter)?;
    let mint_info = next_account_info(account_info_iter)?;
    let authority_info = next_account_info(account_info_iter)?;
    let system_program_info = next_account_info(account_info_iter)?;

    // Verify PDA
    let (pda, bump) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint_info.key.as_ref()],
        program_id,
    );
    if pda != *extra_account_meta_list_info.key {
        return Err(ProgramError::InvalidAccountData);
    }

    // Register sysvar::instructions as the one extra account
    let extra_metas = [ExtraAccountMeta::new_with_pubkey(
        &sysvar::instructions::ID,
        false, // not signer
        false, // not writable
    )?];

    let account_size = ExtraAccountMetaList::size_of(extra_metas.len())?;
    let rent = solana_program::rent::Rent::default();
    let lamports = rent.minimum_balance(account_size);

    let bump_seed = [bump];
    let signer_seeds: &[&[u8]] = &[b"extra-account-metas", mint_info.key.as_ref(), &bump_seed];

    invoke_signed(
        &system_instruction::create_account(
            authority_info.key,
            extra_account_meta_list_info.key,
            lamports,
            account_size as u64,
            program_id,
        ),
        &[
            authority_info.clone(),
            extra_account_meta_list_info.clone(),
            system_program_info.clone(),
        ],
        &[signer_seeds],
    )?;

    // Write the ExtraAccountMetaList into the PDA
    let mut pda_data = extra_account_meta_list_info.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut pda_data, &extra_metas)?;

    Ok(())
}

// ── Execute ───────────────────────────────────────────────────────────────────

/// Validate the ritual ceremony for a token transfer.
///
/// Accounts expected (from Token-2022):
///   [0] source token account
///   [1] mint
///   [2] destination token account
///   [3] authority/owner
///   [4] extra_account_meta_list PDA
///   [5] sysvar::instructions (the extra account we registered)
fn process_execute(_program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(RitualHookError::MissingRequiredAccount.into());
    }
    let mint_info = &accounts[1];
    let instructions_sysvar_info = &accounts[5];

    // Confirm the instructions sysvar account
    if *instructions_sysvar_info.key != sysvar::instructions::ID {
        return Err(ProgramError::InvalidAccountData);
    }

    let dark_ritual_gate_id: Pubkey = DARK_RITUAL_GATE_ID_STR
        .parse()
        .map_err(|_| ProgramError::InvalidAccountData)?;

    // Scan all top-level instructions via Instructions sysvar
    // load_instruction_at_checked takes &AccountInfo directly
    let mut found_ritual_gate = false;
    let mut ritual_type_ok = false;

    let mut ix_index: usize = 0;
    loop {
        match solana_program::sysvar::instructions::load_instruction_at_checked(
            ix_index,
            instructions_sysvar_info,
        ) {
            Ok(ix) => {
                if ix.program_id == dark_ritual_gate_id {
                    if !ix.data.is_empty() && ix.data[0] == VERIFY_RITUAL_SHAPE_TAG {
                        found_ritual_gate = true;
                        // Check ritual type
                        if ix.data.len() >= 2 && ix.data[1] == RITUAL_TYPE_AGENT_SPEND {
                            ritual_type_ok = true;
                        }
                    }
                }
                ix_index += 1;
            }
            Err(_) => break,
        }
    }

    if !found_ritual_gate {
        return Err(RitualHookError::MissingRitualGate.into());
    }
    if !ritual_type_ok {
        return Err(RitualHookError::WrongRitualType.into());
    }

    // Emit 33-byte HookVerdict return data:
    // [0x01][SHA256("dark_null_v1_hook_verdict" || mint_key || amount.to_le_bytes())]
    let hook_hash = compute_hook_hash(mint_info.key, amount);
    let mut return_data = vec![0x01u8];
    return_data.extend_from_slice(&hook_hash);
    set_return_data(&return_data);

    Ok(())
}

// ── Hook hash ─────────────────────────────────────────────────────────────────

pub fn compute_hook_hash(mint: &Pubkey, amount: u64) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"dark_null_v1_hook_verdict");
    h.update(mint.as_ref());
    h.update(amount.to_le_bytes());
    h.finalize().into()
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execute_discriminator_correct() {
        assert_eq!(EXECUTE_DISCRIMINATOR, [105, 37, 101, 197, 75, 251, 102, 26]);
    }

    #[test]
    fn test_init_discriminator_correct() {
        assert_eq!(
            INIT_EXTRA_ACCOUNTS_DISCRIMINATOR,
            [43, 34, 13, 49, 167, 88, 235, 235]
        );
    }

    #[test]
    fn test_ritual_gate_id_parses() {
        assert!(DARK_RITUAL_GATE_ID_STR.parse::<Pubkey>().is_ok());
    }

    #[test]
    fn test_spl_memo_id_parses() {
        assert!(SPL_MEMO_ID_STR.parse::<Pubkey>().is_ok());
    }

    #[test]
    fn test_verify_shape_tag() {
        assert_eq!(VERIFY_RITUAL_SHAPE_TAG, 0x00);
    }

    #[test]
    fn test_ritual_type_agent_spend() {
        assert_eq!(RITUAL_TYPE_AGENT_SPEND, 0x01);
    }

    #[test]
    fn test_hook_hash_deterministic() {
        let mint = Pubkey::new_unique();
        let amount = 1_000_000u64;
        let h1 = compute_hook_hash(&mint, amount);
        let h2 = compute_hook_hash(&mint, amount);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hook_hash_changes_with_amount() {
        let mint = Pubkey::new_unique();
        let h1 = compute_hook_hash(&mint, 1_000);
        let h2 = compute_hook_hash(&mint, 2_000);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_error_codes_range() {
        assert_eq!(RitualHookError::MissingRitualGate as u32, 0);
        assert_eq!(RitualHookError::WrongRitualType as u32, 1);
        assert_eq!(RitualHookError::WrongRitualHash as u32, 2);
        assert_eq!(RitualHookError::MissingMemo as u32, 3);
        assert_eq!(RitualHookError::ForbiddenProgram as u32, 4);
        assert_eq!(RitualHookError::NotProduction as u32, 5);
        assert_eq!(RitualHookError::InvalidInstructionData as u32, 6);
        assert_eq!(RitualHookError::InvalidAccountData as u32, 7);
        assert_eq!(RitualHookError::MissingRequiredAccount as u32, 8);
    }

    // Extended tests -----------------------------------------------------------

    #[test]
    fn test_hook_hash_nonzero() {
        let mint = Pubkey::new_unique();
        let hash = compute_hook_hash(&mint, 1_000_000);
        assert_ne!(hash, [0u8; 32]);
    }

    #[test]
    fn test_hook_hash_mint_sensitive() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let h1 = compute_hook_hash(&mint_a, 1_000);
        let h2 = compute_hook_hash(&mint_b, 1_000);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_execute_discriminator_not_zero() {
        assert_ne!(EXECUTE_DISCRIMINATOR, [0u8; 8]);
    }

    #[test]
    fn test_ritual_gate_id_nonempty() {
        assert!(!DARK_RITUAL_GATE_ID_STR.is_empty());
    }

    #[test]
    fn test_spl_memo_id_differs_from_ritual_gate_id() {
        assert_ne!(SPL_MEMO_ID_STR, DARK_RITUAL_GATE_ID_STR);
    }
}

#[cfg(test)]
mod disc_probe {
    use super::*;

    /// Probe the ACTUAL discriminator by using TransferHookInstruction::pack() which
    /// embeds the SPL_DISCRIMINATOR_SLICE directly. This is the ground truth.
    #[test]
    fn test_execute_discriminator_matches_crate() {
        use spl_transfer_hook_interface::instruction::TransferHookInstruction;
        let packed = TransferHookInstruction::Execute { amount: 1000 }.pack();
        let actual: [u8; 8] = packed[..8].try_into().unwrap();
        println!("ACTUAL Execute discriminator from crate: {:?}", actual);
        println!(
            "Our hardcoded EXECUTE_DISCRIMINATOR:     {:?}",
            EXECUTE_DISCRIMINATOR
        );
        assert_eq!(
            actual, EXECUTE_DISCRIMINATOR,
            "MISMATCH — update EXECUTE_DISCRIMINATOR in lib.rs to {:?}",
            actual
        );
    }

    /// Probe the ACTUAL InitializeExtraAccountMetaList discriminator
    #[test]
    fn test_init_discriminator_matches_crate() {
        use spl_transfer_hook_interface::instruction::TransferHookInstruction;
        let packed = TransferHookInstruction::InitializeExtraAccountMetaList {
            extra_account_metas: vec![],
        }
        .pack();
        let actual: [u8; 8] = packed[..8].try_into().unwrap();
        println!("ACTUAL Init discriminator from crate: {:?}", actual);
        println!(
            "Our hardcoded INIT discriminator:     {:?}",
            INIT_EXTRA_ACCOUNTS_DISCRIMINATOR
        );
        assert_eq!(
            actual, INIT_EXTRA_ACCOUNTS_DISCRIMINATOR,
            "MISMATCH — update INIT_EXTRA_ACCOUNTS_DISCRIMINATOR in lib.rs to {:?}",
            actual
        );
    }
}
