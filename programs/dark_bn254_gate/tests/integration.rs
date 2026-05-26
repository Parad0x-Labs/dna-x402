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
    // Test 1: valid devnet test proof (0xDE 0xAD prefix) is accepted
    // -----------------------------------------------------------------------
    #[tokio::test]
    async fn test_valid_test_proof_accepted() {
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
