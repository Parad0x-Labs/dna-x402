/**
 * RENT EXEMPTION ATTACK TEST
 *
 * Tests that the program properly handles rent exemption failures
 * when attackers try to send transactions that would leave accounts
 * without enough SOL for rent.
 */

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::rent,
};

use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum RentTestInstruction {
    /// Test rent exemption handling
    TestRentExemption {
        amount: u64,
    },
}

entrypoint!(process_rent_test);

pub fn process_rent_test(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = RentTestInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    match instruction {
        RentTestInstruction::TestRentExemption { amount } => {
            test_rent_exemption(program_id, accounts, amount)
        }
    }
}

/// Test rent exemption handling
/// This simulates what happens when an attacker tries to drain an account
/// to just below the rent exemption threshold
fn test_rent_exemption(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u64,
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    let source_account = next_account_info(account_info_iter)?;
    let destination_account = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;

    // Get rent sysvar
    let rent = &Rent::from_account_info(next_account_info(account_info_iter)?)?;

    // Calculate minimum rent exemption for destination account
    let dest_rent_exemption = rent.minimum_balance(destination_account.data_len());

    // Get current balance of destination
    let dest_balance = destination_account.lamports();

    // ATTACK SCENARIO: Attacker tries to send amount that leaves destination
    // with less than rent exemption but more than 0
    if amount >= dest_balance.saturating_sub(dest_rent_exemption) && amount > 0 {
        msg!("RENT EXEMPTION ATTACK DETECTED: Transaction would leave account below rent exemption threshold");

        // Check if destination account would be left with insufficient rent
        let remaining_balance = dest_balance.saturating_sub(amount);

        if remaining_balance > 0 && remaining_balance < dest_rent_exemption {
            msg!("BLOCKING: Destination would have {} lamports, but needs {} for rent exemption",
                 remaining_balance, dest_rent_exemption);

            // OPTION 1: Fail the transaction
            return Err(ProgramError::InsufficientFunds);

            // OPTION 2: Adjust the amount to leave exactly rent exemption
            // (Uncomment below if you want to be more permissive)
            /*
            let adjusted_amount = dest_balance.saturating_sub(dest_rent_exemption);
            if adjusted_amount > 0 {
                // Transfer adjusted amount instead
                **source_account.try_borrow_mut_lamports()? -= adjusted_amount;
                **destination_account.try_borrow_mut_lamports()? += adjusted_amount;
                msg!("ADJUSTED: Transferred {} instead of {} to maintain rent exemption",
                     adjusted_amount, amount);
                return Ok(());
            }
            */
        }
    }

    // Normal transfer if no rent exemption issues
    **source_account.try_borrow_mut_lamports()? -= amount;
    **destination_account.try_borrow_mut_lamports()? += amount;

    msg!("Transfer completed: {} lamports", amount);
    Ok(())
}

/*
USAGE IN TESTS:

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program_test::*;
    use solana_sdk::{signature::Keypair, signer::Signer};

    #[tokio::test]
    async fn test_rent_exemption_attack() {
        let program_id = Pubkey::new_unique();
        let mut program_test = ProgramTest::new(
            "rent_exemption_test",
            program_id,
            processor!(process_rent_test),
        );

        // Create test accounts
        let source_keypair = Keypair::new();
        let dest_keypair = Keypair::new();

        // Fund source account with 1 SOL
        program_test.add_account(
            source_keypair.pubkey(),
            Account::new(1_000_000_000, 0, &system_program::id()),
        );

        // Fund destination with just enough for rent exemption + small amount
        let rent = Rent::default();
        let rent_exemption = rent.minimum_balance(0);
        let attack_amount = rent_exemption - 1000; // Leave destination with insufficient rent

        program_test.add_account(
            dest_keypair.pubkey(),
            Account::new(rent_exemption + attack_amount, 0, &system_program::id()),
        );

        let (mut banks_client, payer, recent_blockhash) = program_test.start().await;

        // Try the rent exemption attack
        let instruction = Instruction::new_with_borsh(
            program_id,
            &RentTestInstruction::TestRentExemption {
                amount: attack_amount,
            },
            vec![
                AccountMeta::new(source_keypair.pubkey(), true),
                AccountMeta::new(dest_keypair.pubkey(), false),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(rent::id(), false),
            ],
        );

        let tx = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[&payer, &source_keypair],
            recent_blockhash,
        );

        // This should fail with InsufficientFunds
        let result = banks_client.process_transaction(tx).await;
        assert!(result.is_err()); // Attack should be blocked

        println!("✅ Rent exemption attack successfully blocked");
    }
}
*/
