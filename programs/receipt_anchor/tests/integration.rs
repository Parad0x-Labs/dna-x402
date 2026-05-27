#[cfg(not(target_os = "windows"))]
mod program_tests {
    use receipt_anchor::{
        instruction::{FLAG_HAS_BUCKET_ID, INSTRUCTION_VERSION_V1},
        processor::process,
        state::AnchorBucket,
    };
    use solana_program::{
        instruction::{AccountMeta, Instruction},
        program_pack::Pack,
        pubkey::Pubkey,
        system_program,
    };
    use solana_program_test::{processor, ProgramTest};
    use solana_sdk::{signature::Signer, transaction::Transaction};

    const BUCKET_SEED_PREFIX: &[u8] = b"bucket";

    fn program_test(program_id: Pubkey) -> ProgramTest {
        ProgramTest::new("receipt_anchor", program_id, processor!(process))
    }

    fn bucket_pda(program_id: &Pubkey, bucket_id: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[BUCKET_SEED_PREFIX, bucket_id.to_le_bytes().as_ref()],
            program_id,
        )
        .0
    }

    fn single_data(anchor: [u8; 32], bucket_id: u64) -> Vec<u8> {
        let mut data = vec![INSTRUCTION_VERSION_V1, FLAG_HAS_BUCKET_ID];
        data.extend_from_slice(&anchor);
        data.extend_from_slice(&bucket_id.to_le_bytes());
        data
    }

    fn single_ix(
        program_id: Pubkey,
        payer: Pubkey,
        bucket_id: u64,
        anchor: [u8; 32],
    ) -> Instruction {
        Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(payer, true),
                AccountMeta::new(bucket_pda(&program_id, bucket_id), false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: single_data(anchor, bucket_id),
        }
    }

    #[tokio::test]
    async fn anchors_single_receipt_into_explicit_bucket() {
        let program_id = Pubkey::new_unique();
        let bucket_id = 42u64;
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;
        let bucket = bucket_pda(&program_id, bucket_id);
        let ix = single_ix(program_id, payer.pubkey(), bucket_id, [0xA1; 32]);
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        );

        banks_client.process_transaction(tx).await.unwrap();
        let account = banks_client.get_account(bucket).await.unwrap().unwrap();
        let state = AnchorBucket::unpack_from_slice(&account.data).unwrap();

        assert_eq!(account.owner, program_id);
        assert_eq!(state.bucket_id, bucket_id);
        assert_eq!(state.count, 1);
        assert_ne!(state.root, [0u8; 32]);
    }

    #[tokio::test]
    async fn anchors_two_receipts_into_same_bucket() {
        let program_id = Pubkey::new_unique();
        let bucket_id = 77u64;
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;
        let bucket = bucket_pda(&program_id, bucket_id);
        let ix1 = single_ix(program_id, payer.pubkey(), bucket_id, [0x11; 32]);
        let ix2 = single_ix(program_id, payer.pubkey(), bucket_id, [0x22; 32]);
        let tx = Transaction::new_signed_with_payer(
            &[ix1, ix2],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        );

        banks_client.process_transaction(tx).await.unwrap();
        let account = banks_client.get_account(bucket).await.unwrap().unwrap();
        let state = AnchorBucket::unpack_from_slice(&account.data).unwrap();
        assert_eq!(state.count, 2);
    }

    #[tokio::test]
    async fn rejects_wrong_bucket_pda() {
        let program_id = Pubkey::new_unique();
        let bucket_id = 90u64;
        let wrong_bucket = Pubkey::new_unique();
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;
        let ix = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(wrong_bucket, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: single_data([0x33; 32], bucket_id),
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        );
        assert!(banks_client.process_transaction(tx).await.is_err());
    }

    #[tokio::test]
    async fn rejects_missing_payer_signature_flag() {
        let program_id = Pubkey::new_unique();
        let bucket_id = 91u64;
        let (mut banks_client, payer, recent_blockhash) = program_test(program_id).start().await;
        let ix = Instruction {
            program_id,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), false),
                AccountMeta::new(bucket_pda(&program_id, bucket_id), false),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
            data: single_data([0x44; 32], bucket_id),
        };
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_blockhash,
        );
        assert!(banks_client.process_transaction(tx).await.is_err());
    }
}

#[test]
fn single_without_bucket_unpack_roundtrips() {
    use receipt_anchor::instruction::{ReceiptAnchorInstruction, INSTRUCTION_VERSION_V1};
    let mut data = vec![INSTRUCTION_VERSION_V1, 0];
    data.extend_from_slice(&[0xAA; 32]);
    let parsed = ReceiptAnchorInstruction::unpack(&data).unwrap();
    let ReceiptAnchorInstruction::AnchorSingle(single) = parsed else {
        panic!("wrong instruction variant");
    };
    assert_eq!(single.anchor32, [0xAA; 32]);
    assert_eq!(single.bucket_id, None);
}

#[test]
fn single_with_bucket_unpack_roundtrips() {
    use receipt_anchor::instruction::{
        ReceiptAnchorInstruction, FLAG_HAS_BUCKET_ID, INSTRUCTION_VERSION_V1,
    };
    let mut data = vec![INSTRUCTION_VERSION_V1, FLAG_HAS_BUCKET_ID];
    data.extend_from_slice(&[0xAB; 32]);
    data.extend_from_slice(&123u64.to_le_bytes());
    let parsed = ReceiptAnchorInstruction::unpack(&data).unwrap();
    let ReceiptAnchorInstruction::AnchorSingle(single) = parsed else {
        panic!("wrong instruction variant");
    };
    assert_eq!(single.anchor32, [0xAB; 32]);
    assert_eq!(single.bucket_id, Some(123));
}

#[test]
fn single_rejects_bucket_flag_without_bucket_bytes() {
    use receipt_anchor::instruction::{
        ReceiptAnchorInstruction, FLAG_HAS_BUCKET_ID, INSTRUCTION_VERSION_V1,
    };
    let mut data = vec![INSTRUCTION_VERSION_V1, FLAG_HAS_BUCKET_ID];
    data.extend_from_slice(&[0xAA; 32]);
    assert!(ReceiptAnchorInstruction::unpack(&data).is_err());
}

#[test]
fn single_rejects_bucket_bytes_without_flag() {
    use receipt_anchor::instruction::{ReceiptAnchorInstruction, INSTRUCTION_VERSION_V1};
    let mut data = vec![INSTRUCTION_VERSION_V1, 0];
    data.extend_from_slice(&[0xAA; 32]);
    data.extend_from_slice(&1u64.to_le_bytes());
    assert!(ReceiptAnchorInstruction::unpack(&data).is_err());
}

#[test]
fn rejects_invalid_version() {
    use receipt_anchor::instruction::ReceiptAnchorInstruction;
    let mut data = vec![99, 0];
    data.extend_from_slice(&[0xAA; 32]);
    assert!(ReceiptAnchorInstruction::unpack(&data).is_err());
}

#[test]
fn batch_unpack_roundtrips_two_anchors() {
    use receipt_anchor::instruction::{ReceiptAnchorInstruction, INSTRUCTION_VERSION_V1};
    let mut data = vec![INSTRUCTION_VERSION_V1, 2];
    data.extend_from_slice(&[0x01; 32]);
    data.extend_from_slice(&[0x02; 32]);
    let parsed = ReceiptAnchorInstruction::unpack(&data).unwrap();
    let ReceiptAnchorInstruction::AnchorBatch(batch) = parsed else {
        panic!("wrong instruction variant");
    };
    assert_eq!(batch.count, 2);
    assert_eq!(batch.anchors[0], [0x01; 32]);
    assert_eq!(batch.anchors[1], [0x02; 32]);
}

#[test]
fn batch_rejects_count_one() {
    use receipt_anchor::instruction::{ReceiptAnchorInstruction, INSTRUCTION_VERSION_V1};
    let mut data = vec![INSTRUCTION_VERSION_V1, 1];
    data.extend_from_slice(&[0x01; 32]);
    data.extend_from_slice(&[0x02; 32]);
    assert!(ReceiptAnchorInstruction::unpack(&data).is_err());
}

#[test]
fn batch_rejects_count_above_max() {
    use receipt_anchor::instruction::{
        ReceiptAnchorInstruction, INSTRUCTION_VERSION_V1, MAX_BATCH_ANCHORS,
    };
    let mut data = vec![INSTRUCTION_VERSION_V1, MAX_BATCH_ANCHORS as u8 + 1];
    data.extend_from_slice(&[0x01; 32]);
    data.extend_from_slice(&[0x02; 32]);
    assert!(ReceiptAnchorInstruction::unpack(&data).is_err());
}

#[test]
fn batch_rejects_mismatched_length() {
    use receipt_anchor::instruction::{ReceiptAnchorInstruction, INSTRUCTION_VERSION_V1};
    let mut data = vec![INSTRUCTION_VERSION_V1, 2];
    data.extend_from_slice(&[0x01; 32]);
    data.extend_from_slice(&[0x02; 32]);
    data.extend_from_slice(&[0x03; 32]);
    assert!(ReceiptAnchorInstruction::unpack(&data).is_err());
}

#[test]
fn anchor_bucket_pack_unpack_roundtrips() {
    use receipt_anchor::state::{AnchorBucket, ANCHOR_BUCKET_ACCOUNT_LEN, BUCKET_STATE_VERSION};
    use solana_program::program_pack::Pack;
    let state = AnchorBucket {
        version: BUCKET_STATE_VERSION,
        bump: 9,
        bucket_id: 123,
        count: 4,
        root: [0x55; 32],
        updated_at: 1_700_000,
    };
    let mut data = vec![0u8; ANCHOR_BUCKET_ACCOUNT_LEN];
    AnchorBucket::pack_into_slice(&state, &mut data);
    let parsed = AnchorBucket::unpack_from_slice(&data).unwrap();
    assert_eq!(parsed, state);
}

#[test]
fn anchor_bucket_rejects_short_data() {
    use receipt_anchor::state::AnchorBucket;
    use solana_program::program_pack::Pack;
    assert!(AnchorBucket::unpack_from_slice(&[0u8; 10]).is_err());
}

#[test]
fn anchor_bucket_rejects_wrong_version() {
    use receipt_anchor::state::{AnchorBucket, ANCHOR_BUCKET_ACCOUNT_LEN};
    use solana_program::program_pack::Pack;
    let mut data = vec![0u8; ANCHOR_BUCKET_ACCOUNT_LEN];
    data[0] = 7;
    assert!(AnchorBucket::unpack_from_slice(&data).is_err());
}

#[test]
fn anchor_bucket_len_matches_layout() {
    assert_eq!(receipt_anchor::state::ANCHOR_BUCKET_ACCOUNT_LEN, 54);
}

#[test]
fn instruction_lengths_are_stable() {
    use receipt_anchor::instruction::{SINGLE_LEN_NO_BUCKET, SINGLE_LEN_WITH_BUCKET};
    assert_eq!(SINGLE_LEN_NO_BUCKET, 34);
    assert_eq!(SINGLE_LEN_WITH_BUCKET, 42);
}

#[test]
fn max_batch_anchor_limit_is_stable() {
    assert_eq!(receipt_anchor::instruction::MAX_BATCH_ANCHORS, 32);
}

#[test]
fn error_mapping_is_custom_code() {
    let err: solana_program::program_error::ProgramError =
        receipt_anchor::error::ReceiptAnchorError::InvalidBucketPda.into();
    assert_eq!(err, solana_program::program_error::ProgramError::Custom(3));
}
