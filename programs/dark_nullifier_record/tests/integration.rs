// Programs using solana-program-test trigger the rbpf 0.8.x pointer-overflow
// bug on Windows (STATUS_STACK_BUFFER_OVERRUN). These tests are correct and
// pass on Linux/macOS CI. The pure logic unit tests in src/ run on all
// platforms. Gate the ProgramTest integration tests off Windows.
#[cfg(not(target_os = "windows"))]
mod tests {
    use dark_nullifier_record::{
        instruction::record_nullifier_ix_data,
        processor,
        state::{NullifierRecord, NULLIFIER_RECORD_SIZE},
    };
    use solana_program::pubkey::Pubkey;
    use solana_program_test::*;
    use solana_sdk::{
        instruction::{AccountMeta, Instruction},
        signature::Signer,
        transaction::Transaction,
    };

    /// PDA seed prefix — mirrors the value in processor.rs.
    const SEED_PREFIX: &[u8] = b"null_record";

    /// Derive the expected PDA address for the given nullifier.
    fn derive_pda(program_id: &Pubkey, nullifier: &[u8; 32]) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[SEED_PREFIX, &nullifier[0..8]], program_id)
    }

    fn program_test(program_id: Pubkey) -> ProgramTest {
        ProgramTest::new(
            "dark_nullifier_record",
            program_id,
            processor!(processor::process_instruction),
        )
    }

    // -----------------------------------------------------------------------
    // Test 1: happy path — record a valid nullifier
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_record_nullifier_happy_path() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        let nullifier = [0xAB_u8; 32]; // non-zero, unique nullifier
        let (pda, _bump) = derive_pda(&program_id, &nullifier);

        let ix = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(pda, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
            data: record_nullifier_ix_data(nullifier),
        };

        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], recent_blockhash);

        let result = banks_client.process_transaction(tx).await;
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        // Verify the PDA was created with correct content.
        let account = banks_client
            .get_account(pda)
            .await
            .expect("RPC failed")
            .expect("PDA account must exist after recording");

        assert_eq!(
            account.data.len(),
            NULLIFIER_RECORD_SIZE,
            "PDA data length should be NULLIFIER_RECORD_SIZE"
        );
        assert!(
            NullifierRecord::is_recorded(&account.data),
            "is_recorded should return true for a live record"
        );

        let record = NullifierRecord::from_bytes(&account.data)
            .expect("from_bytes must succeed on a valid record");
        assert_eq!(record.nullifier, nullifier, "stored nullifier must match");
    }

    // -----------------------------------------------------------------------
    // Test 2: all-zeros nullifier is rejected with Custom(11)
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_all_zeros_nullifier_rejected() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        let nullifier = [0u8; 32];
        let (pda, _bump) = derive_pda(&program_id, &nullifier);

        let ix = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(pda, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
            data: record_nullifier_ix_data(nullifier),
        };

        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], recent_blockhash);

        let result = banks_client.process_transaction(tx).await;
        assert!(
            result.is_err(),
            "expected Err for all-zero nullifier, got Ok"
        );

        // Confirm the error code is Custom(11) — InvalidNullifier.
        let err_str = format!("{:?}", result);
        assert!(
            err_str.contains("Custom(11)"),
            "expected Custom(11) in error, got: {}",
            err_str
        );
    }

    // -----------------------------------------------------------------------
    // Test 3: double-record is rejected with Custom(10)
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_double_record_rejected() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        let nullifier = [0xCC_u8; 32];
        let (pda, _bump) = derive_pda(&program_id, &nullifier);

        let build_ix = || Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(pda, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
            ],
            data: record_nullifier_ix_data(nullifier),
        };

        // First transaction — must succeed.
        let mut tx1 = Transaction::new_with_payer(&[build_ix()], Some(&payer.pubkey()));
        tx1.sign(&[&payer], recent_blockhash);
        banks_client
            .process_transaction(tx1)
            .await
            .expect("first record should succeed");

        // Second transaction — must fail with Custom(10) AlreadyRecorded.
        let recent_blockhash2 = banks_client.get_latest_blockhash().await.unwrap();
        let mut tx2 = Transaction::new_with_payer(&[build_ix()], Some(&payer.pubkey()));
        tx2.sign(&[&payer], recent_blockhash2);
        let result = banks_client.process_transaction(tx2).await;

        assert!(
            result.is_err(),
            "expected Err for duplicate nullifier, got Ok"
        );

        let err_str = format!("{:?}", result);
        assert!(
            err_str.contains("Custom(10)"),
            "expected Custom(10) in error, got: {}",
            err_str
        );
    }
}

#[test]
fn test_record_instruction_builder_has_fixed_length() {
    let data = dark_nullifier_record::instruction::record_nullifier_ix_data([1u8; 32]);
    assert_eq!(
        data.len(),
        dark_nullifier_record::instruction::RECORD_NULLIFIER_IX_LEN
    );
}

#[test]
fn test_record_instruction_builder_sets_discriminator() {
    let data = dark_nullifier_record::instruction::record_nullifier_ix_data([1u8; 32]);
    assert_eq!(
        data[0],
        dark_nullifier_record::instruction::RECORD_NULLIFIER_DISCRIMINATOR
    );
}

#[test]
fn test_record_instruction_parser_roundtrip() {
    let nullifier = [0x55u8; 32];
    let data = dark_nullifier_record::instruction::record_nullifier_ix_data(nullifier);
    assert_eq!(
        dark_nullifier_record::instruction::parse_record_nullifier(&data),
        Some(nullifier)
    );
}

#[test]
fn test_record_instruction_parser_rejects_empty() {
    assert_eq!(
        dark_nullifier_record::instruction::parse_record_nullifier(&[]),
        None
    );
}

#[test]
fn test_record_instruction_parser_rejects_short_data() {
    assert_eq!(
        dark_nullifier_record::instruction::parse_record_nullifier(&[0u8; 32]),
        None
    );
}

#[test]
fn test_record_instruction_parser_rejects_long_data() {
    assert_eq!(
        dark_nullifier_record::instruction::parse_record_nullifier(&[0u8; 34]),
        None
    );
}

#[test]
fn test_record_instruction_parser_rejects_bad_discriminator() {
    let mut data = dark_nullifier_record::instruction::record_nullifier_ix_data([1u8; 32]);
    data[0] = 0xFF;
    assert_eq!(
        dark_nullifier_record::instruction::parse_record_nullifier(&data),
        None
    );
}

#[test]
fn test_nullifier_record_size_matches_layout() {
    assert_eq!(dark_nullifier_record::state::NULLIFIER_RECORD_SIZE, 41);
}

#[test]
fn test_nullifier_record_roundtrip() {
    let record = dark_nullifier_record::state::NullifierRecord {
        bump: 201,
        nullifier: [0xABu8; 32],
        recorded_at_slot: 1234,
    };
    let bytes = record.to_bytes();
    let parsed = dark_nullifier_record::state::NullifierRecord::from_bytes(&bytes).unwrap();
    assert_eq!(parsed.bump, record.bump);
    assert_eq!(parsed.nullifier, record.nullifier);
    assert_eq!(parsed.recorded_at_slot, record.recorded_at_slot);
}

#[test]
fn test_nullifier_record_from_short_slice_rejected() {
    assert!(dark_nullifier_record::state::NullifierRecord::from_bytes(&[0u8; 40]).is_none());
}

#[test]
fn test_nullifier_record_is_recorded_rejects_wrong_length() {
    assert!(!dark_nullifier_record::state::NullifierRecord::is_recorded(
        &[1u8; 40]
    ));
}

#[test]
fn test_nullifier_record_is_recorded_rejects_zero_record() {
    assert!(!dark_nullifier_record::state::NullifierRecord::is_recorded(
        &[0u8; 41]
    ));
}

#[test]
fn test_nullifier_record_is_recorded_accepts_nonzero_record() {
    let record = dark_nullifier_record::state::NullifierRecord {
        bump: 1,
        nullifier: [1u8; 32],
        recorded_at_slot: 2,
    };
    assert!(dark_nullifier_record::state::NullifierRecord::is_recorded(
        &record.to_bytes()
    ));
}
