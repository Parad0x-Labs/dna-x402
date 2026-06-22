//! Held-out test for the self-payment-Sybil fix in settle_and_record (0x02).
//! Proves: paying yourself (recipient == payer) is rejected with Custom(24), while a
//! settle to a genuinely distinct recipient still records. The caller-supplied counterparty
//! bytes are ignored — the leaf binds counterparty := recipient.key.
use receipt_commitment_tree::process_instruction;
use solana_program_test::{processor, BanksClient, ProgramTest};
use solana_sdk::{
    hash::Hash,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::{Transaction, TransactionError},
};

const TREE_SEED: &[u8] = b"receipt_tree";

fn init_data(tree_id: &[u8; 8]) -> Vec<u8> {
    let mut d = vec![0x00u8];
    d.extend_from_slice(tree_id);
    d
}
fn settle_data(tree_id: &[u8; 8], agent: &[u8; 32], amount: u64, nonce: &[u8; 32]) -> Vec<u8> {
    let mut d = vec![0x02u8];
    d.extend_from_slice(tree_id);
    d.extend_from_slice(agent);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&[7u8; 32]); // caller-supplied counterparty — MUST be ignored now
    d.extend_from_slice(nonce);
    d
}

async fn setup() -> (BanksClient, Keypair, Hash, Pubkey, [u8; 8], Pubkey) {
    let program_id = Pubkey::new_unique();
    let pt = ProgramTest::new("receipt_commitment_tree", program_id, processor!(process_instruction));
    let (mut banks, payer, recent) = pt.start().await;
    let tree_id = [1u8; 8];
    let (tree_pda, _b) = Pubkey::find_program_address(&[TREE_SEED, &tree_id], &program_id);
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(tree_pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: init_data(&tree_id),
    };
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], recent);
    banks.process_transaction(tx).await.expect("tree init should succeed");
    (banks, payer, recent, program_id, tree_id, tree_pda)
}

#[tokio::test]
async fn self_payment_is_rejected() {
    let (mut banks, payer, _recent, program_id, tree_id, tree_pda) = setup().await;
    let bh = banks.get_latest_blockhash().await.unwrap();
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(payer.pubkey(), false), // recipient == payer
            AccountMeta::new(tree_pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: settle_data(&tree_id, &[9u8; 32], 1_000_000, &[3u8; 32]),
    };
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], bh);
    let err = banks.process_transaction(tx).await.unwrap_err();
    match err.unwrap() {
        TransactionError::InstructionError(_, InstructionError::Custom(24)) => {}
        other => panic!("expected Custom(24) SelfPayment, got {other:?}"),
    }
}

#[tokio::test]
async fn distinct_recipient_is_recorded() {
    let (mut banks, payer, _recent, program_id, tree_id, tree_pda) = setup().await;
    let recipient = Pubkey::new_unique(); // genuinely distinct counterparty
    let bh = banks.get_latest_blockhash().await.unwrap();
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(recipient, false),
            AccountMeta::new(tree_pda, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: settle_data(&tree_id, &[9u8; 32], 1_000_000, &[3u8; 32]),
    };
    let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
    tx.sign(&[&payer], bh);
    banks
        .process_transaction(tx)
        .await
        .expect("settle to a distinct recipient should succeed");
}
