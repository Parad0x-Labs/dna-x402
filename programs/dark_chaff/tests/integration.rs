// Programs using invoke_signed trigger the rbpf 0.8.3 pointer-overflow bug on
// Windows (STATUS_STACK_BUFFER_OVERRUN in solBankForksCli). These tests are
// correct and pass on Linux/macOS. The pure logic tests at the bottom run on
// all platforms.
use dark_chaff::{BATCH_SEED, INTENT_SEED};

// ── Platform-gated ProgramTest integration tests ──────────────────────────────
#[cfg(not(target_os = "windows"))]
mod program_tests {
    use dark_chaff::{processor::process, BATCH_SEED, INTENT_SEED};
    use solana_program::{
        clock::Clock,
        instruction::{AccountMeta, Instruction},
        pubkey::Pubkey,
        system_program,
    };
    use solana_program_test::{processor, ProgramTest, ProgramTestContext};
    use solana_sdk::{signature::Signer, transaction::Transaction};

    fn make_pt(id: Pubkey) -> ProgramTest {
        ProgramTest::new("dark_chaff", id, processor!(process))
    }

    fn batch_pda(program_id: &Pubkey, payer: &Pubkey, epoch: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[BATCH_SEED, payer.as_ref(), &epoch.to_le_bytes()],
            program_id,
        )
    }

    fn intent_pda(program_id: &Pubkey, epoch: u64, idx: u8) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[INTENT_SEED, &epoch.to_le_bytes(), &[idx]], program_id)
    }

    fn create_ix(
        program_id: &Pubkey,
        payer: &Pubkey,
        count: u8,
        epoch: u64,
    ) -> (Instruction, Pubkey) {
        let (bpda, _) = batch_pda(program_id, payer, epoch);
        let mut data = vec![0x00u8, count];
        data.extend_from_slice(&epoch.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(bpda, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ];
        for idx in 0..count {
            let (ipda, _) = intent_pda(program_id, epoch, idx);
            accounts.push(AccountMeta::new(ipda, false));
        }
        (
            Instruction {
                program_id: *program_id,
                accounts,
                data,
            },
            bpda,
        )
    }

    fn close_ix(program_id: &Pubkey, payer: &Pubkey, epoch: u64, count: u8) -> Instruction {
        let (bpda, _) = batch_pda(program_id, payer, epoch);
        let mut data = vec![0x01u8];
        data.extend_from_slice(&epoch.to_le_bytes());
        let mut accounts = vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(bpda, false),
        ];
        for idx in 0..count {
            let (ipda, _) = intent_pda(program_id, epoch, idx);
            accounts.push(AccountMeta::new(ipda, false));
        }
        Instruction {
            program_id: *program_id,
            accounts,
            data,
        }
    }

    async fn set_clock(ctx: &mut ProgramTestContext, unix_ts: i64) {
        let mut clock = Clock::default();
        clock.unix_timestamp = unix_ts;
        ctx.set_sysvar(&clock);
    }

    #[tokio::test]
    async fn test_create_close_roundtrip() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;

        let payer = ctx.payer.insecure_clone();
        let epoch = 0u64;
        let count = 3u8;
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();

        let (create, bpda) = create_ix(&id, &payer.pubkey(), count, epoch);
        let tx =
            Transaction::new_signed_with_payer(&[create], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let bacc = ctx.banks_client.get_account(bpda).await.unwrap().unwrap();
        assert_eq!(bacc.owner, id);

        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let close = close_ix(&id, &payer.pubkey(), epoch, count);
        let tx2 =
            Transaction::new_signed_with_payer(&[close], Some(&payer.pubkey()), &[&payer], bh2);
        ctx.banks_client.process_transaction(tx2).await.unwrap();

        let gone = ctx.banks_client.get_account(bpda).await.unwrap();
        assert!(
            gone.is_none() || gone.unwrap().lamports == 0,
            "batch PDA must be closed"
        );
    }

    #[tokio::test]
    async fn test_cannot_close_future_epoch() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;

        let payer = ctx.payer.insecure_clone();
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (create, _) = create_ix(&id, &payer.pubkey(), 3u8, 0);
        let tx1 =
            Transaction::new_signed_with_payer(&[create], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx1).await.unwrap();

        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let close = close_ix(&id, &payer.pubkey(), 1, 3);
        let tx2 =
            Transaction::new_signed_with_payer(&[close], Some(&payer.pubkey()), &[&payer], bh2);
        assert!(
            ctx.banks_client.process_transaction(tx2).await.is_err(),
            "closing a future epoch must fail"
        );
    }

    #[tokio::test]
    async fn test_count_range() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;
        let payer = ctx.payer.insecure_clone();

        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (bad_ix, _) = create_ix(&id, &payer.pubkey(), 2u8, 0);
        let tx =
            Transaction::new_signed_with_payer(&[bad_ix], Some(&payer.pubkey()), &[&payer], bh);
        assert!(
            ctx.banks_client.process_transaction(tx).await.is_err(),
            "count=2 must fail"
        );

        let bh2 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (bad_ix2, _) = create_ix(&id, &payer.pubkey(), 8u8, 1);
        let tx2 =
            Transaction::new_signed_with_payer(&[bad_ix2], Some(&payer.pubkey()), &[&payer], bh2);
        assert!(
            ctx.banks_client.process_transaction(tx2).await.is_err(),
            "count=8 must fail"
        );

        let bh3 = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (ok_ix, _) = create_ix(&id, &payer.pubkey(), 7u8, 2);
        let tx3 =
            Transaction::new_signed_with_payer(&[ok_ix], Some(&payer.pubkey()), &[&payer], bh3);
        ctx.banks_client.process_transaction(tx3).await.unwrap();
    }

    #[tokio::test]
    async fn test_lamport_cost_benchmark() {
        let id = Pubkey::new_unique();
        let mut ctx = make_pt(id).start_with_context().await;
        set_clock(&mut ctx, 0).await;
        let payer = ctx.payer.insecure_clone();

        let before = ctx.banks_client.get_balance(payer.pubkey()).await.unwrap();
        let bh = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let (ix, _) = create_ix(&id, &payer.pubkey(), 7u8, 0);
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
        ctx.banks_client.process_transaction(tx).await.unwrap();

        let after = ctx.banks_client.get_balance(payer.pubkey()).await.unwrap();
        let cost = before.saturating_sub(after);
        assert!(
            cost < 10_000_000,
            "cost {cost} lamports exceeds 0.01 SOL (10M lamports)"
        );
    }
}

// ── Pure-logic unit tests (all platforms) ─────────────────────────────────────

#[test]
fn test_instruction_encoding_create_chaff_batch() {
    use dark_chaff::instruction::ChaffInstruction;
    let count = 5u8;
    let epoch = 42u64;
    let mut data = vec![0x00u8, count];
    data.extend_from_slice(&epoch.to_le_bytes());
    let ix = ChaffInstruction::unpack(&data).unwrap();
    match ix {
        ChaffInstruction::CreateChaffBatch { count: c, epoch: e } => {
            assert_eq!(c, count);
            assert_eq!(e, epoch);
        }
        _ => panic!("wrong instruction variant"),
    }
}

#[test]
fn test_instruction_encoding_close_chaff_batch() {
    use dark_chaff::instruction::ChaffInstruction;
    let epoch = 99u64;
    let mut data = vec![0x01u8];
    data.extend_from_slice(&epoch.to_le_bytes());
    let ix = ChaffInstruction::unpack(&data).unwrap();
    match ix {
        ChaffInstruction::CloseChaffBatch { epoch: e } => assert_eq!(e, epoch),
        _ => panic!("wrong instruction variant"),
    }
}

#[test]
fn test_instruction_unknown_tag_rejected() {
    use dark_chaff::instruction::ChaffInstruction;
    assert!(ChaffInstruction::unpack(&[0xFFu8]).is_err());
}

#[test]
fn test_instruction_empty_rejected() {
    use dark_chaff::instruction::ChaffInstruction;
    assert!(ChaffInstruction::unpack(&[]).is_err());
}

#[test]
fn test_instruction_truncated_create_rejected() {
    use dark_chaff::instruction::ChaffInstruction;
    // Create needs 10 bytes; provide 5
    assert!(ChaffInstruction::unpack(&[0x00u8, 3, 0, 0, 0]).is_err());
}

#[test]
fn test_instruction_truncated_close_rejected() {
    use dark_chaff::instruction::ChaffInstruction;
    // Close needs 9 bytes; provide 4
    assert!(ChaffInstruction::unpack(&[0x01u8, 0, 0, 0]).is_err());
}

#[test]
fn test_state_pack_unpack_roundtrip() {
    use dark_chaff::state::{ChaffBatch, BATCH_VERSION, CHAFF_BATCH_LEN};

    let original = ChaffBatch {
        version: BATCH_VERSION,
        bump: 200,
        count: 5,
        epoch: 12345u64,
        payer: [0x77u8; 32],
        created_at: 1_700_000_001,
    };
    let mut buf = vec![0u8; CHAFF_BATCH_LEN];
    original.pack_into(&mut buf);
    let unpacked = ChaffBatch::unpack(&buf).unwrap();

    assert_eq!(unpacked.version, original.version);
    assert_eq!(unpacked.bump, original.bump);
    assert_eq!(unpacked.count, original.count);
    assert_eq!(unpacked.epoch, original.epoch);
    assert_eq!(unpacked.payer, original.payer);
    assert_eq!(unpacked.created_at, original.created_at);
}

#[test]
fn test_state_wrong_version_rejected() {
    use dark_chaff::state::{ChaffBatch, CHAFF_BATCH_LEN};
    let mut buf = vec![0u8; CHAFF_BATCH_LEN];
    buf[0] = 0xFF; // invalid version
    assert!(ChaffBatch::unpack(&buf).is_none());
}

#[test]
fn test_state_short_slice_rejected() {
    use dark_chaff::state::ChaffBatch;
    assert!(ChaffBatch::unpack(&[]).is_none());
    assert!(ChaffBatch::unpack(&[1u8; 10]).is_none());
}

#[test]
fn test_chaff_constants() {
    use dark_chaff::state::{EPOCH_SECONDS, MAX_CHAFF, MIN_CHAFF};
    assert_eq!(MIN_CHAFF, 3);
    assert_eq!(MAX_CHAFF, 7);
    assert_eq!(EPOCH_SECONDS, 3600);
    assert_ne!(BATCH_SEED, INTENT_SEED);
}

#[test]
fn test_chaff_batch_len_matches_layout() {
    use dark_chaff::state::CHAFF_BATCH_LEN;
    // version(1) + bump(1) + count(1) + epoch(8) + payer(32) + created_at(8) = 51
    assert_eq!(CHAFF_BATCH_LEN, 51);
}

#[test]
fn test_chaff_intent_len_matches_layout() {
    use dark_chaff::state::CHAFF_INTENT_LEN;
    assert_eq!(CHAFF_INTENT_LEN, 18);
}
