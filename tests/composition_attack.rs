#![cfg(feature = "integration-tests")]

/**
 * RED TEAM COMPOSITION ATTACK TEST
 *
 * Demonstrates that Solana allows transaction composition attacks by default.
 * This proves why the TransactionGuard frontend security is CRITICAL.
 *
 * The attack: Bundle a legitimate PDX transfer with a hidden SystemProgram transfer
 * that drains funds to an attacker address.
 */

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_instruction,
};
use solana_program_test::*;
use solana_sdk::{
    signature::{Keypair, Signer},
    transaction::Transaction,
};

// Mock PDX program instruction (replace with your actual program)
const PDX_PROGRAM_ID: &str = "11111111111111111111111111111112";

#[tokio::test]
async fn test_red_team_hidden_instruction_attack() {
    // 1. SETUP THE ENVIRONMENT
    let program_id = Pubkey::new_unique();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "pdx_privacy_program", // Name of your .so file
        program_id,
        processor!(solana_program::system_processor::process), // Use system processor for this test
    )
    .start()
    .await;

    // 2. SETUP ACTORS
    // The "Victim" is the user trying to use the privacy relay
    let victim = Keypair::new();
    // The "Attacker" is where the hidden instruction sends funds
    let attacker = Keypair::new();

    // Fund the victim with 10 SOL so they can be robbed
    let fund_victim_ix = system_instruction::transfer(
        &payer.pubkey(),
        &victim.pubkey(),
        10_000_000_000 // 10 SOL
    );
    let setup_tx = Transaction::new_signed_with_payer(
        &[fund_victim_ix],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );
    banks_client.process_transaction(setup_tx).await.unwrap();

    // Verify victim has funds
    let initial_balance = banks_client.get_balance(victim.pubkey()).await.unwrap();
    assert_eq!(initial_balance, 10_000_000_000);

    // 3. CONSTRUCT THE MALICIOUS TRANSACTION

    // Instruction A: The User's Intended Action (Mock PDX Privacy Transfer)
    let pdx_privacy_ix = Instruction::new_with_borsh(
        program_id,
        &0u8, // Mock instruction variant (deposit/privacy transfer)
        vec![
            AccountMeta::new(victim.pubkey(), true), // Victim as signer
            // Add other accounts your PDX program would need
            // AccountMeta::new_readonly(some_pda, false),
        ],
    );

    // Instruction B: The HIDDEN Attack (Drain 5 SOL to attacker)
    // This is the dangerous part - Solana allows atomic composition!
    let hidden_drain_ix = system_instruction::transfer(
        &victim.pubkey(),
        &attacker.pubkey(),
        5_000_000_000, // 5 SOL theft
    );

    // BUNDLE THEM TOGETHER - This is what phishing sites do!
    let malicious_tx = Transaction::new_signed_with_payer(
        &[pdx_privacy_ix, hidden_drain_ix], // POISONED BUNDLE
        Some(&victim.pubkey()),
        &[&victim],
        recent_blockhash,
    );

    // 4. EXECUTE THE ATTACK
    println!("🚨 RED TEAM: Executing composition attack...");
    let result = banks_client.process_transaction(malicious_tx).await;

    // 5. ASSERTIONS (The Terrifying Truth)

    // The transaction should SUCCEED on-chain because Solana allows composition
    // This proves the blockchain itself cannot protect against these attacks
    assert!(result.is_ok(), "CRITICAL: The blockchain accepted the hidden instruction! Transaction composition attack succeeded!");

    // Verify the victim was successfully drained
    let victim_balance = banks_client.get_balance(victim.pubkey()).await.unwrap();
    let attacker_balance = banks_client.get_balance(attacker.pubkey()).await.unwrap();

    // Victim should have lost 5 SOL (plus any fees)
    assert!(victim_balance < 5_000_000_000, "Victim was successfully drained by hidden instruction");
    assert!(attacker_balance >= 5_000_000_000, "Attacker received the stolen funds");

    println!("🚨 RED TEAM TEST PASSED: Protocol is vulnerable to composition attacks (as expected)");
    println!("💡 This proves TransactionGuard is the CRITICAL frontend security layer!");
    println!("   Without it, ANY phishing site can bundle malicious instructions.");
    println!("   Solana's atomic composition is a double-edged sword.");
}

/**
 * ADDITIONAL RED TEAM TESTS
 */

#[tokio::test]
async fn test_instruction_count_attack() {
    // Test that too many instructions are blocked
    let program_id = Pubkey::new_unique();
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "test_program",
        program_id,
        processor!(solana_program::system_processor::process),
    )
    .start()
    .await;

    let victim = Keypair::new();
    let attacker = Keypair::new();

    // Fund victim
    let fund_ix = system_instruction::transfer(&payer.pubkey(), &victim.pubkey(), 1_000_000_000);
    let setup_tx = Transaction::new_signed_with_payer(&[fund_ix], Some(&payer.pubkey()), &[&payer], recent_blockhash);
    banks_client.process_transaction(setup_tx).await.unwrap();

    // Create transaction with many suspicious instructions
    let mut instructions = vec![];

    // Add many system transfers (suspicious pattern)
    for i in 0..10 {
        let drain_ix = system_instruction::transfer(
            &victim.pubkey(),
            &attacker.pubkey(),
            10_000_000, // Small amounts to avoid attention
        );
        instructions.push(drain_ix);
    }

    let attack_tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&victim.pubkey()),
        &[&victim],
        recent_blockhash,
    );

    let result = banks_client.process_transaction(attack_tx).await;

    // This should succeed on-chain (Solana allows it)
    // But TransactionGuard should block it in the frontend
    assert!(result.is_ok(), "On-chain allows instruction spam attacks");
    println!("🚨 Instruction count attack succeeded on-chain (TransactionGuard should prevent this)");
}

#[tokio::test]
async fn test_unknown_program_attack() {
    // Test that unknown programs are allowed on-chain but blocked by guard
    let (mut banks_client, payer, recent_blockhash) = ProgramTest::new(
        "system_program_test",
        solana_program::system_program::id(),
        processor!(solana_program::system_processor::process),
    )
    .start()
    .await;

    let victim = Keypair::new();
    let attacker = Keypair::new();

    // Fund victim
    let fund_ix = system_instruction::transfer(&payer.pubkey(), &victim.pubkey(), 1_000_000_000);
    let setup_tx = Transaction::new_signed_with_payer(&[fund_ix], Some(&payer.pubkey()), &[&payer], recent_blockhash);
    banks_client.process_transaction(setup_tx).await.unwrap();

    // Create instruction calling unknown program
    let unknown_program = Pubkey::new_unique();
    let suspicious_ix = Instruction::new_with_borsh(
        unknown_program,
        &0u8,
        vec![
            AccountMeta::new(victim.pubkey(), true),
            AccountMeta::new(attacker.pubkey(), false),
        ],
    );

    let attack_tx = Transaction::new_signed_with_payer(
        &[suspicious_ix],
        Some(&victim.pubkey()),
        &[&victim],
        recent_blockhash,
    );

    let result = banks_client.process_transaction(attack_tx).await;

    // Should fail because unknown program doesn't exist
    // But demonstrates that unknown programs could be dangerous if they existed
    assert!(result.is_err(), "Unknown program correctly rejected");
    println!("✅ Unknown program attack correctly failed (as expected)");
}

/*
RUNNING THESE TESTS:

cargo test test_red_team_hidden_instruction_attack -- --nocapture

This will show:
- How Solana allows dangerous transaction composition
- Why frontend TransactionGuard is absolutely essential
- The attack patterns phishing sites could use

KEY LESSON: The blockchain cannot protect against composition attacks.
Only the frontend security layer can prevent these exploits.
*/
