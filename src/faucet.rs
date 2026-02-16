// PDX $NULL Faucet Contract
// Allows claiming 20 $NULL tokens per wallet per day
// Built on top of Token-2022 program

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{clock::Clock, Sysvar},
    program::invoke,
};

use spl_token_2022::instruction as token_instruction;

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum FaucetInstruction {
    Initialize {
        null_mint: Pubkey,
        daily_limit: u64,  // 20 * 10^decimals
    },
    Claim,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct FaucetState {
    pub null_mint: Pubkey,
    pub authority: Pubkey,
    pub daily_limit: u64,
    pub bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct ClaimRecord {
    pub last_claim_day: u64,
    pub total_claimed: u64,
}

const FAUCET_SEED: &[u8] = b"pdx_faucet";
const CLAIM_SEED: &[u8] = b"pdx_claim";

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = FaucetInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    match instruction {
        FaucetInstruction::Initialize { null_mint, daily_limit } => {
            initialize_faucet(program_id, accounts, null_mint, daily_limit)
        }
        FaucetInstruction::Claim => {
            claim_tokens(program_id, accounts)
        }
    }
}

fn initialize_faucet(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    null_mint: Pubkey,
    daily_limit: u64,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let payer = next_account_info(account_info_iter)?;
    let faucet_pda = next_account_info(account_info_iter)?;
    let null_mint_account = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;

    // Verify payer is signer
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify null mint matches
    if *null_mint_account.key != null_mint {
        msg!("Invalid NULL mint account");
        return Err(ProgramError::InvalidArgument);
    }

    // Create faucet PDA
    let (faucet_address, bump) = Pubkey::find_program_address(&[FAUCET_SEED], program_id);
    if faucet_address != *faucet_pda.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Initialize faucet state
    let faucet_state = FaucetState {
        null_mint,
        authority: *payer.key,
        daily_limit,
        bump,
    };

    // Serialize and store faucet state
    let mut faucet_data = faucet_pda.try_borrow_mut_data()?;
    faucet_state.serialize(&mut &mut faucet_data[..])?;

    msg!("Faucet initialized with daily limit: {}", daily_limit);
    Ok(())
}

fn claim_tokens(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let claimant = next_account_info(account_info_iter)?;
    let claimant_ata = next_account_info(account_info_iter)?;
    let faucet_ata = next_account_info(account_info_iter)?; // Faucet's $NULL ATA (pre-funded)
    let claim_record_pda = next_account_info(account_info_iter)?;
    let null_mint = next_account_info(account_info_iter)?;
    let token_program = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;

    // Verify claimant is signer
    if !claimant.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Get current day
    let clock = Clock::get()?;
    let current_day = clock.unix_timestamp / 86400; // Days since epoch

    // Verify token program is Token-2022
    if *token_program.key != spl_token_2022::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Load or initialize claim record
    let claim_record_data = if claim_record_pda.data_is_empty() {
        // Initialize new claim record
        ClaimRecord {
            last_claim_day: 0,
            total_claimed: 0,
        }
    } else {
        let data = claim_record_pda.try_borrow_data()?;
        ClaimRecord::deserialize(&mut &data[..])?
    };

    // Check daily limit
    if claim_record_data.last_claim_day == current_day {
        msg!("Already claimed today");
        return Err(ProgramError::InvalidArgument);
    }

    // Verify claim record PDA derivation
    let (expected_claim_pda, _) = Pubkey::find_program_address(
        &[CLAIM_SEED, claimant.key.as_ref()],
        program_id
    );
    if expected_claim_pda != *claim_record_pda.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Transfer tokens from faucet ATA to claimant (20 $NULL tokens)
    let claim_amount = 20_000_000; // 20 tokens with 6 decimals

    let transfer_ix = spl_token_2022::instruction::transfer_checked(
        token_program.key,
        faucet_ata.key,      // From faucet's ATA
        null_mint.key,       // Mint
        claimant_ata.key,    // To claimant's ATA
        faucet_ata.key,      // Authority (faucet ATA owner - would be PDA in production)
        &[],
        claim_amount,
        6, // decimals
    )?;

    invoke(
        &transfer_ix,
        &[faucet_ata.clone(), null_mint.clone(), claimant_ata.clone(), token_program.clone()],
    )?;

    // Update claim record
    let updated_record = ClaimRecord {
        last_claim_day: current_day,
        total_claimed: claim_record_data.total_claimed + claim_amount,
    };

    let mut claim_data = claim_record_pda.try_borrow_mut_data()?;
    updated_record.serialize(&mut &mut claim_data[..])?;

    msg!("Claimed 20 $NULL tokens for today");
    Ok(())
}
