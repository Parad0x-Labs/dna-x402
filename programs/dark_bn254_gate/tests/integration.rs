// Programs using solana-program-test trigger the rbpf 0.8.x pointer-overflow
// bug on Windows (STATUS_STACK_BUFFER_OVERRUN). These tests are correct and
// pass on Linux/macOS.  The pure logic unit tests in src/ run on all platforms.
// Gate the ProgramTest integration tests off Windows.
#[cfg(not(target_os = "windows"))]
mod tests {
    use dark_bn254_gate::processor::INSTRUCTION_DATA_LEN;
    use solana_program::pubkey::Pubkey;
    use solana_program_test::*;
    use solana_sdk::{
        instruction::{AccountMeta, Instruction},
        signature::Signer,
        transaction::Transaction,
    };

    /// Helper: build the 352-byte instruction data buffer.
    ///
    /// * `proof_prefix` — first two bytes of the 256-byte proof field.
    /// * `merkle_root`  — 32 bytes.
    /// * `nullifier`    — 32 bytes.
    /// * `amount`       — encoded as u64 le, zero-padded to 32 bytes.
    fn build_ix_data(
        proof_prefix: [u8; 2],
        merkle_root: [u8; 32],
        nullifier: [u8; 32],
        amount: u64,
    ) -> Vec<u8> {
        let mut data = vec![0u8; INSTRUCTION_DATA_LEN];

        // proof bytes [0..256]: set prefix, rest stays zero
        data[0] = proof_prefix[0];
        data[1] = proof_prefix[1];

        // merkle_root [256..288]
        data[256..288].copy_from_slice(&merkle_root);

        // nullifier [288..320]
        data[288..320].copy_from_slice(&nullifier);

        // amount_bytes [320..352]: u64 le zero-padded to 32 bytes
        let amount_le = amount.to_le_bytes();
        data[320..328].copy_from_slice(&amount_le);

        data
    }

    fn program_test(program_id: Pubkey) -> ProgramTest {
        ProgramTest::new(
            "dark_bn254_gate",
            program_id,
            processor!(dark_bn254_gate::processor::process_instruction),
        )
    }

    // -----------------------------------------------------------------------
    // Test 1: valid devnet test proof (0xDE 0xAD prefix) is accepted —
    // ONLY when compiled with the `devnet-test` feature. The mainnet artifact
    // (default features) must NOT accept this sentinel; see Test 1b.
    // -----------------------------------------------------------------------
    #[cfg(feature = "devnet-test")]
    #[tokio::test]
    async fn test_valid_test_proof_accepted_with_devnet_feature() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        let ix_data = build_ix_data([0xDE, 0xAD], [1u8; 32], [2u8; 32], 1_000u64);

        let ix = Instruction {
            program_id,
            accounts: vec![AccountMeta::new_readonly(payer.pubkey(), true)],
            data: ix_data,
        };

        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], recent_blockhash);

        let result = banks_client.process_transaction(tx).await;
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);
    }

    // -----------------------------------------------------------------------
    // Test 1b: FAIL-CLOSED REGRESSION. With default features (the mainnet
    // build), the 0xDE 0xAD sentinel must be REJECTED — the bypass is compiled
    // out and the placeholder VK is not mainnet_ready, so no proof passes.
    // -----------------------------------------------------------------------
    #[cfg(not(feature = "devnet-test"))]
    #[tokio::test]
    async fn test_sentinel_rejected_without_devnet_feature() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        let ix_data = build_ix_data([0xDE, 0xAD], [1u8; 32], [2u8; 32], 1_000u64);

        let ix = Instruction {
            program_id,
            accounts: vec![AccountMeta::new_readonly(payer.pubkey(), true)],
            data: ix_data,
        };

        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], recent_blockhash);

        let result = banks_client.process_transaction(tx).await;
        assert!(
            result.is_err(),
            "fail-closed violated: sentinel accepted without devnet-test feature"
        );
    }

    // -----------------------------------------------------------------------
    // Test 2: wrong-length instruction data is rejected
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_wrong_length_rejected() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        // Send only 100 bytes — must be exactly 352.
        let ix_data = vec![0u8; 100];

        let ix = Instruction {
            program_id,
            accounts: vec![AccountMeta::new_readonly(payer.pubkey(), true)],
            data: ix_data,
        };

        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], recent_blockhash);

        let result = banks_client.process_transaction(tx).await;
        assert!(
            result.is_err(),
            "expected Err for wrong-length data, got Ok"
        );
    }

    // -----------------------------------------------------------------------
    // Test 3: proof without the 0xDE 0xAD prefix is rejected
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_invalid_proof_rejected() {
        let program_id = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;

        // proof[0..2] = [0x00, 0x00] — not the devnet test prefix
        let ix_data = build_ix_data([0x00, 0x00], [3u8; 32], [4u8; 32], 500u64);

        let ix = Instruction {
            program_id,
            accounts: vec![AccountMeta::new_readonly(payer.pubkey(), true)],
            data: ix_data,
        };

        let mut tx = Transaction::new_with_payer(&[ix], Some(&payer.pubkey()));
        tx.sign(&[&payer], recent_blockhash);

        let result = banks_client.process_transaction(tx).await;
        assert!(result.is_err(), "expected Err for invalid proof, got Ok");
    }
}

fn build_gate_data(prefix: [u8; 2], root: [u8; 32], nullifier: [u8; 32], amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; dark_bn254_gate::processor::INSTRUCTION_DATA_LEN];
    data[0] = prefix[0];
    data[1] = prefix[1];
    data[256..288].copy_from_slice(&root);
    data[288..320].copy_from_slice(&nullifier);
    data[320..328].copy_from_slice(&amount.to_le_bytes());
    data
}

#[test]
fn test_instruction_data_len_is_exact_abi_width() {
    assert_eq!(dark_bn254_gate::processor::INSTRUCTION_DATA_LEN, 352);
}

#[test]
fn test_gate_record_size_matches_layout() {
    assert_eq!(dark_bn254_gate::state::GATE_RECORD_SIZE, 81);
}

#[test]
fn test_build_gate_data_sets_devnet_prefix() {
    let data = build_gate_data([0xDE, 0xAD], [1u8; 32], [2u8; 32], 7);
    assert_eq!(&data[0..2], &[0xDE, 0xAD]);
}

#[test]
fn test_build_gate_data_places_merkle_root() {
    let root = [0x11u8; 32];
    let data = build_gate_data([0xDE, 0xAD], root, [2u8; 32], 7);
    assert_eq!(&data[256..288], root.as_slice());
}

#[test]
fn test_build_gate_data_places_nullifier() {
    let nullifier = [0x22u8; 32];
    let data = build_gate_data([0xDE, 0xAD], [1u8; 32], nullifier, 7);
    assert_eq!(&data[288..320], nullifier.as_slice());
}

#[test]
fn test_build_gate_data_amount_is_little_endian_u64_prefix() {
    let amount = 0x0102_0304_0506_0708u64;
    let data = build_gate_data([0xDE, 0xAD], [1u8; 32], [2u8; 32], amount);
    assert_eq!(&data[320..328], amount.to_le_bytes().as_slice());
    assert_eq!(&data[328..352], [0u8; 24].as_slice());
}

#[test]
fn test_verification_record_fields_roundtrip_in_memory() {
    let record = dark_bn254_gate::state::VerificationRecord {
        merkle_root: [1u8; 32],
        nullifier: [2u8; 32],
        amount: 42,
        verified_at_slot: 9,
        is_verified: true,
    };
    assert_eq!(record.merkle_root, [1u8; 32]);
    assert_eq!(record.nullifier, [2u8; 32]);
    assert_eq!(record.amount, 42);
    assert_eq!(record.verified_at_slot, 9);
    assert!(record.is_verified);
}

#[test]
fn test_invalid_length_error_maps_to_invalid_instruction_data() {
    let err: solana_program::program_error::ProgramError =
        dark_bn254_gate::error::GateError::InvalidInstructionLength.into();
    assert_eq!(
        err,
        solana_program::program_error::ProgramError::InvalidInstructionData
    );
}

#[test]
fn test_invalid_amount_error_maps_to_invalid_instruction_data() {
    let err: solana_program::program_error::ProgramError =
        dark_bn254_gate::error::GateError::InvalidAmountEncoding.into();
    assert_eq!(
        err,
        solana_program::program_error::ProgramError::InvalidInstructionData
    );
}

#[test]
fn test_failed_proof_error_maps_to_custom_one() {
    let err: solana_program::program_error::ProgramError =
        dark_bn254_gate::error::GateError::ProofVerificationFailed.into();
    assert_eq!(err, solana_program::program_error::ProgramError::Custom(1));
}

#[test]
fn test_gate_error_display_names_length_contract() {
    let text = dark_bn254_gate::error::GateError::InvalidInstructionLength.to_string();
    assert!(text.contains("352 bytes"));
}

#[test]
fn test_gate_error_display_names_pairing_failure() {
    let text = dark_bn254_gate::error::GateError::ProofVerificationFailed.to_string();
    assert!(text.contains("Groth16"));
}

#[test]
fn test_non_devnet_prefix_is_distinct_from_sentinel() {
    let data = build_gate_data([0xDE, 0xAE], [1u8; 32], [2u8; 32], 1);
    assert_ne!(&data[0..2], &[0xDE, 0xAD]);
}
