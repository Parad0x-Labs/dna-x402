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

use crate::{
    error::NullifierRecordError,
    instruction::parse_record_nullifier,
    state::{NullifierRecord, NULLIFIER_RECORD_SIZE},
};

/// PDA seed prefix.
const SEED_PREFIX: &[u8] = b"null_record";

/// Format the first 8 bytes of a nullifier as a lowercase hex string.
/// Returns a 16-byte ASCII array — no heap allocation needed.
fn hex8(bytes: &[u8; 8]) -> [u8; 16] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 16];
    for (i, &b) in bytes.iter().enumerate() {
        out[i * 2] = HEX[(b >> 4) as usize];
        out[i * 2 + 1] = HEX[(b & 0x0f) as usize];
    }
    out
}

/// Main program entrypoint dispatched from `lib.rs`.
///
/// # Accounts
/// | # | Name                  | Writable | Signer |
/// |---|----------------------|----------|--------|
/// | 0 | `payer`              | yes      | yes    |
/// | 1 | `nullifier_record_pda` | yes    | no     |
/// | 2 | `system_program`     | no       | no     |
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // -----------------------------------------------------------------------
    // 1. Parse instruction data.
    // -----------------------------------------------------------------------
    let nullifier =
        parse_record_nullifier(data).ok_or(NullifierRecordError::InvalidInstructionData)?;

    // -----------------------------------------------------------------------
    // 2. Reject all-zero nullifiers — they are never a valid spent proof.
    // -----------------------------------------------------------------------
    if nullifier == [0u8; 32] {
        return Err(NullifierRecordError::InvalidNullifier.into());
    }

    // -----------------------------------------------------------------------
    // 3. Parse accounts.
    // -----------------------------------------------------------------------
    let accounts_iter = &mut accounts.iter();
    let payer = next_account_info(accounts_iter)?;
    let record_pda = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // -----------------------------------------------------------------------
    // 4. Derive the PDA — seed: [b"null_record", nullifier (full 32 bytes)].
    //    The full nullifier is the seed (32 bytes = the max single-seed length),
    //    so every distinct nullifier maps to a unique PDA. A prefix seed would
    //    let two different nullifiers collide and falsely trip AlreadyRecorded.
    // -----------------------------------------------------------------------
    let null_seed = &nullifier[..];
    let seeds: &[&[u8]] = &[SEED_PREFIX, null_seed];
    let (derived_pda, bump) = Pubkey::find_program_address(seeds, program_id);

    if derived_pda != *record_pda.key {
        return Err(ProgramError::InvalidArgument);
    }

    // -----------------------------------------------------------------------
    // 5. Idempotency / double-spend guard.
    //    If the account already holds data the nullifier is already recorded.
    // -----------------------------------------------------------------------
    if record_pda.data_len() > 0 {
        return Err(NullifierRecordError::AlreadyRecorded.into());
    }

    // -----------------------------------------------------------------------
    // 6. Allocate and fund the PDA via the System Program.
    // -----------------------------------------------------------------------
    let rent = Rent::get()?;
    let lamports_needed = rent.minimum_balance(NULLIFIER_RECORD_SIZE);

    let bump_seed = [bump];
    let signer_seeds: &[&[u8]] = &[SEED_PREFIX, null_seed, &bump_seed];

    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            record_pda.key,
            lamports_needed,
            NULLIFIER_RECORD_SIZE as u64,
            program_id,
        ),
        &[payer.clone(), record_pda.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    // -----------------------------------------------------------------------
    // 7. Write the record into the freshly created PDA.
    // -----------------------------------------------------------------------
    let slot = Clock::get()?.slot;
    let record = NullifierRecord {
        bump,
        nullifier,
        recorded_at_slot: slot,
    };

    record_pda
        .try_borrow_mut_data()?
        .copy_from_slice(&record.to_bytes());

    // -----------------------------------------------------------------------
    // 8. Emit an on-chain log (first 8 bytes of nullifier as hex).
    // -----------------------------------------------------------------------
    let prefix_bytes: [u8; 8] = nullifier[0..8].try_into().unwrap();
    let hex_prefix = hex8(&prefix_bytes);
    // SAFETY: hex8 emits only ASCII bytes.
    let prefix_str = core::str::from_utf8(&hex_prefix).unwrap_or("?");
    msg!("dark_nullifier_record: recorded {}", prefix_str);

    Ok(())
}
